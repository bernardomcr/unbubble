"""Diagnóstico do primeiro dia (Fase 1).

Responde às perguntas que o plano deixou abertas antes de montar o coletor de verdade:
  1. Quantos resultados cada busca realmente devolve (order=viewCount + filtro de data).
  2. O RSS dos canais funciona a partir do servidor do GitHub?
  3. O teste de Shorts (youtube.com/shorts/ID) funciona a partir do servidor do GitHub?

Gasta ~21 buscas (de 100/dia) e poucas dezenas de unidades.
Grava só IDs e números (nada de títulos), em relatorios/diagnostico.json,
e escreve um resumo legível no painel da execução do GitHub Actions.
"""
import json
import os
import statistics
import sys
from datetime import datetime, timedelta, timezone

import yt

JANELA_H = 24
MAX_TESTES_SHORTS = 80
MAX_TESTES_RSS = 10


def buscar(rotulo, **params):
    base = dict(part="snippet", type="video", regionCode="BR", maxResults=50)
    base.update(params)
    try:
        r = yt.api("search", **base)
    except RuntimeError as e:
        return {"rotulo": rotulo, "erro": str(e), "ids": []}
    return {
        "rotulo": rotulo,
        "ids": [i["id"]["videoId"] for i in r.get("items", []) if "videoId" in i.get("id", {})],
        "tem_pagina_2": "nextPageToken" in r,
        "total_declarado": r.get("pageInfo", {}).get("totalResults"),
        "_token": r.get("nextPageToken"),
    }


def main():
    sys.stdout.reconfigure(encoding="utf-8")  # console do Windows não é UTF-8
    agora = datetime.now(timezone.utc)
    desde = (agora - timedelta(hours=JANELA_H)).strftime("%Y-%m-%dT%H:%M:%SZ")
    janela = dict(publishedAfter=desde, order="viewCount")

    cats = yt.api("videoCategories", part="snippet", regionCode="BR", hl="pt_BR")
    categorias = [(c["id"], c["snippet"]["title"]) for c in cats.get("items", [])
                  if c["snippet"].get("assignable")]

    buscas = [buscar("geral", **janela)]
    if buscas[0].get("_token"):
        buscas.append(buscar("geral (página 2)", pageToken=buscas[0]["_token"], **janela))
    buscas.append(buscar("geral + português", relevanceLanguage="pt", **janela))
    buscas.append(buscar("geral, ordem por data (comparação)", publishedAfter=desde, order="date"))
    buscas.append(buscar("lives agora", eventType="live", order="viewCount"))
    for cid, nome in categorias:
        buscas.append(buscar(f"categoria {cid} – {nome}", videoCategoryId=cid, **janela))

    # Estatísticas de todos os vídeos encontrados
    todos = sorted({v for b in buscas for v in b["ids"]})
    info = {v["id"]: v for v in yt.videos(todos)}

    def resumo_busca(b):
        vs = [info[i] for i in b["ids"] if i in info]
        views = [int(v["statistics"].get("viewCount", 0)) for v in vs]
        durs = [yt.segundos(v["contentDetails"].get("duration")) or 0 for v in vs]
        pt = [v for v in vs if (v["snippet"].get("defaultAudioLanguage") or
                                v["snippet"].get("defaultLanguage") or "").lower().startswith("pt")]
        fora = [v for v in vs if v["snippet"]["publishedAt"] < desde and b["rotulo"] != "lives agora"]
        return {
            "rotulo": b["rotulo"],
            "erro": b.get("erro"),
            "resultados": len(b["ids"]),
            "tem_pagina_2": b.get("tem_pagina_2"),
            "total_declarado": b.get("total_declarado"),
            "mediana_views": int(statistics.median(views)) if views else None,
            "ate_3min": sum(1 for d in durs if d <= 180),
            "idioma_pt_declarado": len(pt),
            "fora_da_janela": len(fora),
            "ids": b["ids"],
        }

    resumos = [resumo_busca(b) for b in buscas]

    # Teste de Shorts nos vídeos curtos, conferido com o RSS quando possível
    curtos = [i for i in todos if i in info and
              (yt.segundos(info[i]["contentDetails"].get("duration")) or 0) <= 180]
    shorts = {}
    for vid in curtos[:MAX_TESTES_SHORTS]:
        try:
            shorts[vid] = yt.eh_short(vid)
        except OSError as e:
            shorts[vid] = f"erro: {e.__class__.__name__}"

    # Teste de RSS nos canais encontrados
    canais = sorted({info[i]["snippet"]["channelId"] for i in todos if i in info})
    rss = {}
    concordancia = {"concorda": 0, "discorda": 0}
    for canal in canais[:MAX_TESTES_RSS]:
        try:
            itens = yt.rss(canal)
            rss[canal] = len(itens)
            for it in itens:  # RSS marca Shorts pelo link; compara com o teste HEAD
                if it["id"] in shorts and isinstance(shorts[it["id"]], bool):
                    chave = "concorda" if shorts[it["id"]] == it["short"] else "discorda"
                    concordancia[chave] += 1
        except OSError as e:
            rss[canal] = f"erro: {e.__class__.__name__}"

    relatorio = {
        "gerado_em": agora.isoformat(timespec="seconds"),
        "janela_horas": JANELA_H,
        "cota_gasta": {"buscas": yt.cota.buscas, "unidades": yt.cota.unidades},
        "categorias": [{"id": c, "nome": n} for c, n in categorias],
        "buscas": resumos,
        "videos_unicos": len(todos),
        "shorts": {
            "testados": len(shorts),
            "short": sum(1 for v in shorts.values() if v is True),
            "normal": sum(1 for v in shorts.values() if v is False),
            "indefinido": sum(1 for v in shorts.values() if not isinstance(v, bool)),
            "rss_vs_teste": concordancia,
        },
        "rss": {
            "canais_testados": len(rss),
            "funcionaram": sum(1 for v in rss.values() if isinstance(v, int) and v > 0),
            "detalhe": rss,
        },
    }

    os.makedirs("relatorios", exist_ok=True)
    with open("relatorios/diagnostico.json", "w", encoding="utf-8") as f:
        json.dump(relatorio, f, ensure_ascii=False, indent=2)

    texto = markdown(relatorio)
    print(texto)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write(texto)


