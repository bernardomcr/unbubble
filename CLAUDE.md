# Projeto: Home anti-bolha do YouTube

Contexto para o Claude Code. Dono do projeto: Bernardo (não é programador; explicar decisões técnicas em linguagem simples, implementar, testar e mostrar evidência de que funciona antes de dizer "pronto").

## Objetivo

Substituir a home do YouTube por uma home própria que fure a bolha do algoritmo.

**Direção principal (decidida em 02/nov/2026): curador pessoal com IA.** Entender o histórico do Bernardo (o que viu, até onde viu, o que clicou), recuperar interesses que o algoritmo do YouTube deixou sumir (ex.: desenho), e sugerir coisas novas que conversam com os gostos dele, sem a fórmula de "vídeos extremamente parecidos". O objetivo é diferente do YouTube: otimizar variedade, redescoberta e o que ele quer, não tempo de tela. Detalhes na seção "Curador pessoal com IA".

Fontes adicionais, como fileiras da home:
1. **Em Alta reconstruído** (o YouTube removeu a página Em Alta em julho de 2025). Já rodando; mantido.
2. **Recomendações dos amigos** (o que o algoritmo do YouTube recomenda para cada amigo). Futuro.
3. **Garimpo** (canais médios em ascensão + vídeos de poucas views, inclusive estrangeiros e antigos). Futuro.

Formato: **script de Tampermonkey** (um script só para Chrome/Firefox/Edge). Virar extensão oficial só depois que tudo funcionar.

**Identidade visual (02/nov/2026):** logo "unbubble" em azul-céu (~`#4FADEA`), letras arredondadas grossas em minúsculas, e um símbolo de bolha tracejada sendo furada por uma agulha. Usar essa cor e esse estilo na home e nas páginas.

## Arquitetura

- **Nada pessoal preso a um PC.** Bernardo usa dois PCs e pode formatar: o PC é só uma "janela"; formatou, instala Tampermonkey + script e cola um token, o resto volta sozinho.
- **Repo público `bernardomcr/unbubble`:** código do script (atualização automática via `@updateURL`), coletor do Em Alta, ranking público (só IDs e números, branch `dados`) e página de avaliação (GitHub Pages, `docs/`).
- **Repo privado `bernardomcr/unbubble-pessoal` (criado em 02/nov/2026, privado):** dados pessoais (histórico resumido, mapa de interesses, cliques/tempo assistido, tema de cada canal, notas de afinidade, gasto da IA) e a **chave da API de IA como segredo**. A IA roda em GitHub Actions desse repo; nenhum PC guarda a chave. Histórico **nunca** vai para o repo público.
- **Script no navegador:** lê o que só existe logado (histórico com barra de progresso, inscritos, curtidas, buscas, chips da home, recomendados), registra cliques e tempo assistido, envia ao repo privado com um token de acesso restrito a ele, e desenha a home a partir do resultado. Cópia local só como cache.
- **Coletor do Em Alta (servidor):** GitHub Actions de hora em hora no repo público. Migrar para VPS só se necessário.
  - O `schedule` (cron) do GitHub **nunca disparou** neste repo (testado em 02/nov/2026). Solução: **corrente de autodisparo** — cada execução espera até o próximo minuto 23 (job `proxima`) e dispara a seguinte com o `GITHUB_TOKEN` (sem segredo extra). Para parar: cancelar a execução em espera. Se a corrente morrer, religar com "Run workflow". Plano C guardado: `apps-script/despertador.gs` (precisa de token do GitHub colado pelo Bernardo).
- **Banco dos amigos (pilar 2, futuro):** Google Apps Script + planilha, protegido por senha do grupo.
- **Regra de segurança:** se qualquer parte falhar (inclusive crédito de IA acabado), a home cai para o modo sem IA ou para a home original do YouTube. Nunca página em branco.

## Curador pessoal com IA (decidido em 02/nov/2026)

**Dados (lidos no navegador, sem cota):** histórico do YouTube (com quanto de cada vídeo foi visto), Google Takeout 1x (histórico completo de anos), inscritos, curtidas, playlists, histórico de buscas, chips da home (os temas do Bernardo na visão do YouTube) e, daqui para frente, o registro do próprio script (cliques, tempo assistido, o que foi mostrado e ignorado).

