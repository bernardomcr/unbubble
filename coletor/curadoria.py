"""Curadoria do Em Alta: variedade de temas e de assuntos.

O antigo Em Alta do YouTube buscava "variedade" além de views e velocidade. Aqui isso vira regras:
  - Teto por tema: esporte, política/notícias e música entram no máximo 2 vezes cada
    (continuam completos nas fileiras das próprias categorias).
  - Um vídeo por assunto: vários canais postando o mesmo jogo/acontecimento contam uma vez só.
  - Variedade no topo: entre os 20 primeiros, nenhum outro tema mais de 3 vezes.
  - Transmissões ao vivo já encerradas ficam fora do Em Alta.

Do título só se guarda uma "assinatura": códigos curtos das palavras, sem o texto.
"""
import hashlib
import re

TETO_TEMA = {"esporte": 2, "politica": 2, "musica": 2}
TOPO = 20
MAX_TEMA_TOPO = 3
POR_CANAL = 2
MIN_PALAVRAS_EM_COMUM = 2

ESPORTES = {
    "Sport", "Association_football", "American_football", "Basketball", "Baseball", "Boxing",
    "Cricket", "Golf", "Ice_hockey", "Mixed_martial_arts", "Motorsport", "Professional_wrestling",
    "Rugby_football", "Tennis", "Volleyball",
}
PARADAS = {
    "que", "com", "para", "pra", "por", "uma", "uns", "dos", "das", "nos", "nas", "não", "nao",
    "mais", "como", "seu", "sua", "the", "and", "you", "isso", "esse", "essa", "este", "esta",
    "ele", "ela", "foi", "vai", "tem", "sobre", "até", "ate", "pelo", "pela", "aos", "mas",
}


def tema(video):
    """'esporte', 'politica', 'musica' ou outro rótulo de tema (para a variedade do topo)."""
    nomes = [u.rsplit("/", 1)[-1] for u in video.get("topicDetails", {}).get("topicCategories", [])]
    cat = video.get("snippet", {}).get("categoryId")
    if cat == "17" or any(n in ESPORTES for n in nomes):
        return "esporte"
    if cat == "25" or "Politics" in nomes:
        return "politica"
    if cat == "10" or any("music" in n.lower() for n in nomes):
        return "musica"
    return nomes[0] if nomes else f"cat{cat}"


def assinatura(titulo):
    """Palavras significativas do título como códigos curtos (o texto não fica guardado)."""
    palavras = re.findall(r"[a-z0-9áàâãéêíóôõúüç]+", (titulo or "").lower())
    return sorted({hashlib.md5(p.encode()).hexdigest()[:6] for p in palavras
                   if len(p) >= 3 and not p.isdigit() and p not in PARADAS})


def marcas(video):
    """Campos de curadoria guardados em cada candidato."""
    lsd = video.get("liveStreamingDetails", {})
    return {
        "tema": tema(video),
        "assunto": assinatura(video.get("snippet", {}).get("title")),
        "ex_live": bool(lsd.get("actualEndTime")),
    }


def palavras_comuns(candidatos):
    """Palavras frequentes demais para indicar assunto (ex.: 'jogo', 'completo', 'vivo')."""
    freq = {}
    for c in candidatos:
        for p in c.get("assunto", []):
            freq[p] = freq.get(p, 0) + 1
    limite = max(3, 0.03 * len(candidatos))
    return {p for p, n in freq.items() if n > limite}


def selecionar(ordem, cands, n, comuns):
    """Em Alta: percorre por score aplicando canal, tema, assunto e variedade no topo."""
    saida, adiados = [], []
    por_canal, por_tema, assuntos = {}, {}, []

    def cabe(vid, no_topo):
        c = cands[vid]
        t = c.get("tema")
        if c.get("ex_live") or por_canal.get(c["canal"], 0) >= POR_CANAL:
            return "nao"
        if t in TETO_TEMA and por_tema.get(t, 0) >= TETO_TEMA[t]:
            return "nao"
        meu = set(c.get("assunto", [])) - comuns
        if any(len(meu & outro) >= MIN_PALAVRAS_EM_COMUM for outro in assuntos):
            return "nao"
        if no_topo and t and por_tema.get(t, 0) >= MAX_TEMA_TOPO:
            return "adiar"
        return "sim"

    def pegar(vid):
        c = cands[vid]
        saida.append(vid)
        por_canal[c["canal"]] = por_canal.get(c["canal"], 0) + 1
        por_tema[c.get("tema")] = por_tema.get(c.get("tema"), 0) + 1
        assuntos.append(set(c.get("assunto", [])) - comuns)

    for vid in ordem:
        if len(saida) >= n:
            break
        if len(saida) == TOPO and adiados:  # topo fechado: os adiados voltam na ordem do score
            for a in adiados:
                if len(saida) < n and cabe(a, False) == "sim":
                    pegar(a)
            adiados = []
            if len(saida) >= n:
                break
        r = cabe(vid, len(saida) < TOPO)
        if r == "sim":
            pegar(vid)
        elif r == "adiar":
            adiados.append(vid)
    for a in adiados:  # lista acabou antes de fechar o topo
        if len(saida) < n and cabe(a, False) == "sim":
            pegar(a)
    return saida
