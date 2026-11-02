"""Teste do filtro de duração da busca (videoDuration).

Pergunta: vale a pena buscar só vídeos médios (4–20 min) e longos (> 20 min)
para não desperdiçar resultados com Shorts?

Para algumas buscas, compara três versões no mesmo momento:
  - sem filtro: quantos vídeos normais sobram depois de tirar os Shorts?
  - médio e longo: quantos vídeos normais vêm, e quantos da versão sem filtro se perdem?

Gasta 12 buscas. Grava só IDs e números em relatorios/teste_duracao.json.
"""
import json
import os
import statistics
import sys
from datetime import datetime, timedelta, timezone

import yt
from diagnostico import buscar

JANELA_H = 24
CONFIGS = [
    ("geral", {}),
    ("geral + português", {"relevanceLanguage": "pt"}),
    ("categoria 24 – Entretenimento", {"videoCategoryId": "24"}),
    ("categoria 25 – Notícias e política", {"videoCategoryId": "25"}),
]
DURACOES = [("sem filtro", None), ("médio (4–20 min)", "medium"), ("longo (> 20 min)", "long")]


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    agora = datetime.now(timezone.utc)
    desde = (agora - timedelta(hours=JANELA_H)).strftime("%Y-%m-%dT%H:%M:%SZ")

    buscas = {}
    for nome, extra in CONFIGS:
        for rot, dur in DURACOES:
            buscas[(nome, rot)] = buscar(f"{nome} / {rot}", publishedAfter=desde,
                                         order="viewCount", videoDuration=dur, **extra)

    todos = sorted({v for b in buscas.values() for v in b["ids"]})
    info = {v["id"]: v for v in yt.videos(todos)}
    dur = {i: yt.segundos(info[i]["contentDetails"].get("duration")) or 0 for i in info}

    # Short = até 3 min e youtube.com/shorts/ID abre. Só testa os curtos.
    cache_short = {}

    def short(vid):
        if vid not in info or dur[vid] > 180:
            return False
        if vid not in cache_short:
            try:
                cache_short[vid] = yt.eh_short(vid)
            except OSError:
                cache_short[vid] = None
        return cache_short[vid] is not False  # na dúvida, conta como Short

    def pt(vid):
        s = info[vid]["snippet"]
        return (s.get("defaultAudioLanguage") or s.get("defaultLanguage") or "").lower().startswith("pt")

    linhas = []
    for nome, _ in CONFIGS:
        sem = buscas[(nome, "sem filtro")]
        normais_sem = [i for i in sem["ids"] if i in info and not short(i)]
        com_filtro = set(buscas[(nome, "médio (4–20 min)")]["ids"]) | set(buscas[(nome, "longo (> 20 min)")]["ids"])
        perdidos = [i for i in normais_sem if i not in com_filtro]
        for rot, _ in DURACOES:
            b = buscas[(nome, rot)]
            normais = [i for i in b["ids"] if i in info and not short(i)]
            views = [int(info[i]["statistics"].get("viewCount", 0)) for i in normais]
            linhas.append({
                "busca": nome,
                "duracao": rot,
                "erro": b.get("erro"),
                "resultados": len(b["ids"]),
                "normais": len(normais),
                "normais_pt": sum(1 for i in normais if pt(i)),
                "mediana_views_normais": int(statistics.median(views)) if views else None,
                "ids": b["ids"],
            })
        linhas.append({
            "busca": nome,
            "duracao": "comparação",
            "normais_sem_filtro": len(normais_sem),
            "perdidos_com_filtro": len(perdidos),
            "perdidos_duracao_seg": sorted(dur[i] for i in perdidos),
            "novos_com_filtro": len([i for i in com_filtro if i in info and i not in normais_sem]),
        })

    relatorio = {
        "gerado_em": agora.isoformat(timespec="seconds"),
        "cota_gasta": {"buscas": yt.cota.buscas, "unidades": yt.cota.unidades},
        "linhas": linhas,
    }
    os.makedirs("relatorios", exist_ok=True)
    with open("relatorios/teste_duracao.json", "w", encoding="utf-8") as f:
        json.dump(relatorio, f, ensure_ascii=False, indent=2)

    texto = markdown(relatorio)
    print(texto)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write(texto)


def markdown(r):
    out = [
        f"# Teste do filtro de duração — {r['gerado_em']}",
        "",
        f"Cota gasta: **{r['cota_gasta']['buscas']} buscas** e **{r['cota_gasta']['unidades']} unidades**.",
        "",
        "| Busca | Duração | Resultados | Vídeos normais (sem Shorts) | Normais em PT | Mediana de views |",
        "|---|---|---|---|---|---|",
    ]
    comparacoes = []
    for l in r["linhas"]:
        if l["duracao"] == "comparação":
            comparacoes.append(l)
        elif l["erro"]:
            out.append(f"| {l['busca']} | {l['duracao']} | ERRO: {l['erro']} | | | |")
        else:
            out.append(f"| {l['busca']} | {l['duracao']} | {l['resultados']} | {l['normais']} | "
                       f"{l['normais_pt']} | {l['mediana_views_normais'] or '–'} |")
    out += ["", "## O que o filtro ganha e perde (médio + longo vs. sem filtro)", "",
            "| Busca | Normais sem filtro | Perdidos com filtro | Duração dos perdidos (s) | Novos com filtro |",
            "|---|---|---|---|---|"]
    for c in comparacoes:
        out.append(f"| {c['busca']} | {c['normais_sem_filtro']} | {c['perdidos_com_filtro']} | "
                   f"{', '.join(map(str, c['perdidos_duracao_seg'])) or '–'} | {c['novos_com_filtro']} |")
    return "\n".join(out) + "\n"


if __name__ == "__main__":
    sys.exit(main())