**Modelos e ritmo:**
| Quando | Modelo | Papel |
|---|---|---|
| 1x/dia, madrugada | Claude Sonnet 5.5 (`claude-sonnet-5-5`) | "Editor do dia": lê mapa + o que foi visto ontem + candidatos pré-filtrados; escolhe os destaques (20–30) com o porquê; propõe 3–5 rumos novos de exploração para o garimpo do dia seguinte |
| 1x/semana | Sonnet 5.5 | "Análise profunda": refaz o mapa de interesses (ativos, adormecidos, vizinhos) e a análise dos inscritos |
| Quando o interesse muda de repente (~5 vídeos seguidos de algo fora do mapa) | Sonnet 5.5 | Atualização extra do mapa |
| Várias vezes/dia | Claude Haiku 5.5 (`claude-haiku-5-5`) | Classifica vídeos e canais novos (tema), dá nota de afinidade, ordena o feed. Cada vídeo/canal é avaliado uma vez e a nota fica guardada |
- Reagir devagar é proposital: o perfil consolida por semana para um dia de maratona não sequestrar a home (é assim que a bolha do YouTube nasce).
- Código preparado para trocar de fornecedor de IA por configuração.

**Orçamento:** até **R$ 25/mês**. Estimativa ~US$ 4/mês (editor diário ~2,5; semanal ~1,3; Haiku ~0,5; inscritos <1). Travas: crédito pré-pago na Anthropic **sem recarga automática** (~US$ 5) + limite de gasto no painel + contador de custo no código (perto do limite, só Haiku; sem crédito, modo sem IA). Usar cache de prompt para a parte repetida (mapa). Medir o custo real na 1ª semana e mostrar ao Bernardo.

**Inscritos, em gavetas** (contagem sem IA: vídeos vistos por canal, última vez, % visto, se o canal ainda posta via RSS):
1. Favoritos ativos. 2. **Esquecidos que valem resgate** (via muito e até o fim, parou, canal segue postando). 3. Canais que pararam ou mudaram. 4. Inscrição por impulso.
A IA entende por que parou, escolhe os vídeos recentes certos e acha canais parecidos.

**Feed em camadas (nunca acaba):**
1. Destaques do dia (Sonnet, 20–30, com explicação).
2. Feed principal: centenas de candidatos do garimpo (interesses adormecidos, apostas novas, canais esquecidos) ordenados pelo Haiku.
3. Fileiras por tema, estilo Netflix ("Desenho", "Ciência", "Jogos — só os melhores").
4. Recomendados do próprio YouTube, com teto por tema (ex.: jogo no máx. 4–5 por bloco), quando o estoque acabar.
5. Em Alta, Mais vistos, Dos seus canais, e no futuro amigos e garimpo.
- Pular também ensina: mostrado ~3x sem clique, recua; clicou e viu até o fim, reforça. Sempre reservar vagas para novidade de verdade.

**Em Alta personalizado (sem virar bolha):** os 5–10 primeiros do Em Alta ficam fixos (o que o Brasil está vendo); do resto, o Haiku dá nota de afinidade com o mapa e os de afinidade alta sobem; os de afinidade baixa descem, não somem. Mesma lógica nos Mais vistos 24 h. Roda no repo privado lendo o ranking público. O editor diário pode puxar 2–3 do Em Alta para os destaques.

**Limites assumidos:** não prevemos o próximo clique melhor que o YouTube; ganhamos no objetivo (variedade/redescoberta) e na explicação. A IA julga por título, descrição, canal e comportamento (legendas só em casos pontuais). O YouTube muda a página às vezes: o script precisa de manutenção. Dados vão para a API da Anthropic (que, pela política dela, não usa dados da API para treino por padrão).

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

**Descoberta (71 de 100 buscas/dia; revisado em 02/nov/2026 após diagnóstico):**
Buscas usam filtro de duração (`videoDuration`) para não gastar resultados com Shorts: `medium` = 4–20 min, `long` = > 20 min.
1. Geral com e sem filtro de português, cada um em médio e longo, 3 rodadas/dia (manhã, tarde, noite; sem madrugada): 12.
2. As **14 categorias nativas** do YouTube, só médio, 2 rodadas/dia (manhã com janela de 12 h; noite com janela de 12 h): 28. Longo por categoria fica de fora (a geral de longos já pega os maiores).
3. ~20 tópicos (`topicId`) mais relevantes no Brasil, 1x/dia, janela de 72 h: 20.
4. Lives (`eventType=live`, ordenadas por espectadores, sem filtro de duração): 1 por rodada = 3.
5. Termos do momento (autocompletar do YouTube, Google Trends, X), sem filtro de data, para pegar vídeos antigos que voltaram: 8.
6. Reserva: 29 (pilar 3 e imprevistos).
- Vídeos normais com menos de 4 min ficam de fora das buscas com filtro (3–5 por busca no teste); eles chegam pelo RSS dos canais do cache.

