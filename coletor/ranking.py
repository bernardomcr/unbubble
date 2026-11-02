"""Score do Em Alta e montagem das fileiras publicadas (só IDs e números).

Score = log(views BR/hora) + 1,0·log(fator canal) + bônus de aceleração − penalidade de idade.
A seleção do Em Alta (variedade de temas e assuntos) fica em curadoria.py.
Pesos iniciais; ajustar depois de 1–2 semanas rodando (ver CLAUDE.md).
"""
import math
from datetime import datetime, timezone

import curadoria

POR_CANAL = 2
TAMANHO = {"em_alta": 50, "mais_vistos_24h": 50, "categoria": 30, "lives": 30}
MIN_CATEGORIA = 10
JANELA_VELOCIDADE_H = 3
PESO_CANAL = 1.0  # era 0,5; mais peso para vídeo muito acima do normal do canal


def _ts(iso):
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


def velocidade(c, agora):
    """Views por hora, pela média das últimas ~3 h (o contador congela no começo)."""
    leituras = c["leituras"]
    t1, v1 = leituras[-1][0], leituras[-1][1]
    antigas = [l for l in leituras[:-1] if t1 - l[0] >= 0.5 * 3600]
    if antigas:
        alvo = t1 - JANELA_VELOCIDADE_H * 3600
        t0, v0 = min(antigas, key=lambda l: abs(l[0] - alvo))[:2]
        return max(v1 - v0, 0) / ((t1 - t0) / 3600)
    idade_h = max((agora - _ts(c["publicado"])) / 3600, 1)
    return v1 / idade_h  # só uma leitura: média da vida toda


def aceleracao(c):
    """Razão entre a velocidade das últimas 3 h e a das 3 h anteriores (None se não der)."""
    l = c["leituras"]
    t = l[-1][0]
    meio = [x for x in l if t - x[0] >= 2.5 * 3600 and t - x[0] <= 3.5 * 3600]
    inicio = [x for x in l if t - x[0] >= 5.5 * 3600 and t - x[0] <= 6.5 * 3600]
    if not meio or not inicio:
        return None
    a, b = meio[0], inicio[0]
    recente = (l[-1][1] - a[1]) / max(t - a[0], 1)
    anterior = (a[1] - b[1]) / max(a[0] - b[0], 1)
    if anterior <= 0:
        return None
    return recente / anterior


def curva_idade(idade_h):
    """Fração das views "finais" que um vídeo típico já tem com essa idade (chute inicial: 48 h ≈ 100%)."""
    return min(max((idade_h / 48) ** 0.6, 0.05), 1)


def score(c, mediana_canal, agora):
    vel_br = velocidade(c, agora) * c["br"]
    s = math.log10(max(vel_br, 1))
    idade_h = (agora - _ts(c["publicado"])) / 3600
    if mediana_canal:
        # Compara com o que um vídeo típico do canal teria na mesma idade (curva aproximada)
        esperado = mediana_canal * curva_idade(idade_h)
        fator = c["leituras"][-1][1] / max(esperado, 1)
        s += PESO_CANAL * math.log10(min(max(fator, 0.1), 100))
    acel = aceleracao(c)
    if acel and acel > 1:
        s += min(0.5 * math.log10(acel), 0.5)
    if idade_h > 48:
        s -= 0.5 * (idade_h - 48) / 24
    return s


def views_24h(c, agora):
    """Views ganhas nas últimas 24 h (None se ainda não dá para saber)."""
    v_agora = c["leituras"][-1][1]
    if agora - _ts(c["publicado"]) <= 24 * 3600:
        return v_agora
    antigas = [l for l in c["leituras"] if agora - l[0] >= 20 * 3600]
    if not antigas:
        return None
    t0, v0 = antigas[-1][:2]
    return (v_agora - v0) * 24 * 3600 / max(agora - t0, 1)


def _limitar(itens, chave_canal, n):
    """Mantém a ordem, no máximo POR_CANAL por canal, até n itens."""
    conta, saida = {}, []
    for item in itens:
        canal = chave_canal(item)
        if conta.get(canal, 0) < POR_CANAL:
            conta[canal] = conta.get(canal, 0) + 1
            saida.append(item)
            if len(saida) == n:
                break
    return saida


def gerar(estado, agora):
    cands = estado["candidatos"]
    canais = estado["canais"]
    videos = {vid: c for vid, c in cands.items() if not c.get("live") and c.get("br")}
    pontos = {vid: score(c, canais.get(c["canal"], {}).get("mediana"), agora)
              for vid, c in videos.items()}
    ordem = sorted(pontos, key=pontos.get, reverse=True)
    canal_de = lambda vid: cands[vid]["canal"]  # noqa: E731

    em_alta = curadoria.selecionar(ordem, cands, TAMANHO["em_alta"],
                                   curadoria.palavras_comuns(videos.values()))

    ganhos = {vid: views_24h(c, agora) for vid, c in videos.items()}
    ganhos = {vid: g * videos[vid]["br"] for vid, g in ganhos.items() if g}
    mais_vistos = _limitar(sorted(ganhos, key=ganhos.get, reverse=True), canal_de,
                           TAMANHO["mais_vistos_24h"])

    categorias = {}
    for vid in ordem:
        categorias.setdefault(videos[vid].get("cat"), []).append(vid)
    categorias = {cat: _limitar(ids, canal_de, TAMANHO["categoria"])
                  for cat, ids in categorias.items() if cat}
    categorias = {cat: ids for cat, ids in categorias.items() if len(ids) >= MIN_CATEGORIA}

    lives = {vid: c.get("espectadores", 0) * c["br"] for vid, c in cands.items()
             if c.get("live") and c.get("br") and c.get("espectadores")}
    lives_ordem = _limitar(sorted(lives, key=lives.get, reverse=True), canal_de, TAMANHO["lives"])

    return {
        "gerado_em": datetime.fromtimestamp(agora, timezone.utc).isoformat(timespec="seconds"),
        "em_alta": [{"id": v, "score": round(pontos[v], 3)} for v in em_alta],
        "mais_vistos_24h": [{"id": v, "views_br": int(ganhos[v])} for v in mais_vistos],
        "categorias": {cat: [{"id": v, "score": round(pontos[v], 3)} for v in ids]
                       for cat, ids in sorted(categorias.items(), key=lambda x: int(x[0]))},
        "lives": [{"id": v, "espectadores_br": int(lives[v])} for v in lives_ordem],
    }
