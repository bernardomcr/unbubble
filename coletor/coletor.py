"""Coletor do pilar 1 (Em Alta). Roda de hora em hora no GitHub Actions.

A cada execução:
  1. Faz as buscas que estiverem na hora (rodadas manhã/tarde/noite, tópicos, lives).
  2. Lê o RSS de parte dos canais brasileiros já conhecidos (uploads novos, sem cota).
  3. Classifica os vídeos novos: tira Shorts e aplica o filtro Brasil.
  4. Atualiza as views de todos os candidatos (velocidade = diferença entre leituras).
  5. Atualiza a mediana de views de alguns canais (fator canal).
  6. Gera o ranking e grava dados/estado.json e dados/ranking.json.

Guarda só IDs e números: títulos, descrições e comentários são lidos e descartados na hora.
"""
import json
import os
import statistics
import sys
import time
from datetime import datetime, timedelta, timezone

import brasil
import curadoria
import ranking
import yt

DADOS = os.environ.get("DADOS_DIR", "dados")
BRT = timezone(timedelta(hours=-3))
try:
    from zoneinfo import ZoneInfo
    PACIFICO = ZoneInfo("America/Los_Angeles")  # a cota do YouTube zera à meia-noite do Pacífico
except Exception:
    PACIFICO = timezone(timedelta(hours=-8))

MAX_BUSCAS_DIA = 95
MAX_UNIDADES_DIA = 9000
MAX_CANDIDATOS = 2000
MAX_COMENTARIOS_POR_EXECUCAO = 300
RSS_POR_EXECUCAO = 150
MEDIANAS_POR_EXECUCAO = 100
IDADE_MAX_H = 7 * 24
PROTEGIDO_H = 6            # candidato novo não é cortado antes de ter algumas leituras
MEDIANA_VALIDADE_H = 7 * 24
UPLOAD_RSS_MAX_H = 48

CATEGORIAS = ["1", "2", "10", "15", "17", "19", "20", "22", "23", "24", "25", "26", "27", "28"]
TOPICOS = {  # tópicos oficiais do YouTube (Freebase); lista inicial, revisar com o uso
    "/m/02vx4": "futebol", "/m/09xp_": "MMA", "/m/0bzvm2": "games", "/m/04rlf": "música",
    "/m/0g293": "música latina", "/m/0glt670": "hip hop", "/m/02mscn": "música cristã",
    "/m/06bvp": "religião", "/m/05qt0": "política", "/m/098wr": "sociedade",
    "/m/09s1f": "negócios", "/m/0kt51": "saúde", "/m/02wbm": "comida", "/m/07c1v": "tecnologia",
    "/m/09kqc": "humor", "/m/0f2f9": "programas de TV", "/m/02vxn": "filmes",
    "/m/07yv9": "veículos", "/m/041xxh": "beleza", "/m/01k8wb": "conhecimento",
}


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def ts(texto):
    return datetime.fromisoformat(texto.replace("Z", "+00:00")).timestamp()


