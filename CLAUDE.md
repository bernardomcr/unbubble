# Projeto: Home anti-bolha do YouTube

Contexto para o Claude Code. Dono do projeto: Bernardo (não é programador; explicar decisões técnicas em linguagem simples, implementar, testar e mostrar evidência de que funciona antes de dizer "pronto").

## Objetivo

Substituir a home do YouTube por uma home própria que fure a bolha do algoritmo, combinando três pilares:

1. **Em Alta reconstruído** (o YouTube removeu a página Em Alta em julho de 2025).
2. **Recomendações dos amigos** (o que o algoritmo do YouTube recomenda para cada amigo).
3. **Garimpo** (canais médios em ascensão + vídeos de poucas views, inclusive estrangeiros e antigos).

Formato: **script de Tampermonkey** (um script só para Chrome/Firefox/Edge). Virar extensão oficial só depois que tudo funcionar.

## Arquitetura

- **Coletor (servidor):** GitHub Actions rodando de hora em hora. Faz as buscas, mede views, lê comentários, calcula scores e publica o ranking. Migrar para VPS só se necessário.
- **Banco dos amigos (pilar 2):** Google Apps Script + planilha, protegido por senha do grupo.
- **Script no navegador:** lê o ranking pronto e desenha a home. Também captura a home de cada amigo (pilar 2).
- **Regra de segurança:** se qualquer parte falhar, a home original do YouTube aparece normalmente. Nunca página em branco.

## API do YouTube (fatos verificados em nov/2026)

- **Um único projeto** no Google Cloud. Proibido usar vários projetos para multiplicar cota.
- **Busca (search.list):** bucket próprio, **100 chamadas/dia**, 1 unidade cada. Cada página extra conta como chamada.
- **Demais métodos:** 10.000 unidades/dia. Estatísticas de vídeos (videos.list) custam 1 unidade por até 50 vídeos; existe também `videos.batchGetStats` com bucket próprio de 10.000/dia. Comentários (commentThreads.list) custam 1 unidade por página.
- `order=viewCount` existe, mas com filtro de data pode devolver resultados incompletos: medir quantos resultados cada busca realmente traz.
- `regionCode` = vídeos **assistíveis** no país, não views do país.
- `chart=mostPopular` hoje só traz música, filmes e jogos.
- Desde ago/2026 uma view conta quando o vídeo começa a tocar (inclui autoplay).
- **Política de métricas derivadas:** aceitar a emenda "Analytics & Reporting" no formulário do projeto. Títulos, nomes, descrições e comentários: apagar ou atualizar em até 30 dias. Não substituir as categorias oficiais do YouTube.
- Chave da API sempre como segredo do GitHub, nunca no script do navegador.

## Pilar 1: Em Alta (plano fechado)

**Descoberta (~84 de 100 buscas/dia):**
1. 3 rodadas/dia (manhã, tarde, noite; sem madrugada): geral com e sem filtro de português (2) + as **15 categorias nativas** do YouTube (15). Janela de 6 h; na rodada da manhã, janela de 12 h + página 2 do geral. Total: 53.
2. ~20 tópicos (`topicId`) mais relevantes no Brasil, 1x/dia, janela de 72 h: 20.
3. Lives (`eventType=live`, ordenadas por espectadores): 1 por rodada = 3.
4. Termos do momento (autocompletar do YouTube, Google Trends, X), sem filtro de data, para pegar vídeos antigos que voltaram: 8.
5. Reserva: 16 (para o pilar 3).
- Primeiro dia: varredura completa de 24/48 h para encher o funil.
- Extra: derivados (reacts/cortes que linkam o original) e rankings oficiais restantes.
- Sem lista fixa de canais. Canais encontrados entram num cache automático; uploads novos deles via RSS (testar se o RSS ainda funciona; alternativa: 1 unidade por canal).

**Acompanhamento:** estatísticas de hora em hora de todos os candidatos (~1.500–2.000). Velocidade = diferença entre duas leituras. Usar média de algumas leituras (o contador congela no começo).

**Filtro Shorts (excluir tudo):** vídeo > 3 min passa; ≤ 3 min testar `youtube.com/shorts/ID` (abre = Short, redireciona = vídeo normal).

**Filtro Brasil:**
- Claramente brasileiro (título, descrição, idioma declarado PT-BR, canal do Brasil): sem ler comentários, fator Brasil ≈ 1.
- Estrangeiro: ler comentários 1x; se fração PT-BR passar do corte, entra e passa a ser acompanhado.
- Ambíguo (inclui marcas de PT-PT no título): ler comentários.
- Detecção sem IA: detector de idioma leve + marcadores PT-BR ("você", "a gente", "tá", "né", "pra", "kkkk", "celular", gerúndio "tô fazendo") vs PT-PT ("estou a fazer", "tu és", "fixe", "telemóvel", "autocarro", "ecrã", "equipa", "facto"). Mínimo ~20 comentários.
- Comentários desativados: estrangeiro fica fora.

