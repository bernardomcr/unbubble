"""Filtro Brasil: o vídeo interessa ao público brasileiro?

Sem IA: contagem de palavras típicas de cada idioma e de marcas PT-BR vs. PT-PT.
Títulos, descrições e comentários são usados só na hora e nunca guardados.
"""
import re

# Palavras que só (ou quase só) aparecem em português
PT = {
    "não", "nao", "você", "voce", "vc", "vcs", "muito", "muita", "isso", "também", "tambem",
    "pra", "né", "tá", "então", "entao", "só", "meu", "minha", "ele", "ela", "eu", "nós",
    "obrigado", "obrigada", "parabéns", "parabens", "agora", "melhor", "tem", "têm", "bom",
    "boa", "sim", "esse", "essa", "isso", "aqui", "ótimo", "otimo", "legal", "mais", "fazer",
    "vídeo", "também", "quando", "ainda", "nunca", "gente", "coisa", "demais", "mano", "pessoal",
}
ES = {
    "muy", "pero", "el", "los", "las", "y", "es", "esto", "eso", "qué", "jaja", "jajaja",
    "gracias", "mejor", "yo", "tiene", "bien", "hermano", "nunca", "aquí", "ahora", "cuando",
    "porque", "señor", "hay", "del", "ese", "esa", "también", "más",
}
EN = {
    "the", "and", "is", "you", "this", "that", "of", "what", "it", "so", "love", "i", "my",
    "was", "are", "for", "with", "like", "just", "be", "have", "he", "she", "they", "lol",
}
# Marcas de português do Brasil vs. de Portugal
BR = {"você", "voce", "vc", "vcs", "tá", "né", "pra", "tô", "celular", "ônibus", "onibus",
      "trem", "legal", "cara", "mano", "galera", "banheiro", "time", "gol", "gente"}
PT_PT = {"fixe", "telemóvel", "telemovel", "autocarro", "ecrã", "ecra", "equipa", "facto",
         "bué", "bue", "porreiro", "miúdo", "miúdos", "rapariga", "giro", "comboio", "casa-de-banho"}
RE_PALAVRA = re.compile(r"[a-záàâãéêíóôõúüç]+(?:-[a-záàâãéêíóôõúüç]+)?")
RE_PT_PT = re.compile(r"\b(estou|está|estás|estamos|estão|anda|andam|continua) a \w+[aei]r\b"
                      r"|\btu és\b|\bvós\b")
RE_KKK = re.compile(r"\bk{3,}\b")
RE_GERUNDIO = re.compile(r"\b(estou|está|tô|tá|estamos|tamo|estão|tão) \w+ndo\b")

CORTE_ESTRANGEIRO = 0.25   # fração PT-BR mínima nos comentários para um vídeo estrangeiro entrar
MIN_COMENTARIOS = 20
PRIOR_BR = 0.85            # entre comentários em português sem marca, quantos supomos ser do Brasil


def idioma(texto):
    """'pt', 'es', 'en' ou None para um pedaço de texto."""
    t = (texto or "").lower()
    palavras = RE_PALAVRA.findall(t)
    pt = sum(p in PT for p in palavras) + 2 * len(re.findall(r"[ãõ]", t)) + 2 * len(RE_KKK.findall(t))
    es = sum(p in ES for p in palavras) + 2 * len(re.findall(r"[ñ¿¡]", t))
    en = sum(p in EN for p in palavras)
    melhor = max(pt, es, en)
    if melhor == 0:
        return None
    if pt == melhor and pt > es and pt > en:
        return "pt"
    if es == melhor and es > pt:
        return "es"
    if en == melhor and en > pt:
        return "en"
    return None


def variante(texto):
    """'br', 'pt' (Portugal) ou None, para um texto já reconhecido como português."""
    t = (texto or "").lower()
    palavras = set(RE_PALAVRA.findall(t))
    br = len(palavras & BR) + len(RE_KKK.findall(t)) + len(RE_GERUNDIO.findall(t))
    pp = len(palavras & PT_PT) + 2 * len(RE_PT_PT.findall(t))
    if br > pp:
        return "br"
    if pp > br:
        return "pt"
    return None


def fracao_br(comentarios):
    """Fração estimada de comentários do Brasil. None se houver poucos comentários."""
    if comentarios is None or len(comentarios) < MIN_COMENTARIOS:
        return None
    em_pt = [c for c in comentarios if idioma(c) == "pt"]
    marcas = [variante(c) for c in em_pt]
    br, pp = marcas.count("br"), marcas.count("pt")
    neutros = len(em_pt) - br - pp
    proporcao_br = (br + 2 * PRIOR_BR) / (br + pp + 2)  # suavizado com o palpite inicial
    return round((br + neutros * proporcao_br) / len(comentarios), 3)


def classificar(video, pais_canal):
    """Classifica pelo que está na página do vídeo, sem ler comentários.

    'br'          claramente brasileiro (fator Brasil 1)
    'ambiguo'     português, mas pode ser de Portugal: ler comentários
    'estrangeiro' outro idioma: ler comentários
    """
    s = video["snippet"]
    declarado = (s.get("defaultAudioLanguage") or s.get("defaultLanguage") or "").lower()
    texto = s.get("title", "") + "\n" + (s.get("description") or "")[:500]
    marca = variante(texto)
    if declarado in ("pt-pt",) or pais_canal == "PT" or marca == "pt":
        return "ambiguo"
    if pais_canal == "BR" and (not declarado or declarado.startswith("pt")):
        return "br"
    if declarado.startswith("pt"):
        return "br"
    if not declarado and idioma(texto) == "pt":
        return "br"
    if pais_canal == "BR":
        return "ambiguo"   # canal brasileiro falando outra língua
    return "estrangeiro"