def carregar():
    try:
        with open(os.path.join(DADOS, "estado.json"), encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {"versao": 1, "cota": {}, "tarefas": {}, "candidatos": {}, "canais": {},
                "descartados": {}}


def salvar(estado, rank):
    os.makedirs(DADOS, exist_ok=True)
    for nome, obj in (("estado.json", estado), ("ranking.json", rank)):
        tmp = os.path.join(DADOS, nome + ".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, os.path.join(DADOS, nome))


class Coletor:
    def __init__(self, estado, agora):
        self.e = estado
        self.agora = agora
        self.log = []
        self.sem_cota = False
        dia = datetime.fromtimestamp(agora, PACIFICO).date().isoformat()
        if self.e["cota"].get("dia") != dia:
            self.e["cota"] = {"dia": dia, "buscas": 0, "unidades": 0}

    # ---------- cota ----------
    def buscas_usadas(self):
        return self.e["cota"]["buscas"] + yt.cota.buscas

    def unidades_usadas(self):
        return self.e["cota"]["unidades"] + yt.cota.unidades

    def fechar_cota(self):
        self.e["cota"]["buscas"] += yt.cota.buscas
        self.e["cota"]["unidades"] += yt.cota.unidades
        yt.cota.buscas = yt.cota.unidades = 0

    # ---------- 1. buscas ----------
    def tarefas_da_hora(self):
        """Lista de (nome, buscas) que estão na hora e ainda não foram feitas hoje."""
        agora_brt = datetime.fromtimestamp(self.agora, BRT)
        hoje, hora = agora_brt.date().isoformat(), agora_brt.hour
        feitas = self.e["tarefas"]
        geral = lambda h: [  # noqa: E731
            (f"geral {d}{' pt' if pt else ''}", dict(janela_h=h, videoDuration=d,
                                                       relevanceLanguage="pt" if pt else None))
            for pt in (False, True) for d in ("medium", "long")]
        cats = lambda h: [(f"cat {c}", dict(janela_h=h, videoDuration="medium", videoCategoryId=c))  # noqa: E731
                          for c in CATEGORIAS]
        lives = [("lives", dict(eventType="live"))]

        tarefas = []
        if not self.e["candidatos"] and feitas.get("inicial") is None:
            # Primeiro dia: varredura de 24 h para encher o funil (vale como rodada da manhã)
            tarefas.append(("inicial", geral(24) + cats(24) + lives))
            feitas["manha"] = hoje
        if hora >= 9 and feitas.get("manha") != hoje:
            tarefas.append(("manha", geral(12) + cats(12) + lives))
        if hora >= 12 and feitas.get("topicos") != hoje:
            tarefas.append(("topicos", [(f"tópico {n}", dict(janela_h=72, videoDuration="medium",
                                                              topicId=t, relevanceLanguage="pt"))
                                        for t, n in TOPICOS.items()]))
        if hora >= 15 and feitas.get("tarde") != hoje:
            tarefas.append(("tarde", geral(6) + lives))
        if hora >= 21 and feitas.get("noite") != hoje:
            tarefas.append(("noite", geral(6) + cats(12) + lives))
        return tarefas, hoje

    def buscar(self, rotulo, janela_h=None, **params):
        if self.sem_cota or self.buscas_usadas() >= MAX_BUSCAS_DIA:
            self.sem_cota = True
            return []
        if janela_h:
            params["publishedAfter"] = iso(self.agora - janela_h * 3600)
        try:
            r = yt.api("search", part="snippet", type="video", regionCode="BR", maxResults=50,
                       order="viewCount", **params)
        except yt.ErroAPI as e:
            if "quota" in e.motivo.lower():
                self.sem_cota = True
            self.log.append(f"busca '{rotulo}': {e}")
            return []
        return [i["id"]["videoId"] for i in r.get("items", []) if "videoId" in i.get("id", {})]

    def descobrir(self):
        tarefas, hoje = self.tarefas_da_hora()
        achados = set()
        for nome, buscas in tarefas:
            antes = len(achados)
            for rotulo, params in buscas:
                achados.update(self.buscar(rotulo, **params))
            if not self.sem_cota:
                self.e["tarefas"][nome] = hoje
            self.log.append(f"rodada '{nome}': {len(buscas)} buscas, {len(achados) - antes} IDs")
        return achados

    # ---------- 2. RSS ----------
    def rss_canais(self):
        canais = [c for c, d in self.e["canais"].items() if d.get("brasileiro")]
        canais.sort(key=lambda c: self.e["canais"][c].get("rss_em", 0))
        novos, falhas = set(), 0
        for canal in canais[:RSS_POR_EXECUCAO]:
            try:
                itens = yt.rss(canal)
            except OSError:
                falhas += 1
                continue
            self.e["canais"][canal]["rss_em"] = self.agora
            for it in itens:
                if not it["short"] and it["publicado"] and \
                        self.agora - ts(it["publicado"]) <= UPLOAD_RSS_MAX_H * 3600:
                    novos.add(it["id"])
        if canais:
            self.log.append(f"RSS: {min(len(canais), RSS_POR_EXECUCAO)} canais, "
                            f"{len(novos)} uploads recentes, {falhas} falhas")
        return novos

    # ---------- 3. classificação ----------
    def classificar(self, ids):
        ids = [i for i in ids if i not in self.e["candidatos"] and i not in self.e["descartados"]]
        if not ids:
            return
        info = yt.videos(ids, part="snippet,contentDetails,statistics,liveStreamingDetails,topicDetails")
        vistos = {v["id"] for v in info}
        for i in set(ids) - vistos:
            self.descartar(i, "indisponivel")

        canais_sem_pais = sorted({v["snippet"]["channelId"] for v in info} -
                                 {c for c, d in self.e["canais"].items() if "pais" in d})
        for c, pais in yt.paises_dos_canais(canais_sem_pais).items():
            self.e["canais"].setdefault(c, {})["pais"] = pais

        comentarios_lidos = 0
        contagem = {}
        pendentes = []
        # Mais vistos primeiro: se o limite de comentários acabar, sobram os menos relevantes
        info.sort(key=lambda v: -int(v.get("statistics", {}).get("viewCount", 0)))
        for v in info:
            vid, s = v["id"], v["snippet"]
            ao_vivo = s.get("liveBroadcastContent")
            if ao_vivo == "upcoming":
                continue  # ainda não começou; pode voltar numa busca futura
            dur = yt.segundos(v["contentDetails"].get("duration")) or 0
            if ao_vivo != "live" and dur <= 180:
                try:
                    eh_short = yt.eh_short(vid)
                except OSError:
                    eh_short = None
                if eh_short is not False:
                    self.descartar(vid, "short")
                    contagem["short"] = contagem.get("short", 0) + 1
                    continue

            canal = s["channelId"]
            pais = self.e["canais"].get(canal, {}).get("pais")
            tipo = brasil.classificar(v, pais)
            if tipo == "br":
                fator = 1.0
            else:
                if comentarios_lidos >= MAX_COMENTARIOS_POR_EXECUCAO or \
                        self.unidades_usadas() >= MAX_UNIDADES_DIA:
                    pendentes.append(vid)  # fica na fila para a próxima execução
                    continue
                comentarios_lidos += 1
                try:
                    fator = brasil.fracao_br(yt.comentarios(vid))
                except yt.ErroAPI as e:
                    self.log.append(f"comentários: {e}; parando de ler por hoje")
                    comentarios_lidos = MAX_COMENTARIOS_POR_EXECUCAO
                    pendentes.append(vid)
                    continue
                if fator is None:
                    fator = 0.5 if tipo == "ambiguo" else 0
                if fator < brasil.CORTE_ESTRANGEIRO:
                    self.descartar(vid, "estrangeiro")
                    contagem["descartado"] = contagem.get("descartado", 0) + 1
                    continue
            contagem[tipo] = contagem.get(tipo, 0) + 1
            if fator >= 0.5:
                self.e["canais"].setdefault(canal, {})["brasileiro"] = True

            st = v.get("statistics", {})
            self.e["candidatos"][vid] = {
                "canal": canal,
                "publicado": s["publishedAt"],
                "dur": dur,
                "cat": s.get("categoryId"),
                "live": ao_vivo == "live",
                "br": fator,
                "leituras": [[int(self.agora), int(st.get("viewCount", 0)),
                              int(st.get("likeCount", 0)), int(st.get("commentCount", 0))]],
                "espectadores": int(v.get("liveStreamingDetails", {}).get("concurrentViewers", 0)),
            }
            self.e["candidatos"][vid].update(curadoria.marcas(v))
        self.e["pendentes"] = pendentes[:MAX_CANDIDATOS]
        self.log.append(f"classificação de {len(info)} vídeos novos: {contagem} "
                        f"({comentarios_lidos} leram comentários; {len(pendentes)} na fila)")

    def descartar(self, vid, motivo):
        self.e["descartados"][vid] = [motivo, int(self.agora)]

    # ---------- 4. acompanhamento ----------
    def acompanhar(self, novos):
        ids = [i for i in self.e["candidatos"] if i not in novos]
        if not ids:
            return
        # snippet e topicDetails não custam a mais: atualizam tema, assunto e "transmissão encerrada"
        info = {v["id"]: v for v in yt.videos(
            ids, part="snippet,statistics,liveStreamingDetails,topicDetails")}
        sumiram = 0
        for vid in ids:
            c = self.e["candidatos"][vid]
            v = info.get(vid)
            if v is None:
                del self.e["candidatos"][vid]  # apagado ou privado
                sumiram += 1
                continue
            lsd = v.get("liveStreamingDetails", {})
            if c.get("live") and lsd.get("actualEndTime"):
                del self.e["candidatos"][vid]  # live acabou
                continue
            st = v.get("statistics", {})
            c["leituras"].append([int(self.agora), int(st.get("viewCount", 0)),
                                  int(st.get("likeCount", 0)), int(st.get("commentCount", 0))])
            c["leituras"] = [l for l in c["leituras"] if self.agora - l[0] <= 26 * 3600]
            c["espectadores"] = int(lsd.get("concurrentViewers", 0))
            c.update(curadoria.marcas(v))
        self.log.append(f"acompanhamento: {len(ids)} candidatos, {sumiram} sumiram")

    # ---------- 5. fator canal ----------
    def atualizar_medianas(self):
        canais_ativos = {c["canal"] for c in self.e["candidatos"].values() if not c.get("live")}
        vencidos = [c for c in canais_ativos
                    if self.agora - self.e["canais"].get(c, {}).get("mediana_em", 0)
                    > MEDIANA_VALIDADE_H * 3600]
        vencidos = vencidos[:MEDIANAS_POR_EXECUCAO]
        uploads = {}
        for canal in vencidos:
            try:
                itens = [it for it in yt.rss(canal) if not it["short"] and it["publicado"]]
            except OSError:
                continue
            assentados = [it["id"] for it in itens if self.agora - ts(it["publicado"]) > 3 * 86400]
            uploads[canal] = assentados if len(assentados) >= 3 else [it["id"] for it in itens]
        todos = [i for ids in uploads.values() for i in ids]
        views = {v["id"]: int(v.get("statistics", {}).get("viewCount", 0))
                 for v in yt.videos(todos, part="statistics")} if todos else {}
        for canal, ids in uploads.items():
            vs = [views[i] for i in ids if i in views]
            d = self.e["canais"].setdefault(canal, {})
            d["mediana"] = int(statistics.median(vs)) if vs else None
            d["mediana_em"] = int(self.agora)
        if vencidos:
            self.log.append(f"mediana de canal atualizada: {len(uploads)} de {len(vencidos)} canais")

    # ---------- 6. limpeza ----------
    def limpar(self):
        cands = self.e["candidatos"]
        for vid in [v for v, c in cands.items()
                    if self.agora - ts(c["publicado"]) > IDADE_MAX_H * 3600]:
            del cands[vid]
        normais = [v for v, c in cands.items() if not c.get("live")
                   and self.agora - c["leituras"][0][0] > PROTEGIDO_H * 3600]
        if len(cands) > MAX_CANDIDATOS:
            pontos = {v: ranking.score(cands[v], self.e["canais"].get(cands[v]["canal"], {})
                                       .get("mediana"), self.agora) for v in normais}
            excesso = len(cands) - MAX_CANDIDATOS
            for v in sorted(pontos, key=pontos.get)[:excesso]:
                del cands[v]
        self.e["descartados"] = {v: d for v, d in self.e["descartados"].items()
                                 if self.agora - d[1] <= IDADE_MAX_H * 3600}
        usados = {c["canal"] for c in cands.values()}
        self.e["canais"] = {c: d for c, d in self.e["canais"].items()
                            if d.get("brasileiro") or c in usados}

    def rodar(self):
        achados = self.descobrir()
        achados |= self.rss_canais()
        achados |= set(self.e.pop("pendentes", []))
        antes = set(self.e["candidatos"])
        self.classificar(sorted(achados))
        self.acompanhar(set(self.e["candidatos"]) - antes)
        self.atualizar_medianas()
        self.limpar()
        self.fechar_cota()
        return ranking.gerar(self.e, self.agora)


def resumo(estado, rank, log):
    cota = estado["cota"]
    linhas = [
        f"# Coletor — {rank['gerado_em']}",
        "",
        f"Cota do dia ({cota['dia']}, horário do Pacífico): **{cota['buscas']} buscas** e "
        f"**{cota['unidades']} unidades**.",
        f"Candidatos acompanhados: **{len(estado['candidatos'])}**; canais conhecidos: "
        f"{len(estado['canais'])}; descartados (7 dias): {len(estado['descartados'])}.",
        f"Ranking: Em Alta {len(rank['em_alta'])}, Mais vistos 24 h {len(rank['mais_vistos_24h'])}, "
        f"categorias {len(rank['categorias'])}, lives {len(rank['lives'])}.",
        "",
        "## O que aconteceu",
        *[f"- {l}" for l in log],
        "",
    ]
    return "\n".join(linhas)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    agora = float(os.environ.get("COLETOR_AGORA") or time.time())  # COLETOR_AGORA só para testes
    estado = carregar()
    coletor = Coletor(estado, agora)
    rank = coletor.rodar()
    salvar(estado, rank)
    texto = resumo(estado, rank, coletor.log)
    print(texto)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write(texto)


if __name__ == "__main__":
    sys.exit(main())