def markdown(r):
    linhas = [
        f"# Diagnóstico do coletor — {r['gerado_em']}",
        "",
        f"Cota gasta: **{r['cota_gasta']['buscas']} buscas** (de 100/dia) e "
        f"**{r['cota_gasta']['unidades']} unidades** (de 10.000/dia).",
        f"Vídeos únicos encontrados: **{r['videos_unicos']}**.",
        "",
        f"## Buscas (janela de {r['janela_horas']} h, Brasil, ordem por views)",
        "",
        "| Busca | Resultados | Tem pág. 2 | Mediana de views | ≤ 3 min | Idioma PT | Fora da janela |",
        "|---|---|---|---|---|---|---|",
    ]
    for b in r["buscas"]:
        if b["erro"]:
            linhas.append(f"| {b['rotulo']} | ERRO: {b['erro']} | | | | | |")
            continue
        linhas.append(
            f"| {b['rotulo']} | {b['resultados']} | {'sim' if b['tem_pagina_2'] else 'não'} | "
            f"{b['mediana_views'] if b['mediana_views'] is not None else '–'} | {b['ate_3min']} | "
            f"{b['idioma_pt_declarado']} | {b['fora_da_janela']} |")
    s, rs = r["shorts"], r["rss"]
    linhas += [
        "",
        "## Teste de Shorts (vídeos de até 3 min)",
        f"Testados: {s['testados']} → Short: {s['short']}, vídeo normal: {s['normal']}, "
        f"indefinido: {s['indefinido']}.",
        f"Conferência com o RSS: concorda {s['rss_vs_teste']['concorda']}, "
        f"discorda {s['rss_vs_teste']['discorda']}.",
        "",
        "## Teste de RSS dos canais",
        f"Canais testados: {rs['canais_testados']} → funcionaram: {rs['funcionaram']}.",
        "",
    ]
    return "\n".join(linhas)


if __name__ == "__main__":
    sys.exit(main())