**Diagnóstico do primeiro dia (02/nov/2026, janela de 24 h, Brasil):**
- Todas as buscas com `order=viewCount` + filtro de data vieram cheias (50 resultados, com página 2). Nenhum resultado fora da janela.
- São **14** categorias atribuíveis no Brasil (1, 2, 10, 15, 17, 19, 20, 22, 23, 24, 25, 26, 27, 28), não 15.
- Sem filtro de duração, a maioria dos resultados tem até 3 min (geral: 42/50), e ~85% desses são Shorts (68/80 testados): sobram só 10–37 vídeos normais por busca. Com filtro, 50 de 50.
- Busca de **longos** traz muito mais conteúdo brasileiro (geral: 26/50 com idioma PT; geral + português: 37/50).
- Sem filtro, só ~25% declaram idioma PT (`regionCode=BR` = assistível, não brasileiro): o filtro Brasil é essencial.
- RSS dos canais funciona a partir do GitHub Actions (10/10). Teste de Shorts via `youtube.com/shorts/ID` também (0 indefinidos em 80); o link do RSS também indica se é Short.
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

**Score Em Alta:** log(views BR estimadas/hora) + 0,5·log(fator canal = views ÷ mediana do canal) + bônus de aceleração − penalidade de idade após 48 h. Bônus: explosão de assunto entre canais, engajamento acelerando, ranking oficial. Curadoria: máx. 1–2 por canal, rotatividade.

**Curadoria de variedade (decidida em 02/nov/2026, após 1ª avaliação do Bernardo: "muito esporte"):**
- Teto no Em Alta: **esporte, política/notícias e música no máximo 2 cada** (continuam completos nas fileiras das categorias). Demais temas: livres, mas no topo 20 nenhum tema passa de 3.
- Tema pela classificação de assunto do YouTube (`topicDetails`), com a categoria como reforço (17 = esporte, 25 = política, 10 = música).
- **Um vídeo por assunto:** mesmo jogo/acontecimento em vários canais conta uma vez (≥ 2 palavras raras do título em comum; só códigos das palavras ficam guardados).
- Transmissões ao vivo já encerradas ficam fora do Em Alta.
- Fator canal com peso 1,0 (era 0,5), comparando com o esperado para a idade do vídeo: favorece vídeo muito acima do normal do canal, como o antigo Em Alta. Piso inicial: ~70% da mediana brasileira de entrada no antigo Em Alta (calcular no dataset abaixo). Pesos ajustados depois de 1–2 semanas rodando.

**Calibração:** dataset "Global YouTube Trending Dataset (2022–2025)", DOI 10.13012/B2IDB-9307654 (inclui BR e PT; 4 capturas/dia; views e comentários). Só tem vídeos que entraram no Em Alta: usar para pisos e perfil de entrada, não para teste de acerto. Uso restrito a pesquisa: só extrair números de referência, não redistribuir.

## A nova home (fileiras)

1. **Recomendados** pelo próprio YouTube (lidos da home original antes de substituir; sem Shorts).
2. **Dos seus canais:** vídeos recentes dos inscritos ordenados por desempenho (inclui fator canal). Lista de inscritos lida da conta, sem cota.
3. **Em Alta** (score acima).
4. **Mais vistos (24 h):** views **ganhas** nas últimas 24 h × fator Brasil; máx. 2 por canal.
5. **Categorias nativas** (14 no Brasil): todos os candidatos coletados redistribuídos por categoria. Mostrar só as que tiverem volume mínimo; o usuário escolhe quais e em que ordem.
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

