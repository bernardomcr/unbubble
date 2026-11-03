// ==UserScript==
// @name         unbubble
// @namespace    https://github.com/bernardomcr/unbubble
// @version      0.8.0
// @description  Home anti-bolha do YouTube: fileiras (seus canais, Em Alta, Mais vistos, temas e categorias), Não tenho interesse, teto por tema nos recomendados e captura do histórico.
// @match        https://www.youtube.com/*
// @noframes
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      api.github.com
// @updateURL    https://raw.githubusercontent.com/bernardomcr/unbubble/main/tampermonkey/unbubble.user.js
// @downloadURL  https://raw.githubusercontent.com/bernardomcr/unbubble/main/tampermonkey/unbubble.user.js
// ==/UserScript==

/*
 * Regra de segurança: qualquer falha => não mexe na página (a home original do YouTube fica como está).
 * Dados pessoais vêm do repo privado bernardomcr/unbubble-pessoal, lidos com um token fine-grained
 * (só esse repo; Contents e Actions: leitura e escrita) guardado no Tampermonkey, nunca no código.
 */
(function () {
  'use strict';

  const REPO = 'bernardomcr/unbubble-pessoal';
  const CACHE_MIN = 10;            // relê o home.json do GitHub no máximo a cada 10 min
  const VELHO_H = 1;               // home.json mais velho que isso => pede ao GitHub para refazer (o Em Alta muda de hora em hora)
  const INTERVALO_DISPARO_H = 1;   // no máximo um pedido de refazer por hora
  const COR = '#4FADEA';
  const CAPTURA_H = 20;            // captura histórico/inscritos/curtidas no máximo a cada 20 h
  const PAGINAS_HISTORICO = 30;    // ~1 mês de histórico por captura (o resto já está no repo)

  const agora = () => Date.now();
  const log = (...a) => console.log('[unbubble]', ...a);

  // ---------- GitHub ----------
  function github(metodo, caminho, corpo, { json = false, tempo = 15000 } = {}) {
    const token = GM_getValue('token', '');
    return new Promise((ok, falha) => {
      if (!token) return falha(new Error('sem token'));
      GM_xmlhttpRequest({
        method: metodo,
        url: `https://api.github.com/repos/${REPO}/${caminho}`,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: json ? 'application/vnd.github+json' : 'application/vnd.github.raw+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(corpo ? { 'Content-Type': 'application/json' } : {}),
        },
        data: corpo ? JSON.stringify(corpo) : undefined,
        timeout: tempo,
        onload: r => (r.status >= 200 && r.status < 300 ? ok(r.responseText) : falha(new Error(`GitHub ${r.status}`))),
        onerror: () => falha(new Error('rede')),
        ontimeout: () => falha(new Error('tempo esgotado')),
      });
    });
  }

  async function lerHome() {
    const cache = GM_getValue('home_cache', null);
    if (cache && agora() - cache.lido_em < CACHE_MIN * 60e3) return cache.home;
    try {
      const home = JSON.parse(await github('GET', 'contents/saida/home.json'));
      GM_setValue('home_cache', { lido_em: agora(), home });
      pedirAtualizacaoSeVelho(home);
      return home;
    } catch (e) {
      log('não consegui ler o home.json:', e.message);
      return cache ? cache.home : null;  // sem rede: usa o que tiver
    }
  }

  function pedirAtualizacaoSeVelho(home) {
    const idadeH = (agora() - Date.parse(home.gerado_em)) / 36e5;
    const ultimo = GM_getValue('ultimo_disparo', 0);
    if (idadeH < VELHO_H || agora() - ultimo < INTERVALO_DISPARO_H * 36e5) return;
    GM_setValue('ultimo_disparo', agora());
    github('POST', 'actions/workflows/home.yml/dispatches', { ref: 'main' })
      .then(() => log('pedi ao GitHub para atualizar a home'))
      .catch(e => log('não consegui pedir atualização:', e.message));
  }

  // ---------- Captura (histórico com % assistido, inscritos, curtidas) ----------
  // Usa a mesma API interna que a página do YouTube usa, com o login do próprio navegador. Sem cota.
  const achar = (o, k, out = []) => {
    if (o && typeof o === 'object') for (const [kk, v] of Object.entries(o)) { if (kk === k) out.push(v); achar(v, k, out); }
    return out;
  };

  async function sha1(s) {
    const b = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
    return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
  }

  const browse = corpo => api('browse', corpo);

  async function api(endpoint, corpo) {
    const ytcfg = unsafeWindow.ytcfg;
    const sapisid = (document.cookie.match(/(?:^|; )(?:SAPISID|__Secure-3PAPISID)=([^;]+)/) || [])[1];
    if (!ytcfg || !sapisid) throw new Error('YouTube sem login ou sem configuração');
    const ts = Math.floor(agora() / 1000);
    const r = await fetch(`/youtubei/v1/${endpoint}?prettyPrint=false`, {
      method: 'POST', credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `SAPISIDHASH ${ts}_${await sha1(`${ts} ${sapisid} ${location.origin}`)}`,
        'X-Origin': location.origin,
        'X-Goog-AuthUser': String(ytcfg.get('SESSION_INDEX') ?? 0),
        'X-Youtube-Client-Name': '1',
        'X-Youtube-Client-Version': ytcfg.get('INNERTUBE_CLIENT_VERSION'),
      },
      body: JSON.stringify({ context: ytcfg.get('INNERTUBE_CONTEXT'), ...corpo }),
    });
    if (!r.ok) throw new Error(`YouTube ${r.status}`);
    return r.json();
  }

  function itemLockup(l) {
    const md = l.metadata?.lockupMetadataViewModel;
    if (!md) return null;
    const partes = achar(md.metadata, 'metadataParts').flat();
    const be = achar(md.image, 'browseEndpoint')[0] || achar(md, 'browseEndpoint')[0] || {};
    const prog = achar(l.contentImage, 'thumbnailOverlayProgressBarViewModel')[0];
    const selo = achar(l.contentImage, 'thumbnailBadgeViewModel').map(b => b.text).filter(Boolean)[0];
    return { id: l.contentId, tipo: l.contentType, titulo: md.title?.content, canal: partes[0]?.text?.content,
             canal_id: be.browseId, duracao: selo, visto_pct: prog ? prog.startPercent : null };
  }

  const proximo = j => achar(j, 'continuationItemRenderer')
    .map(c => achar(c, 'continuationCommand')[0]?.token).filter(Boolean).pop();
  const pausa = () => new Promise(r => setTimeout(r, 400));

  async function lista(browseId, extrair, max) {
    const itens = [];
    let j = await browse({ browseId });
    for (let i = 0; i < max; i++) {
      itens.push(...extrair(j));
      const tok = proximo(j);
      if (!tok) break;
      await pausa();
      j = await browse({ continuation: tok });
    }
    return itens;
  }

  async function historico() {
    const itens = [];
    let secao = null, j = await browse({ browseId: 'FEhistory' });
    for (let i = 0; i < PAGINAS_HISTORICO; i++) {
      for (const s of achar(j, 'itemSectionRenderer')) {
        const h = s.header?.itemSectionHeaderRenderer?.title;
        if (h) secao = h.simpleText ?? h.runs?.map(r => r.text).join('');
        for (const l of achar(s, 'lockupViewModel')) { const it = itemLockup(l); if (it) itens.push({ ...it, dia: secao }); }
        for (const sh of achar(s, 'shortsLockupViewModel')) {
          itens.push({ id: achar(sh, 'videoId')[0], tipo: 'SHORT', titulo: sh.overlayMetadata?.primaryText?.content, dia: secao });
        }
      }
      const tok = achar(j, 'continuationCommand')[0]?.token;
      if (!tok) break;
      await pausa();
      j = await browse({ continuation: tok });
    }
    return itens;
  }

  async function capturar() {
    const vistos = new Set();
    const inscritos = await lista('FEchannels', j => achar(j, 'channelRenderer')
      .filter(c => !vistos.has(c.channelId) && vistos.add(c.channelId))
      .map(c => ({ canal_id: c.channelId, nome: c.title?.simpleText, handle: c.subscriberCountText?.simpleText,
                   inscritos: c.videoCountText?.simpleText,
                   descricao: (c.descriptionSnippet?.runs || []).map(r => r.text).join('').slice(0, 300) })), 50);
    const curtidas = await lista('VLLL', j => achar(j, 'lockupViewModel').map(itemLockup).filter(Boolean), 100);
    const hist = await historico();
    return { capturado_em: new Date().toISOString(), versao: GM_info?.script?.version, historico: hist, inscritos, curtidas };
  }

  function capturaEstranha(c) {
    const valido = id => /^[\w-]{11}$/.test(id || '');
    if (c.historico.length < 20) return `histórico com só ${c.historico.length} itens`;
    if (c.historico.filter(i => !valido(i.id)).length > c.historico.length * 0.05) return 'muitos IDs inválidos';
    if (!c.historico.some(i => i.dia)) return 'histórico sem datas';
    return null;
  }

  function base64(texto) {
    const bytes = new TextEncoder().encode(texto);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  async function enviarCaptura(c) {
    const caminho = 'contents/dados/captura/ultima.json';
    let sha;
    try { sha = JSON.parse(await github('GET', caminho, null, { json: true })).sha; } catch (e) { /* ainda não existe */ }
    await github('PUT', caminho, {
      message: `Captura do navegador (${c.historico.length} itens do histórico)`,
      content: base64(JSON.stringify(c)), ...(sha ? { sha } : {}),
    }, { json: true, tempo: 120000 });
  }

  let capturando = false;
  async function capturarSeHora(forcar = false) {
    if (capturando || !GM_getValue('token', '')) return;
    if (!forcar && agora() - GM_getValue('ultima_captura', 0) < CAPTURA_H * 36e5) return;
    capturando = true;
    GM_setValue('ultima_captura', agora());  // marca antes: se falhar, tenta de novo só na próxima janela
    try {
      const c = await capturar();
      const problema = capturaEstranha(c);
      if (problema) throw new Error(`captura estranha, não enviada: ${problema}`);
      await enviarCaptura(c);
      GM_setValue('captura_status', { em: agora(), ok: true, itens: c.historico.length });
      log(`captura enviada: ${c.historico.length} itens do histórico, ${c.inscritos.length} inscritos, ${c.curtidas.length} curtidas`);
    } catch (e) {
      GM_setValue('captura_status', { em: agora(), ok: false, erro: String(e.message || e) });
      log('captura falhou:', e);
    } finally {
      capturando = false;
    }
  }

  // ---------- Uso: o que foi mostrado e o que foi clicado nas nossas fileiras (para aprender) ----------
  // Mostrado = o vídeo ficou visível na tela (conta 1 vez por abertura da home). Vai para dados/uso/eventos.json
  // a cada hora, juntando com o que já estiver lá (os dois PCs somam). O GitHub tira o que foi ignorado ~3 vezes
  // e dá mais espaço ao rumo em que ele clica; o Sonnet da semana vê o desempenho de cada rumo.
  const ENVIO_USO_MIN = 60;
  const GUARDA_USO_DIAS = 30;
  const mostradosNestaPagina = new Set();

  function registrarClique(item, fileira) {
    const cliques = GM_getValue('cliques', []);
    cliques.push({ id: item.id, titulo: item.titulo || '', canal: item.canal || '', canal_id: item.canal_id || '',
                   fileira, motivo: item.motivo || '', em: new Date().toISOString() });
    GM_setValue('cliques', cliques.slice(-2000));
    GM_setValue('uso_novo', true);
  }

  function registrarMostrado(id, fileira) {
    if (fileira.startsWith('yt_') || mostradosNestaPagina.has(id)) return;  // só as nossas fileiras
    mostradosNestaPagina.add(id);
    const m = GM_getValue('mostrados', {});
    const hoje = new Date().toISOString().slice(0, 10);
    const r = m[id] || { n: 0, fileira, primeiro: hoje };
    r.n++; r.ultimo = hoje; r.fileira = fileira;
    m[id] = r;
    GM_setValue('mostrados', m);
    GM_setValue('uso_novo', true);
  }

  const olhoDaTela = new IntersectionObserver(entradas => {
    for (const e of entradas) {
      if (!e.isIntersecting) continue;
      olhoDaTela.unobserve(e.target);
      registrarMostrado(e.target.dataset.id, e.target.dataset.fileira);
    }
  }, { threshold: 0.6 });

  async function enviarUsoSeHora() {
    if (!GM_getValue('token', '') || !GM_getValue('uso_novo', false)) return;  // nada novo: não refaz a home à toa
    if (agora() - GM_getValue('ultimo_envio_uso', 0) < ENVIO_USO_MIN * 60e3) return;
    GM_setValue('ultimo_envio_uso', agora());
    GM_setValue('uso_novo', false);
    const caminho = 'contents/dados/uso/eventos.json';
    let sha, remoto = { cliques: [], mostrados: {} };
    try {
      const r = JSON.parse(await github('GET', caminho, null, { json: true }));
      sha = r.sha;
      remoto = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(r.content.replace(/\n/g, '')), c => c.charCodeAt(0))));
    } catch (e) { /* ainda não existe */ }
    const limite = new Date(agora() - GUARDA_USO_DIAS * 864e5).toISOString();
    const cliques = new Map();
    for (const c of [...(remoto.cliques || []), ...GM_getValue('cliques', [])]) if (c.em >= limite) cliques.set(`${c.id}|${c.em}`, c);
    const mostrados = { ...(remoto.mostrados || {}) };
    for (const [id, r] of Object.entries(GM_getValue('mostrados', {}))) {
      const o = mostrados[id];
      mostrados[id] = o ? { ...r, n: Math.max(o.n, r.n), primeiro: o.primeiro < r.primeiro ? o.primeiro : r.primeiro,
                            ultimo: o.ultimo > r.ultimo ? o.ultimo : r.ultimo } : r;
    }
    for (const [id, r] of Object.entries(mostrados)) if (r.ultimo < limite.slice(0, 10)) delete mostrados[id];
    const uso = { atualizado_em: new Date().toISOString(), cliques: [...cliques.values()].sort((a, b) => (a.em < b.em ? -1 : 1)), mostrados };
    await github('PUT', caminho, {
      message: `Uso das fileiras (${uso.cliques.length} cliques, ${Object.keys(mostrados).length} mostrados)`,
      content: base64(JSON.stringify(uso)), ...(sha ? { sha } : {}),
    }, { json: true, tempo: 30000 });
    GM_setValue('cliques', uso.cliques);   // agora o navegador tem também o do outro PC
    GM_setValue('mostrados', mostrados);
    log(`uso enviado: ${uso.cliques.length} cliques, ${Object.keys(mostrados).length} mostrados`);
  }

  // ---------- "Não tenho interesse" ----------
  // Fica guardado no navegador e vai para dados/feedback/nao_interesse.json do repo privado
  // (junta com o que já estiver lá, para os dois PCs somarem). O GitHub refaz as fileiras e o Haiku
  // passa a dar nota baixa para coisas parecidas.
  const ENVIO_RECUSAS_S = 15;
  const chaveRecusa = r => (r.tipo === 'canal' ? `c:${r.canal}` : `v:${r.id}`);
  const bloq = { videos: new Set(), canais: new Set() };

  function carregarBloqueios(home) {
    for (const v of home?.bloqueios?.videos || []) bloq.videos.add(v);
    for (const c of home?.bloqueios?.canais || []) bloq.canais.add(c);
    const desfeitas = new Set(GM_getValue('recusas_desfeitas', []));
    for (const r of GM_getValue('recusas', [])) {
      if (r.tipo === 'canal') bloq.canais.add(r.canal); else bloq.videos.add(r.id);
    }
    for (const k of desfeitas) { if (k.startsWith('c:')) bloq.canais.delete(k.slice(2)); else bloq.videos.delete(k.slice(2)); }
  }
  const bloqueado = it => bloq.videos.has(it.id) || bloq.canais.has(it.canal);

  function recusar(item, tipo, fileira) {
    const r = { id: item.id, titulo: item.titulo || '', canal: item.canal || '', tipo, fileira, em: new Date().toISOString() };
    const k = chaveRecusa(r);
    GM_setValue('recusas', [...GM_getValue('recusas', []).filter(x => chaveRecusa(x) !== k), r]);
    GM_setValue('recusas_desfeitas', GM_getValue('recusas_desfeitas', []).filter(x => x !== k));
    if (tipo === 'canal') bloq.canais.add(r.canal); else bloq.videos.add(r.id);
    agendarEnvioRecusas();
    return k;
  }

  function desfazerRecusa(k) {
    GM_setValue('recusas', GM_getValue('recusas', []).filter(x => chaveRecusa(x) !== k));
    GM_setValue('recusas_desfeitas', [...new Set([...GM_getValue('recusas_desfeitas', []), k])]);
    if (k.startsWith('c:')) bloq.canais.delete(k.slice(2)); else bloq.videos.delete(k.slice(2));
    agendarEnvioRecusas();
  }

  let esperaRecusas = null;
  function agendarEnvioRecusas() {
    clearTimeout(esperaRecusas);
    esperaRecusas = setTimeout(() => enviarRecusas().catch(e => log('não consegui mandar as recusas:', e.message)),
      ENVIO_RECUSAS_S * 1000);
  }

  async function enviarRecusas() {
    const caminho = 'contents/dados/feedback/nao_interesse.json';
    let sha, remotas = [];
    try {
      const r = JSON.parse(await github('GET', caminho, null, { json: true }));
      sha = r.sha;
      const bytes = Uint8Array.from(atob(r.content.replace(/\n/g, '')), c => c.charCodeAt(0));
      remotas = JSON.parse(new TextDecoder().decode(bytes)).itens || [];
    } catch (e) { /* ainda não existe */ }
    const desfeitas = new Set(GM_getValue('recusas_desfeitas', []));
    const juntas = new Map();
    for (const r of [...remotas, ...GM_getValue('recusas', [])]) juntas.set(chaveRecusa(r), r);
    for (const k of desfeitas) juntas.delete(k);
    const itens = [...juntas.values()].sort((a, b) => (a.em < b.em ? -1 : 1));
    await github('PUT', caminho, {
      message: `Não tenho interesse (${itens.length})`,
      content: base64(JSON.stringify({ atualizado_em: new Date().toISOString(), itens }, null, 1)), ...(sha ? { sha } : {}),
    }, { json: true, tempo: 30000 });
    GM_setValue('recusas', itens);  // agora o navegador tem também as do outro PC
    GM_setValue('recusas_desfeitas', []);
    GM_setValue('home_cache', null);  // a próxima abertura já pega as fileiras refeitas
    log(`recusas enviadas: ${itens.length}`);
  }

  // ---------- Desenho ----------
  const CSS = `
    #unbubble { --ub-texto: #0f0f0f; --ub-texto2: #606060; --ub-fundo-capa: #e5e5e5;
      --ub-botao: #ffffff; --ub-menu: #ffffff; --ub-hover: rgba(0,0,0,.08);
      align-self: stretch; min-width: 0; box-sizing: border-box; margin: 16px 0 24px;
      font-family: Roboto, Arial, sans-serif; }
    html[dark] #unbubble { --ub-texto: #f1f1f1; --ub-texto2: #aaaaaa; --ub-fundo-capa: #272727;
      --ub-botao: #212121; --ub-menu: #282828; --ub-hover: rgba(255,255,255,.1); }
    #unbubble .ub-cab { display: flex; align-items: center; gap: 10px; margin: 0 0 18px; }
    #unbubble .ub-titulo { font-size: 2rem; line-height: 2.8rem; font-weight: 700; color: var(--ub-texto); margin: 0; }
    #unbubble .ub-marca { font-size: 1.2rem; font-weight: 700; color: ${COR}; letter-spacing: .02em; }
    #unbubble .ub-bolha { width: 12px; height: 12px; border: 2px dashed ${COR}; border-radius: 50%; flex: none; }
    #unbubble .ub-fileira { margin: 0 0 40px; }
    #unbubble .ub-linha { position: relative; }
    #unbubble .ub-trilho { display: grid; grid-auto-flow: column; grid-auto-columns: 260px;
      gap: 16px; overflow-x: auto; scroll-snap-type: x proximity; scrollbar-width: none; }
    #unbubble .ub-trilho::-webkit-scrollbar { display: none; }
    #unbubble .ub-seta { position: absolute; top: 73px; transform: translateY(-50%); z-index: 3;
      width: 40px; height: 40px; border-radius: 50%; border: 0; padding: 0; cursor: pointer;
      background: var(--ub-botao); color: var(--ub-texto); display: flex; align-items: center; justify-content: center;
      box-shadow: 0 4px 4px rgba(0,0,0,.3), 0 0 4px rgba(0,0,0,.2);
      opacity: 0; pointer-events: none; transition: opacity .2s; }
    #unbubble .ub-seta svg { width: 24px; height: 24px; fill: currentColor; pointer-events: none; }
    #unbubble .ub-seta.dir { right: -20px; }
    #unbubble .ub-seta.esq { left: -20px; }
    #unbubble .ub-seta.esq svg { transform: scaleX(-1); }
    #unbubble .ub-seta.dir.ativa, #unbubble .ub-linha:hover .ub-seta.esq.ativa { opacity: 1; pointer-events: auto; }
    #unbubble .ub-card { scroll-snap-align: start; min-width: 0; position: relative; }
    #unbubble .ub-card a { text-decoration: none; color: inherit; }
    #unbubble .ub-capa { display: block; position: relative; aspect-ratio: 16 / 9; border-radius: 12px; overflow: hidden;
      background: var(--ub-fundo-capa); }
    #unbubble .ub-capa img { width: 100%; height: 100%; object-fit: cover; display: block; }
    #unbubble .ub-selo { position: absolute; left: 8px; top: 8px; background: ${COR}; color: #fff;
      font-size: 1.1rem; font-weight: 700; padding: 2px 8px; border-radius: 999px; }
    #unbubble .ub-info { display: flex; gap: 4px; align-items: flex-start; }
    #unbubble .ub-textos { flex: 1; min-width: 0; }
    #unbubble .ub-nome { font-size: 1.4rem; font-weight: 500; line-height: 2rem; margin: 10px 0 2px;
      color: var(--ub-texto); display: -webkit-box; -webkit-line-clamp: 2;
      -webkit-box-orient: vertical; overflow: hidden; }
    #unbubble .ub-meta { font-size: 1.2rem; line-height: 1.8rem; color: var(--ub-texto2);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #unbubble .ub-porque { white-space: normal; color: ${COR}; display: -webkit-box; -webkit-line-clamp: 2;
      -webkit-box-orient: vertical; }
    #unbubble .ub-mais { flex: none; width: 32px; height: 32px; margin-top: 6px; border-radius: 50%; border: 0;
      background: transparent; color: var(--ub-texto); cursor: pointer; padding: 0; opacity: 0;
      display: flex; align-items: center; justify-content: center; }
    #unbubble .ub-mais svg { width: 20px; height: 20px; fill: currentColor; }
    #unbubble .ub-card:hover .ub-mais, #unbubble .ub-mais.aberto { opacity: 1; }
    #unbubble .ub-mais:hover { background: var(--ub-hover); }
    #unbubble .ub-menu { position: fixed; z-index: 2300; min-width: 230px;
      background: var(--ub-menu); border-radius: 12px; padding: 8px 0; box-shadow: 0 4px 32px rgba(0,0,0,.25); }
    #unbubble .ub-menu div { padding: 0 16px; height: 36px; display: flex; align-items: center;
      font-size: 1.4rem; color: var(--ub-texto); cursor: pointer; white-space: nowrap; }
    #unbubble .ub-menu div:hover { background: var(--ub-hover); }
    #unbubble .ub-removido { aspect-ratio: 16 / 9; border-radius: 12px; background: var(--ub-fundo-capa);
      display: flex; flex-direction: column; justify-content: center; align-items: flex-start; gap: 10px;
      padding: 16px; box-sizing: border-box; font-size: 1.3rem; line-height: 1.8rem; color: var(--ub-texto); }
    #unbubble .ub-removido button { background: transparent; color: ${COR}; padding: 0; font-size: 1.4rem; }
    #unbubble .ub-aviso { font-size: 1.4rem; color: var(--ub-texto2); }
    #unbubble button { background: ${COR}; color: #fff; border: 0; border-radius: 999px; padding: 6px 14px;
      font-size: 1.3rem; font-weight: 600; cursor: pointer; }
    #unbubble button.ub-seta, #unbubble button.ub-mais { background: var(--ub-botao); }
    #unbubble button.ub-mais { background: transparent; }
  `;

  // Ícones montados peça por peça: o YouTube proíbe innerHTML (Trusted Types) e o script inteiro falhava.
  const SVG_SETA = 'M9.4 18.4l-.7-.7 5.6-5.6-5.7-5.7.7-.7 6.4 6.4-6.3 6.3z';
  const SVG_MAIS = '"M12 16.5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5-1.5-.67-1.5-1.5.67-1.5 1.5-1.5zM10.5 12c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5-.67-1.5-1.5-1.5-1.5.67-1.5 1.5zm0-6c0 .83.67 1.5 1.5 1.5s1.5-.67 1.5-1.5-.67-1.5-1.5-1.5-1.5.67-1.5 1.5z';
  function icone(d) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.append(path);
    return svg;
  }

  function el(tag, attrs = {}, ...filhos) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const f of filhos) e.append(f);
    return e;
  }

  function quando(publicado) {
    const d = Math.floor((agora() - Date.parse(publicado)) / 864e5);
    return d <= 0 ? 'hoje' : d === 1 ? 'ontem' : `há ${d} dias`;
  }

  function views(n) {
    if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace('.', ',')} mi de visualizações`;
    if (n >= 1e3) return `${Math.round(n / 1e3)} mil visualizações`;
    return `${n} visualizações`;
  }

  let menuAberto = null;
  function fecharMenu() {
    menuAberto?.menu.remove();
    menuAberto?.botao.classList.remove('aberto');
    menuAberto = null;
  }
  document.addEventListener('click', e => { if (menuAberto && !menuAberto.menu.contains(e.target)) fecharMenu(); }, true);
  window.addEventListener('scroll', () => fecharMenu(), { passive: true });
  document.addEventListener('scroll', e => { if (e.target?.classList?.contains('ub-trilho')) fecharMenu(); }, { capture: true, passive: true });

  function card(item, fileira) {
    const capa = el('a', { class: 'ub-capa', href: `/watch?v=${item.id}`, onclick: () => registrarClique(item, fileira) },
      el('img', { src: `https://i.ytimg.com/vi/${item.id}/mqdefault.jpg`, alt: '', loading: 'lazy' }));
    if (item.motivo === 'esquecido') capa.append(el('span', { class: 'ub-selo', title: 'Canal que você via e parou' }, 'resgate'));
    else if (item.selo) capa.append(el('span', { class: 'ub-selo', title: 'Combina com os seus interesses' }, item.selo));
    const meta = item.meta || (item.views != null ? `${views(item.views)} · ${quando(item.publicado)}` : '');
    const c = el('div', { class: 'ub-card' });
    const mais = el('button', { class: 'ub-mais', title: 'Mais opções', 'aria-label': 'Mais opções' }, icone(SVG_MAIS));
    mais.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      const jaAberto = menuAberto?.botao === mais;
      fecharMenu();
      if (jaAberto) return;
      const opcao = (texto, tipo) => el('div', { onclick: ev => { ev.stopPropagation(); fecharMenu(); remover(c, item, tipo, fileira); } }, texto);
      const menu = el('div', { class: 'ub-menu' },
        opcao('Não tenho interesse', 'video'),
        ...(item.canal ? [opcao('Não recomendar este canal', 'canal')] : []));
      // fixo na tela: dentro do trilho (que rola de lado) ele seria cortado
      const r = mais.getBoundingClientRect();
      menu.style.top = `${r.bottom + 4}px`;
      menu.style.left = `${Math.max(8, r.right - 230)}px`;
      document.getElementById('unbubble').append(menu);
      mais.classList.add('aberto');
      menuAberto = { menu, botao: mais };
    });
    c.append(capa, el('div', { class: 'ub-info' },
      el('div', { class: 'ub-textos' },
        el('a', { href: `/watch?v=${item.id}`, onclick: () => registrarClique(item, fileira) },
          el('div', { class: 'ub-nome', title: item.titulo }, item.titulo)),
        el('div', { class: 'ub-meta' }, item.canal || ''),
        el('div', { class: item.motivo === 'fura' ? 'ub-meta ub-porque' : 'ub-meta', title: meta }, meta)),
      mais));
    c.dataset.canal = item.canal || '';
    return c;
  }

  function remover(c, item, tipo, fileira) {
    const k = recusar(item, tipo, fileira);
    const original = [...c.childNodes];
    const escondidos = [];
    if (tipo === 'canal') {  // some com os outros vídeos do canal na página também
      for (const o of document.querySelectorAll('#unbubble .ub-card')) {
        if (o !== c && o.dataset.canal === item.canal && o.style.display !== 'none') { o.style.display = 'none'; escondidos.push(o); }
      }
    }
    const desfazer = el('button', {}, 'Desfazer');
    desfazer.addEventListener('click', () => {
      desfazerRecusa(k);
      c.replaceChildren(...original);
      for (const o of escondidos) o.style.display = '';
    });
    c.replaceChildren(el('div', { class: 'ub-removido' },
      el('div', {}, tipo === 'canal' ? `Ok, nada mais de ${item.canal}.` : 'Vídeo removido. Vamos mostrar menos coisas assim.'),
      desfazer));
  }

  // Uma fileira: título com a bolhinha, trilho sem barra de rolagem e setas no estilo do YouTube.
  // carregarMais (opcional) é chamado perto do fim do trilho e devolve mais itens (rolagem infinita);
  // null = acabou; lista vazia = essa página não passou nos filtros, tenta a próxima.
  function fileira(id, titulo, itens, carregarMais) {
    const trilho = el('div', { class: 'ub-trilho' });
    const esq = el('button', { class: 'ub-seta esq', 'aria-label': 'Anterior' }, icone(SVG_SETA));
    const dir = el('button', { class: 'ub-seta dir', 'aria-label': 'Próximo' }, icone(SVG_SETA));
    const sec = el('section', { class: 'ub-fileira', 'data-fileira': id },
      el('div', { class: 'ub-cab' }, el('span', { class: 'ub-bolha', title: 'fileira do unbubble' }), el('h2', { class: 'ub-titulo' }, titulo)),
      el('div', { class: 'ub-linha' }, esq, trilho, dir));
    const ids = new Set();
    const por = (lista) => {
      for (const i of lista) {
        if (!i?.id || ids.has(i.id) || bloqueado(i)) continue;
        ids.add(i.id);
        const c = card(i, id);
        c.dataset.id = i.id;
        c.dataset.fileira = id;
        trilho.append(c);
        olhoDaTela.observe(c);
      }
    };
    por(itens);
    let carregando = false, acabou = !carregarMais, vazias = 0;
    const atualizar = () => {
      const fimVisivel = trilho.scrollLeft + trilho.clientWidth;
      esq.classList.toggle('ativa', trilho.scrollLeft > 4);
      dir.classList.toggle('ativa', fimVisivel < trilho.scrollWidth - 4 || !acabou);
      if (!acabou && !carregando && fimVisivel > trilho.scrollWidth - 3 * 276) {
        carregando = true;
        carregarMais().then(novos => {
          const antes = trilho.children.length;
          if (novos === null) acabou = true; else por(novos);
          vazias = trilho.children.length > antes ? 0 : vazias + 1;
          if (vazias >= 5) acabou = true;  // 5 páginas seguidas sem nada aproveitável: para
        }).catch(e => { acabou = true; log('fileira', id, 'parou:', e.message); })
          .finally(() => { carregando = false; atualizar(); });
      }
    };
    const passo = () => Math.max(trilho.clientWidth - 276, 276);
    esq.addEventListener('click', () => trilho.scrollBy({ left: -passo(), behavior: 'smooth' }));
    dir.addEventListener('click', () => trilho.scrollBy({ left: passo(), behavior: 'smooth' }));
    trilho.addEventListener('scroll', atualizar, { passive: true });
    new ResizeObserver(atualizar).observe(trilho);
    sec._vazia = () => !trilho.children.length;
    return sec;
  }

  function bloco() {
    const caixa = el('div', { id: 'unbubble' });
    caixa.append(el('style', {}, CSS));
    return caixa;
  }

  function desenharFileiras(caixa, home) {
    const ui = (f) => { if (f.itens?.length) { const s = fileira(f.id, f.titulo, f.itens); if (!s._vazia()) caixa.append(s); } };
    const fs = home.fileiras || [];
    // Primeiro as que olham para ele (Dos seus canais, Fora da sua bolha), depois os recomendados do YouTube,
    // depois o que o Brasil está vendo (Em Alta, Mais vistos)
    const doBrasil = f => f.id === 'em_alta' || f.id === 'mais_vistos';
    for (const f of fs.filter(f => !doBrasil(f) && !f.id.startsWith('cat_'))) ui(f);
    caixa.append(el('div', { id: 'ub-rec-yt' }));    // Recomendados pelo YouTube (com teto)
    for (const f of fs.filter(doBrasil)) ui(f);
    caixa.append(el('div', { id: 'ub-temas-yt' }));  // fileiras dos temas do próprio YouTube entram aqui
    for (const f of fs.filter(f => f.id.startsWith('cat_'))) ui(f);
  }

  // ---------- Fileiras infinitas com os temas que o próprio YouTube sugere (chips do topo da home) ----------
  const TEMAS_IGNORADOS = /^(tudo|all|novidades? para voc[eê]|novos? para voc[eê]|enviados recentemente|assistidos|recently uploaded|watched|new to you)$/i;
  const texto = t => (typeof t === 'string' ? t : t?.simpleText ?? t?.content ?? t?.runs?.map(r => r.text).join('') ?? '');

  function videosDoFeed(j) {
    const out = [];
    for (const l of achar(j, 'lockupViewModel')) {
      if (l.contentType && l.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') continue;  // mixes, playlists
      const md = l.metadata?.lockupMetadataViewModel;
      if (!md || !l.contentId) continue;
      const prog = achar(l.contentImage, 'thumbnailOverlayProgressBarViewModel')[0];
      if (prog && prog.startPercent >= 50) continue;  // já visto
      const linhas = achar(md.metadata, 'metadataRows')[0] || [];
      const partes = linhas.map(r => (r.metadataParts || []).map(p => p.text?.content).filter(Boolean));
      out.push({ id: l.contentId, titulo: texto(md.title), canal: partes[0]?.[0] || '', meta: (partes[1] || []).join(' • '),
                 canal_id: achar(md.metadata, 'browseEndpoint')[0]?.browseId || '',
                 duracao: achar(l.contentImage, 'thumbnailBadgeViewModel').map(b => b.text).filter(Boolean)[0] || '' });
    }
    for (const v of achar(j, 'videoRenderer')) {
      out.push({ id: v.videoId, titulo: texto(v.title), canal: texto(v.ownerText) || texto(v.shortBylineText),
                 meta: [texto(v.shortViewCountText) || texto(v.viewCountText), texto(v.publishedTimeText)].filter(Boolean).join(' • '),
                 canal_id: v.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || '',
                 duracao: texto(v.lengthText) });
    }
    return out.filter(v => /^[\w-]{11}$/.test(v.id || ''));
  }

  // A home do YouTube inteira vira fileiras: os recomendados dele numa fileira só (infinita para o lado, com
  // teto por tema) e cada tema (chip) numa fileira própria. A grade infinita para baixo some.
  async function desenharYouTube(lugarRec, lugarTemas) {
    const j = await browse({ browseId: 'FEwhat_to_watch' });
    if (lugarRec) {
      const mantidos = [];
      const comTeto = lista => { const ok = lista.filter(v => decidir(v, mantidos)); enviarSemTemaSeHora(); return ok; };
      let r = j, prox = proximo(j);
      const s = fileira('yt_recomendados', 'Recomendados pelo YouTube', comTeto(videosDoFeed(j)), async () => {
        if (!prox) return null;
        await pausa();
        r = await browse({ continuation: prox });
        prox = proximo(r);
        return comTeto(videosDoFeed(r));
      });
      if (!s._vazia()) lugarRec.append(s);
    }
    if (lugarTemas) await desenharTemas(j, lugarTemas);
  }

  async function desenharTemas(j, lugar) {
    const chips = [];
    for (const c of achar(j, 'chipCloudChipRenderer')) {
      const tok = achar(c.navigationEndpoint, 'token')[0];
      if (tok && !c.isSelected) chips.push({ nome: texto(c.text), tok });
    }
    for (const c of achar(j, 'chipViewModel')) {
      const tok = achar(c, 'token')[0];
      if (tok && !c.selected && !c.isSelected) chips.push({ nome: texto(c.text), tok });
    }
    const vistos = new Set();
    const temas = chips.filter(c => c.nome && !TEMAS_IGNORADOS.test(c.nome.trim()) && !vistos.has(c.nome) && vistos.add(c.nome));
    log(`temas do YouTube: ${temas.map(c => c.nome).join(', ') || 'nenhum'}`);
    for (const t of temas) {
      try {
        let r = await browse({ continuation: t.tok });
        let prox = proximo(r);
        const s = fileira(`yt_${t.nome}`, t.nome, videosDoFeed(r), async () => {
          if (!prox) return null;
          await pausa();
          r = await browse({ continuation: prox });
          prox = proximo(r);
          return videosDoFeed(r);
        });
        if (!s._vazia()) lugar.append(s);
      } catch (e) {
        log(`tema ${t.nome} falhou:`, e.message);
      }
      await pausa();
    }
  }

  function desenharConvite(caixa) {
    caixa.append(el('div', { class: 'ub-cab' },
      el('span', { class: 'ub-marca' }, 'unbubble'),
      el('span', { class: 'ub-aviso' }, 'Falta conectar ao seu repositório para mostrar suas fileiras.'),
      el('button', { onclick: configurarToken }, 'Conectar')));
  }

  function configurarToken() {
    const t = prompt('Cole o token do GitHub do unbubble (começa com github_pat_):', '');
    if (t === null) return;
    GM_setValue('token', t.trim());
    GM_setValue('home_cache', null);
    location.reload();
  }

  // ---------- Coleta para a fileira que fura a bolha (grátis: busca e relacionados do próprio YouTube) ----------
  // O Sonnet escolhe 1x/semana os rumos (saida/rumos.json: buscas + sementes). Aqui o navegador faz as buscas e
  // pega os relacionados das sementes, sem cota, e manda tudo para dados/fura/candidatos.json. O GitHub filtra,
  // o Haiku dá as notas e a fileira aparece na home.
  const COLETA_FURA_H = 6;
  const BUSCA_SO_VIDEOS = 'EgIQAQ==';  // filtro "Tipo: vídeo" da busca do YouTube

  async function coletarFura() {
    const rumos = JSON.parse(await github('GET', 'contents/saida/rumos.json'));
    const itens = new Map();
    const juntar = (lista, origem) => { for (const v of lista) if (!itens.has(v.id)) itens.set(v.id, { ...v, origem }); };
    for (const r of rumos.rumos || []) {
      for (const q of (r.buscas || []).slice(0, 2)) {
        try { juntar(videosDoFeed(await api('search', { query: q, params: BUSCA_SO_VIDEOS })), { rumo: r.nome, tipo: r.tipo, busca: q }); }
        catch (e) { log(`busca "${q}" falhou:`, e.message); }
        await pausa();
      }
    }
    for (const s of rumos.sementes || []) {
      try { juntar(videosDoFeed(await api('next', { videoId: s.id })), { semente: s.titulo, canal_semente: s.canal }); }
      catch (e) { log(`relacionados de ${s.id} falharam:`, e.message); }
      await pausa();
    }
    return { coletado_em: new Date().toISOString(), rumos_de: rumos.gerado_em, itens: [...itens.values()] };
  }

  let coletandoFura = false;
  async function coletarFuraSeHora(forcar = false) {
    if (coletandoFura || !GM_getValue('token', '')) return;
    if (!forcar && agora() - GM_getValue('ultima_coleta_fura', 0) < COLETA_FURA_H * 36e5) return;
    coletandoFura = true;
    GM_setValue('ultima_coleta_fura', agora());
    try {
      const c = await coletarFura();
      if (c.itens.length < 30) throw new Error(`coleta estranha, só ${c.itens.length} vídeos`);
      const caminho = 'contents/dados/fura/candidatos.json';
      let sha;
      try { sha = JSON.parse(await github('GET', caminho, null, { json: true })).sha; } catch (e) { /* ainda não existe */ }
      await github('PUT', caminho, {
        message: `Candidatos para furar a bolha (${c.itens.length})`,
        content: base64(JSON.stringify(c)), ...(sha ? { sha } : {}),
      }, { json: true, tempo: 60000 });
      log(`fura-bolha: ${c.itens.length} candidatos enviados`);
    } catch (e) {
      log('coleta do fura-bolha falhou:', e.message);
    } finally {
      coletandoFura = false;
    }
  }

  // ---------- Teto por tema nos recomendados do YouTube ----------
  // Em qualquer janela de 10 recomendados seguidos, no máximo N do mesmo tema (e 2 do mesmo canal).
  // O tema vem do Haiku (saida/temas.json): primeiro o do vídeo; se ainda não tiver, o do canal.
  const TETOS = { jogos: 4, politica: 2, ia_tecnologia: 2, lixo_algoritmo: 0 };
  const JANELA = 10;
  const POR_CANAL_JANELA = 2;
  const ENVIO_FILA_MIN = 10;   // manda os recomendados sem tema ao GitHub no máximo a cada 10 min

  let temasMapa = null;
  const decisao = new Map();      // id -> { mostrar, tema, canal }  (decidido uma vez por página)
  const semTema = new Map();      // id -> { id, titulo, canal } para mandar classificar

  async function lerTemas() {
    const cache = GM_getValue('temas_cache', null);
    if (cache && agora() - cache.lido_em < 10 * 60e3) return cache.temas;
    try {
      const temas = JSON.parse(await github('GET', 'contents/saida/temas.json'));
      GM_setValue('temas_cache', { lido_em: agora(), temas });
      return temas;
    } catch (e) {
      log('não consegui ler os temas:', e.message);
      return cache ? cache.temas : null;
    }
  }

  function dadosDoItem(it) {
    const a = it.querySelector('a[href^="/watch?v="]');
    if (!a) return null;  // anúncio ou outro formato: não mexe
    const id = new URL(a.href, location.origin).searchParams.get('v');
    const titulo = it.querySelector('h3[title]')?.getAttribute('title') || '';
    const linha = it.querySelector('.ytContentMetadataViewModelMetadataRow');  // 1ª linha = canal(is)
    const canal = (linha?.querySelector('a[href^="/@"], a[href^="/channel/"]') || linha?.querySelector('span[role="text"]'))
      ?.textContent?.trim() || '';
    return id ? { id, titulo, canal } : null;
  }

  // Decide (uma vez por vídeo) se ele entra, olhando os últimos mostrados em `mantidos`.
  function decidir(d, mantidos) {
    if (bloqueado(d)) return false;
    let dec = decisao.get(d.id);
    if (!dec) {
      const tv = temasMapa?.videos?.[d.id];
      const tema = tv ? tv[0] : temasMapa?.canais?.[d.canal] || null;
      if (!tv && temasMapa) semTema.set(d.id, { id: d.id, titulo: d.titulo, canal: d.canal });
      const janela = mantidos.slice(-(JANELA - 1));
      const doTema = tema ? janela.filter(m => m.tema === tema).length : 0;
      const doCanal = d.canal ? janela.filter(m => m.canal === d.canal).length : 0;
      const teto = tema in TETOS ? TETOS[tema] : Infinity;
      dec = { mostrar: doTema < teto && doCanal < POR_CANAL_JANELA, tema, canal: d.canal };
      decisao.set(d.id, dec);
    }
    if (dec.mostrar) mantidos.push(dec);
    return dec.mostrar;
  }

  // Só quando as fileiras não puderam substituir a grade: o teto vale na grade original do YouTube.
  function aplicarTetos(contents) {
    if (!temasMapa) return;
    const mantidos = [];
    for (const it of contents.querySelectorAll(':scope > ytd-rich-item-renderer')) {
      const d = dadosDoItem(it);
      if (d) it.style.display = decidir(d, mantidos) ? '' : 'none';
    }
    enviarSemTemaSeHora();
  }

  function enviarSemTemaSeHora() {
    if (!semTema.size || agora() - GM_getValue('ultimo_envio_fila', 0) < ENVIO_FILA_MIN * 60e3) return;
    GM_setValue('ultimo_envio_fila', agora());
    const itens = [...semTema.values()].slice(0, 500);
    semTema.clear();
    const caminho = 'contents/dados/fila/pendentes.json';
    (async () => {
      let sha;
      try { sha = JSON.parse(await github('GET', caminho, null, { json: true })).sha; } catch (e) { /* ainda não existe */ }
      await github('PUT', caminho, {
        message: `Recomendados para classificar (${itens.length})`,
        content: base64(JSON.stringify({ enviado_em: new Date().toISOString(), itens })), ...(sha ? { sha } : {}),
      }, { json: true, tempo: 30000 });
      log(`mandei ${itens.length} recomendados para classificar`);
    })().catch(e => log('não consegui mandar a fila:', e.message));
  }

  let observador = null;
  async function iniciarTeto(contents) {
    if (!temasMapa) return;  // sem temas: home do YouTube fica como está
    aplicarTetos(contents);
    observador?.disconnect();
    let espera = null;
    observador = new MutationObserver(() => {
      clearTimeout(espera);
      espera = setTimeout(() => { try { aplicarTetos(contents); } catch (e) { log('erro no teto:', e); } }, 300);
    });
    observador.observe(contents, { childList: true });
  }

  // ---------- Encaixe na home do YouTube ----------
  function alvo() {
    return document.querySelector('ytd-browse[page-subtype="home"] ytd-rich-grid-renderer #contents');
  }

  async function esperarAlvo(ms = 10000) {
    const fim = agora() + ms;
    while (agora() < fim) {
      const a = alvo();
      if (a) return a;
      await new Promise(r => setTimeout(r, 250));
    }
    return null;
  }

  let rodando = false, jaMontou = false, errosMontar = 0;
  async function montar() {
    if (location.pathname !== '/' || rodando) return;
    rodando = true;
    try {
      const contents = await esperarAlvo();
      if (!contents || document.getElementById('unbubble')) return;
      const caixa = bloco();
      if (!GM_getValue('token', '')) {
        desenharConvite(caixa);
      } else {
        const [home, temas] = await Promise.all([lerHome(), lerTemas()]);
        temasMapa = temas;
        decisao.clear();
        carregarBloqueios(home);
        if (home) desenharFileiras(caixa, home);  // falhou e sem cache: só as fileiras do YouTube
        else caixa.append(el('div', { id: 'ub-rec-yt' }), el('div', { id: 'ub-temas-yt' }));
      }
      if (document.getElementById('unbubble')) return;
      // mesma largura e recuo da grade de vídeos do YouTube
      const pai = contents.parentElement.getBoundingClientRect(), g = contents.getBoundingClientRect();
      caixa.style.marginLeft = `${Math.max(g.left - pai.left, 0)}px`;
      caixa.style.marginRight = `${Math.max(pai.right - g.right, 0)}px`;
      contents.before(caixa);
      jaMontou = true;
      log(`home montada: ${caixa.querySelectorAll('.ub-fileira').length} fileiras nossas`);
      if (!GM_getValue('token', '')) return;
      // Substitui a grade infinita do YouTube pelas fileiras, mas só se houver fileira de verdade
      // (nunca página em branco). Escondida, a grade também para de carregar mais vídeos.
      const substituir = () => {
        if (!caixa.querySelector('.ub-fileira') || contents.style.display === 'none') return false;
        contents.style.display = 'none';
        const cab = contents.parentElement.querySelector(':scope > #header');  // chips: viraram fileiras
        if (cab) cab.style.display = 'none';
        observador?.disconnect();
        return true;
      };
      if (!substituir()) iniciarTeto(contents).catch(e => log('erro no teto:', e));
      desenharYouTube(document.getElementById('ub-rec-yt'), document.getElementById('ub-temas-yt'))
        .catch(e => log('fileiras do YouTube falharam:', e.message))
        .finally(substituir);
    } catch (e) {
      errosMontar++;
      log('erro, home original mantida:', e);
    } finally {
      rodando = false;
    }
  }

  // Versão nova do script: descarta o que estava guardado (pode ter sido lido antes das fileiras novas existirem)
  const versao = GM_info?.script?.version;
  if (versao && GM_getValue('versao', '') !== versao) {
    GM_setValue('versao', versao);
    GM_setValue('home_cache', null);
    GM_setValue('temas_cache', null);
  }

  // Vigia: o YouTube às vezes recria a grade da home depois de carregar (e leva as fileiras junto), ou
  // traz uma grade nova visível. Se as fileiras sumiram, monta de novo; se a grade voltou, esconde.
  let remontagens = 0;
  window.addEventListener('yt-navigate-finish', () => { remontagens = 0; errosMontar = 0; });
  function vigiar() {
    if (location.pathname !== '/' || rodando || !GM_getValue('token', '')) return;
    const caixa = document.getElementById('unbubble');
    if (!caixa) {
      // Ainda carregando: tenta de novo. Deu erro 3 vezes ou sumiu 3 vezes depois de montada: desiste e deixa
      // a home original (sem ficar insistindo).
      if (errosMontar >= 3 || remontagens >= 3) return;
      if (jaMontou) { remontagens++; log('fileiras sumiram da página, montando de novo'); }
      montar();
      return;
    }
    const a = alvo();
    if (a && a.style.display !== 'none' && caixa.querySelector('.ub-fileira')) {
      a.style.display = 'none';
      const cab = a.parentElement?.querySelector(':scope > #header');
      if (cab) cab.style.display = 'none';
      if (a.previousElementSibling !== caixa) a.before(caixa);
    }
  }
  setInterval(vigiar, 1500);

  GM_registerMenuCommand('Conectar / trocar token', configurarToken);
  GM_registerMenuCommand('Capturar meu histórico agora', () => capturarSeHora(true));
  GM_registerMenuCommand('Buscar candidatos para furar a bolha agora', () => coletarFuraSeHora(true));
  GM_registerMenuCommand('Atualizar fileiras agora', () => { GM_setValue('home_cache', null); GM_setValue('ultimo_disparo', 0); location.reload(); });
  window.addEventListener('yt-navigate-finish', montar);
  montar();
  setTimeout(() => capturarSeHora(), 8000);  // depois da página carregar, sem atrapalhar
  setTimeout(() => coletarFuraSeHora(), 20000);
  setInterval(() => enviarUsoSeHora().catch(e => log('não consegui mandar o uso:', e.message)), 5 * 60e3);
  setTimeout(() => enviarUsoSeHora().catch(e => log('não consegui mandar o uso:', e.message)), 30000);
})();
