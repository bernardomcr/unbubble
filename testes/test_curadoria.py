"""Testes da curadoria do Em Alta. Rodar com: python -m unittest discover testes"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "coletor"))
import curadoria  # noqa: E402


def cand(canal, tema, titulo, ex_live=False):
    return {"canal": canal, "tema": tema, "assunto": curadoria.assinatura(titulo), "ex_live": ex_live}


class TestTema(unittest.TestCase):
    def test_tema(self):
        futebol = {"snippet": {"categoryId": "24"},
                   "topicDetails": {"topicCategories": ["https://en.wikipedia.org/wiki/Association_football"]}}
        self.assertEqual(curadoria.tema(futebol), "esporte")
        self.assertEqual(curadoria.tema({"snippet": {"categoryId": "25"}}), "politica")
        pop = {"snippet": {"categoryId": "24"},
               "topicDetails": {"topicCategories": ["https://en.wikipedia.org/wiki/Pop_music"]}}
        self.assertEqual(curadoria.tema(pop), "musica")
        humor = {"snippet": {"categoryId": "23"},
                 "topicDetails": {"topicCategories": ["https://en.wikipedia.org/wiki/Humour"]}}
        self.assertEqual(curadoria.tema(humor), "Humour")

    def test_assinatura_nao_guarda_texto(self):
        a = curadoria.assinatura("Palmeiras x Vasco ao vivo")
        self.assertTrue(all(len(p) == 6 for p in a))
        self.assertNotIn("palmeiras", " ".join(a))


class TestSelecionar(unittest.TestCase):
    def montar(self):
        # Ordem do score: muito esporte no topo, como no primeiro ranking real
        cands = {
            "f1": cand("ge", "esporte", "JOGO COMPLETO: Palmeiras x Vasco | Copa do Brasil"),
            "f2": cand("caze", "esporte", "AO VIVO: Palmeiras x Vasco semifinal"),
            "f3": cand("itatiaia", "esporte", "Grêmio x Atlético ao vivo"),
            "f4": cand("espn", "esporte", "River Plate x Flamengo final"),
            "l1": cand("bage", "esporte", "Jornada do Bagé", ex_live=True),
            "p1": cand("noticias", "politica", "Greve dos caminhoneiros"),
            "p2": cand("cnn", "politica", "Lula anuncia medida"),
            "p3": cand("band", "politica", "Senado vota reforma"),
            "m1": cand("anitta", "musica", "Anitta clipe novo"),
            "m2": cand("ludmilla", "musica", "Ludmilla ao vivo no show"),
            "m3": cand("gusttavo", "musica", "Gusttavo Lima lançamento"),
        }
        for i in range(30):
            cands[f"h{i}"] = cand(f"humor{i}", "Humour", f"esquete numero{i} engraçada{i}")
        for i in range(5):
            cands[f"g{i}"] = cand(f"gamer{i}", "Video_game_culture", f"partida gameplay{i} ranqueada{i}")
        outros = []
        for t in ("Food", "Technology", "Lifestyle", "Vehicle", "Pet"):
            for i in range(4):
                cands[f"{t}{i}"] = cand(f"{t}canal{i}", t, f"{t}assunto{i} {t}extra{i}")
                outros.append(f"{t}{i}")
        ordem = ["f1", "f2", "f3", "f4", "l1", "p1", "p2", "p3", "m1", "m2", "m3"] + \
                [f"g{i}" for i in range(5)] + [f"h{i}" for i in range(30)] + outros
        return cands, ordem

    def test_regras(self):
        cands, ordem = self.montar()
        sel = curadoria.selecionar(ordem, cands, 50, curadoria.palavras_comuns(cands.values()))
        temas = [cands[v]["tema"] for v in sel]
        self.assertEqual(temas.count("esporte"), 2)
        self.assertEqual(temas.count("politica"), 2)
        self.assertEqual(temas.count("musica"), 2)
        self.assertNotIn("l1", sel)                         # transmissão encerrada
        self.assertFalse({"f1", "f2"} <= set(sel))          # mesmo jogo, canais diferentes
        topo = temas[:curadoria.TOPO]
        for t in set(topo):
            if t not in curadoria.TETO_TEMA:
                self.assertLessEqual(topo.count(t), curadoria.MAX_TEMA_TOPO)
        self.assertEqual(temas.count("Video_game_culture"), 5)  # adiados voltam depois do topo
        self.assertEqual(len(sel), 50)

    def test_pouca_variedade_preenche_mesmo_assim(self):
        cands = {f"h{i}": cand(f"c{i}", "Humour", f"piada{i} esquete{i}") for i in range(30)}
        sel = curadoria.selecionar(list(cands), cands, 50, set())
        self.assertEqual(sel, list(cands))  # sem outros temas, não deixa a fileira vazia

    def test_por_canal(self):
        cands = {f"v{i}": cand("mesmo", "Humour", f"assunto{i} diferente{i}") for i in range(5)}
        sel = curadoria.selecionar(list(cands), cands, 50, set())
        self.assertEqual(len(sel), curadoria.POR_CANAL)


if __name__ == "__main__":
    unittest.main()