**Score Em Alta:** log(views BR estimadas/hora) + 0,5·log(fator canal = views ÷ mediana do canal) + bônus de aceleração − penalidade de idade após 48 h. Bônus: explosão de assunto entre canais, engajamento acelerando, ranking oficial. Curadoria: máx. 1–2 por canal, rotatividade. Piso inicial: ~70% da mediana brasileira de entrada no antigo Em Alta (calcular no dataset abaixo). Pesos ajustados depois de 1–2 semanas rodando.

**Calibração:** dataset "Global YouTube Trending Dataset (2022–2025)", DOI 10.13012/B2IDB-9307654 (inclui BR e PT; 4 capturas/dia; views e comentários). Só tem vídeos que entraram no Em Alta: usar para pisos e perfil de entrada, não para teste de acerto. Uso restrito a pesquisa: só extrair números de referência, não redistribuir.

## A nova home (fileiras)

1. **Recomendados** pelo próprio YouTube (lidos da home original antes de substituir; sem Shorts).
2. **Dos seus canais:** vídeos recentes dos inscritos ordenados por desempenho (inclui fator canal). Lista de inscritos lida da conta, sem cota.
3. **Em Alta** (score acima).
4. **Mais vistos (24 h):** views **ganhas** nas últimas 24 h × fator Brasil; máx. 2 por canal.
5. **Categorias nativas:** todos os candidatos coletados redistribuídos por categoria. Mostrar só as que tiverem volume mínimo; o usuário escolhe quais e em que ordem.
6. **Lives:** por espectadores simultâneos.
7. **Dos amigos** (pilar 2).
8. **Garimpo** (pilar 3).

## Pilar 2: amigos (plano fechado)

- Script de cada amigo captura **as recomendações da home**, de forma funda (busca mais lotes pelo mecanismo de continuação interno, ~50–90 por captura), **1x a cada 20 h** na primeira abertura.
- Envia ID, título, canal e duração (lidos da página). Nada de histórico.
- Filtrar na captura: anúncios, prateleiras de Shorts, "continuar assistindo".
- Autoverificação: se a captura vier estranha (poucos vídeos, IDs inválidos), não envia e registra falha. Se todos falharem ao mesmo tempo, avisar Bernardo (e-mail ou Discord) e mostrar aviso na tela dos amigos. Atualização automática do script via `@updateURL` (GitHub).
- Exibição **anônima**. Botão de pausar compartilhamento; lista de canais nunca compartilhados. Amigos guardados como código aleatório no servidor.
- Fileira "Dos amigos" = **vídeos únicos** (vieram de um só amigo). Remover o que o usuário já veria (seus recomendados, inscritos, já assistidos: barra de progresso + registro local de cliques), Shorts e repetidos. Máx. 1–2 por canal.
- Janela: 48 h, estendendo até 7 dias se o estoque estiver baixo. Apagar capturas com mais de 7 dias. Vídeo mostrado 2–3x sem clique sai da fila.
- Medir % de únicos por captura ao longo do tempo (efeito bumerangue).

## Pilar 3: garimpo (esboço, ainda em aberto)

- Uma fileira só, misturando **canais médios em ascensão** e **garimpo de poucas views**.
- Médios em ascensão: buscas estreitas por centenas de temas em português lendo a página de busca (filtro "Esta semana" + "Popularidade", sem cota); temas crescem a partir de títulos/tags achados; reserva de buscas da API; ranking pelo fator canal.
- Garimpo: lista de temas "curiosos" (circo, show de rua, animal treinado, festival de vila, competição esquisita, dança tradicional, invenção caseira…) traduzida para dezenas de línguas; sem filtro de idioma/região; vídeos antigos (ex.: antes de 2016). Filtro "underground mas validado": ~1 mil a algumas centenas de mil views, boa proporção de likes/comentários por view, comentários recentes em vídeo antigo, 1–15 min, descartar títulos tipo "IMG_1234".
- Aprendizado simples pelos cliques do usuário (temas e línguas que rendem ganham peso). Triagem por IA só como opcional futuro.
- Feed de estranhos: descartado.
- Falta decidir: espaço da fileira na home.

## Ordem de execução

1. **Fase 1 (agora):** coletor do pilar 1 no GitHub Actions. Primeiro dia: medir quantos resultados cada busca devolve, testar RSS, testar detecção de Shorts. Definir onde o ranking fica publicado (repo privado, ou repo público publicando só IDs + scores).
2. Rodar 1–2 semanas; Bernardo avalia se o ranking "parece Brasil"; calibrar com o dataset e ajustar pesos.
3. Script de Tampermonkey: nova home com fileiras do pilar 1.
4. Pilar 2 (captura + Apps Script + fileira dos amigos).
5. Pilar 3.