1. ~~Fase 1: coletor do Em Alta no GitHub Actions~~ (feito em 02/nov/2026: ranking público, página https://bernardomcr.github.io/unbubble/, curadoria de variedade). Segue rodando sozinho; calibração com o dataset fica para depois.
2. ~~Conta da API da Anthropic~~ (feito: crédito US$ 5 sem recarga, chave `ANTHROPIC_API_KEY` no repo privado).
3. **Raio-x da conta** (1ª versão feita em 02/nov/2026; **aguardando Bernardo avaliar** o relatório `relatorios/raiox.md` do repo privado). Captura feita no navegador do app (YouTube logado), pela API interna `/youtubei/v1/browse` (FEhistory, FEchannels, VLLL) rodando numa página sem CSP do youtube.com (`/robots.txt`) e enviando a um receptor local; dados em `dados/raiox/` do repo privado; o workflow `raiox.yml` gera o relatório com Sonnet (esforço médio; ~110 mil tokens de entrada, ~US$ 0,28). O histórico visível vai só até mar/2025 (~33 mil itens, 2/3 Shorts); Takeout pedido para buscas e anos anteriores. Lições: Sonnet com `max_tokens` 16 mil gastou tudo pensando (relatório vazio, US$ 0,51) → usar 32 mil + esforço médio + checar `stop_reason`. Pendências apontadas pelo relatório: lives/Shorts repetidos inflam o "100% visto"; trechos infantis podem ser de outra pessoa na conta. Depois: virar script de Tampermonkey para recapturar sozinho.
4. Primeira fileira na home: **Dos seus canais** (favoritos + esquecidos voltando). **Feito em 02/nov/2026:** script `tampermonkey/unbubble.user.js` (v0.2) desenha a fileira no topo da home lendo `saida/home.json` do repo privado (token fine-grained do Bernardo, só `unbubble-pessoal`, Contents + Actions leitura/escrita); gavetas por contagem (favorito: >=3 vistos até o fim e >=3 nos últimos 60 dias; esquecido: >=3 até o fim e 0 nos últimos 60 dias); vídeos dos últimos 14 dias pelo RSS, sem Shorts e sem já vistos, 1 vaga de esquecido a cada 3, máx. 2 por canal. O script também captura histórico (30 páginas), inscritos e curtidas a cada 20 h e envia para `dados/captura/ultima.json`; o workflow `home.yml` junta ao histórico (`ia/mesclar.py`, datas absolutas) e refaz a fileira. Testar mudanças do script no navegador do app: injetar o código com imitações das funções GM_ (o app não tem Tampermonkey). **Fuso:** a API interna agrupa o histórico por dia no fuso do contexto; sem `timeZone: America/Sao_Paulo` no contexto ela usa outro fuso e os vídeos da noite caem no dia seguinte (bug de 02/nov/2026, histórico recapturado). A junção (`mesclar.py`) confia na captura nova para todo o período que ela cobre, menos o dia mais antigo (que vem cortado). Relatório Sonnet (`raiox.yml`) só roda à mão.
5. Editor diário + feed em camadas + teto por tema nos recomendados do YouTube + Em Alta personalizado.
   - **Teto por tema (feito em 02/nov/2026, script v0.3):** o Haiku classifica canais do histórico (até 600 por rodada, 6 títulos cada) e os recomendados que o script manda em `dados/fila/pendentes.json` (workflow `temas.yml` → `saida/temas.json`; gasto em `dados/gasto_ia.json`). 17 temas fixos em `ia/temas.py`. No navegador: em qualquer janela de 10 recomendados, no máx. jogos 4, política 2, IA/tecnologia 2, lixo de algoritmo 0, e 2 do mesmo canal; tema do vídeo primeiro, senão o do canal; decisão fixa por página (não pisca). Shorts, anúncios e playables ficam de fora da conta. Canal lido do link `/@` da 1ª linha de metadados.
   - **Em Alta personalizado (feito em 02/nov/2026, script v0.4):** `ia/em_alta.py` (chamado pelo `home.py`) lê o ranking público, pega título/canal pelo oEmbed (cache 7 dias em `dados/cache_oembed.json`), tira os já vistos, e o Haiku dá nota 0–10 de afinidade com o mapa (seções 1, 2, 3 e 5 do `relatorios/raiox.md`), uma vez por vídeo (`saida/afinidade.json`). Os 6 primeiros ficam fixos; o resto anda 3 posições por ponto acima/abaixo de 5; nota >= 8 ganha selo "pra você". Mesma lógica nos Mais vistos 24 h. O agendamento do repo privado também não dispara: o script pede atualização quando o home.json tem mais de 1 h.
6. Pilar 2 (amigos) e pilar 3 (garimpo).
