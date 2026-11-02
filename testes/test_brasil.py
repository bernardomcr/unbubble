"""Testes do filtro Brasil. Rodar com: python -m unittest discover testes"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "coletor"))
import brasil  # noqa: E402


def video(titulo, idioma=None, descricao=""):
    return {"snippet": {"title": titulo, "description": descricao, "defaultAudioLanguage": idioma}}


class TestIdioma(unittest.TestCase):
    def test_idiomas(self):
        self.assertEqual(brasil.idioma("Mano, isso é muito bom kkkk"), "pt")
        self.assertEqual(brasil.idioma("Qué buen video hermano, me encanta jajaja"), "es")
        self.assertEqual(brasil.idioma("This is the best video I have ever seen"), "en")
        self.assertIsNone(brasil.idioma("🔥🔥🔥"))

    def test_variante(self):
        self.assertEqual(brasil.variante("Você tá vendo isso? Tô fazendo agora"), "br")
        self.assertEqual(brasil.variante("Estou a fazer isto no telemóvel, que fixe"), "pt")
        self.assertIsNone(brasil.variante("Isso é muito bom"))


class TestFracao(unittest.TestCase):
    def test_poucos_comentarios(self):
        self.assertIsNone(brasil.fracao_br(["muito bom"] * 5))
        self.assertIsNone(brasil.fracao_br(None))

    def test_brasileiros(self):
        coms = ["Você é demais kkkk"] * 15 + ["Great video"] * 5
        self.assertGreater(brasil.fracao_br(coms), 0.7)

    def test_portugal(self):
        coms = ["Estou a ver isto no autocarro, que fixe"] * 18 + ["Muito bom"] * 2
        self.assertLess(brasil.fracao_br(coms), 0.2)

    def test_estrangeiro(self):
        coms = ["This is the best thing ever"] * 18 + ["muito bom mano"] * 2
        self.assertLess(brasil.fracao_br(coms), brasil.CORTE_ESTRANGEIRO)


class TestClassificar(unittest.TestCase):
    def test_classificar(self):
        self.assertEqual(brasil.classificar(video("Teste", "pt-BR"), None), "br")
        self.assertEqual(brasil.classificar(video("Fiz isso e não acreditei"), None), "br")
        self.assertEqual(brasil.classificar(video("Fiz isto no telemóvel", "pt"), None), "ambiguo")
        self.assertEqual(brasil.classificar(video("Teste", "pt"), "PT"), "ambiguo")
        self.assertEqual(brasil.classificar(video("I tried this and it was the best"), "US"), "estrangeiro")
        self.assertEqual(brasil.classificar(video("Qualquer", None), "BR"), "br")


if __name__ == "__main__":
    unittest.main()
