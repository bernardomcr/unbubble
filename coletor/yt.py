"""Acesso ao YouTube: API oficial, RSS dos canais e teste de Shorts.

Só usa a biblioteca padrão do Python (nada para instalar).
A chave da API vem da variável de ambiente YT_API_KEY (segredo do GitHub).
"""
import http.client
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

API = "https://www.googleapis.com/youtube/v3/"
UA = {"User-Agent": "Mozilla/5.0 (unbubble coletor)"}


class Cota:
    """Conta o gasto do dia: buscas (bucket de 100) e unidades (bucket de 10.000)."""

    def __init__(self):
        self.buscas = 0
        self.unidades = 0


cota = Cota()


def _chave():
    chave = os.environ.get("YT_API_KEY", "").strip()
    if not chave:
        raise SystemExit("Faltou a chave: defina o segredo YT_API_KEY no GitHub.")
    return chave


def api(metodo, **params):
    """Chama um método da API. Nunca imprime a URL (ela contém a chave)."""
    params = {k: v for k, v in params.items() if v is not None}
    params["key"] = _chave()
    url = API + metodo + "?" + urllib.parse.urlencode(params)
    if metodo == "search":
        cota.buscas += 1
    else:
        cota.unidades += 1
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        corpo = e.read().decode("utf-8", "replace")
        try:
            motivo = json.loads(corpo)["error"]["errors"][0]["reason"]
        except (ValueError, KeyError, IndexError):
            motivo = corpo[:200]
        raise ErroAPI(metodo, e.code, motivo) from None


class ErroAPI(RuntimeError):
    def __init__(self, metodo, codigo, motivo):
        super().__init__(f"API {metodo} falhou: HTTP {codigo} ({motivo})")
        self.codigo = codigo
        self.motivo = motivo


def videos(ids, part="snippet,contentDetails,statistics"):
    """Dados de vários vídeos (1 unidade por lote de 50)."""
    saida = []
    for i in range(0, len(ids), 50):
        r = api("videos", part=part, id=",".join(ids[i:i + 50]), maxResults=50)
        saida.extend(r.get("items", []))
    return saida


def paises_dos_canais(ids):
    """País declarado de cada canal ({id: "BR" | None}); 1 unidade por lote de 50."""
    saida = {}
    for i in range(0, len(ids), 50):
        r = api("channels", part="snippet", id=",".join(ids[i:i + 50]), maxResults=50)
        for c in r.get("items", []):
            saida[c["id"]] = c["snippet"].get("country")
    return saida


def comentarios(video_id, quantos=100):
    """Textos dos comentários mais relevantes (1 unidade). None se desativados/indisponíveis."""
    try:
        r = api("commentThreads", part="snippet", videoId=video_id, maxResults=quantos,
                order="relevance", textFormat="plainText")
    except ErroAPI as e:
        if e.codigo == 404 or e.motivo in ("commentsDisabled", "forbidden"):
            return None
        raise
    return [t["snippet"]["topLevelComment"]["snippet"].get("textDisplay", "")
            for t in r.get("items", [])]


def segundos(iso):
    """Converte duração ISO 8601 (PT1H2M3S) em segundos."""
    m = re.fullmatch(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", iso or "")
    if not m:
        return None
    d, h, mi, s = (int(x or 0) for x in m.groups())
    return d * 86400 + h * 3600 + mi * 60 + s


def eh_short(video_id):
    """True se youtube.com/shorts/ID abre (200); False se redireciona (vídeo normal).

    None se a resposta for outra coisa (bloqueio, página de consentimento etc.).
    """
    c = http.client.HTTPSConnection("www.youtube.com", timeout=20)
    try:
        c.request("HEAD", f"/shorts/{video_id}", headers=UA)
        r = c.getresponse()
        local = r.getheader("Location") or ""
        if r.status == 200:
            return True
        if r.status in (301, 302, 303, 307) and "/watch" in local:
            return False
        return None
    finally:
        c.close()


def rss(canal_id):
    """Últimos ~15 uploads do canal via RSS (sem cota). Marca quais são Shorts."""
    url = f"https://www.youtube.com/feeds/videos.xml?channel_id={canal_id}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=20) as r:
        xml = r.read().decode("utf-8", "replace")
    itens = []
    for entrada in xml.split("<entry>")[1:]:
        vid = re.search(r"<yt:videoId>([^<]+)</yt:videoId>", entrada)
        link = re.search(r'<link rel="alternate" href="([^"]+)"', entrada)
        pub = re.search(r"<published>([^<]+)</published>", entrada)
        if vid:
            itens.append({
                "id": vid.group(1),
                "short": bool(link and "/shorts/" in link.group(1)),
                "publicado": pub.group(1) if pub else None,
            })
    return itens
