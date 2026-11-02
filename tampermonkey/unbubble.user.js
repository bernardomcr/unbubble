// ==UserScript==
// @name         unbubble
// @namespace    https://github.com/bernardomcr/unbubble
// @version      0.2.0
// @description  Home anti-bolha do YouTube: fileira "Dos seus canais" e captura do seu histórico para o curador.
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
  const CACHE_MIN = 30;            // relê o home.json do GitHub no máximo a cada 30 min
  const VELHO_H = 3;               // home.json mais velho que isso => pede ao GitHub para refazer
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

  async function browse(corpo) {
    const ytcfg = unsafeWindow.ytcfg;
    const sapisid = (document.cookie.match(/(?:^|; )(?:SAPISID|__Secure-3PAPISID)=([^;]+)/) || [])[1];
    if (!ytcfg || !sapisid) throw new Error('YouTube sem login ou sem configuração');
    const ts = Math.floor(agora() / 1000);
    const r = await fetch('/youtubei/v1/browse?prettyPrint=false', {
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

  // ---------- Registro local de cliques (para o aprendizado depois) ----------
  function registrarClique(item, fileira) {
    const cliques = GM_getValue('cliques', []);
    cliques.push({ id: item.id, canal_id: item.canal_id, fileira, motivo: item.motivo, em: new Date().toISOString() });
    GM_setValue('cliques', cliques.slice(-2000));
  }

  // ---------- Desenho ----------
  const CSS = `
    #unbubble { --ub-texto: #0f0f0f; --ub-texto2: #606060; --ub-fundo-capa: #e5e5e5;
      align-self: stretch; min-width: 0; box-sizing: border-box; margin: 8px 0 24px;
      font-family: Roboto, Arial, sans-serif; }
    html[dark] #unbubble { --ub-texto: #f1f1f1; --ub-texto2: #aaaaaa; --ub-fundo-capa: #272727; }
    #unbubble .ub-cab { display: flex; align-items: baseline; gap: 10px; margin: 0 0 12px; }
    #unbubble .ub-titulo { font-size: 2rem; font-weight: 700; color: var(--ub-texto); margin: 0; }
    #unbubble .ub-marca { font-size: 1.2rem; font-weight: 700; color: ${COR}; letter-spacing: .02em; }
    #unbubble .ub-sub { font-size: 1.3rem; color: var(--ub-texto2); }
    #unbubble .ub-trilho { display: grid; grid-auto-flow: column; grid-auto-columns: 260px;
      gap: 16px; overflow-x: auto; scroll-snap-type: x mandatory; padding-bottom: 8px; }
    #unbubble .ub-card { scroll-snap-align: start; text-decoration: none; color: inherit; display: block; min-width: 0; }
    #unbubble .ub-capa { position: relative; aspect-ratio: 16 / 9; border-radius: 12px; overflow: hidden;
      background: var(--ub-fundo-capa); }
    #unbubble .ub-capa img { width: 100%; height: 100%; object-fit: cover; display: block; }
    #unbubble .ub-selo { position: absolute; left: 8px; top: 8px; background: ${COR}; color: #fff;
      font-size: 1.1rem; font-weight: 700; padding: 2px 8px; border-radius: 999px; }
    #unbubble .ub-nome { font-size: 1.4rem; font-weight: 500; line-height: 2rem; margin: 10px 0 2px;
      color: var(--ub-texto); display: -webkit-box; -webkit-line-clamp: 2;
      -webkit-box-orient: vertical; overflow: hidden; }
    #unbubble .ub-meta { font-size: 1.2rem; line-height: 1.8rem; color: var(--ub-texto2); }
    #unbubble .ub-aviso { font-size: 1.4rem; color: var(--ub-texto2); }
    #unbubble button { background: ${COR}; color: #fff; border: 0; border-radius: 999px; padding: 6px 14px;
      font-size: 1.3rem; font-weight: 600; cursor: pointer; }
  `;

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

  function card(item, fileira) {
    const capa = el('div', { class: 'ub-capa' },
      el('img', { src: `https://i.ytimg.com/vi/${item.id}/mqdefault.jpg`, alt: '', loading: 'lazy' }));
    if (item.motivo === 'esquecido') capa.append(el('span', { class: 'ub-selo', title: 'Canal que você via e parou' }, 'resgate'));
    return el('a', { class: 'ub-card', href: `/watch?v=${item.id}`, onclick: () => registrarClique(item, fileira) },
      capa,
      el('div', { class: 'ub-nome', title: item.titulo }, item.titulo),
      el('div', { class: 'ub-meta' }, item.canal),
      el('div', { class: 'ub-meta' }, `${views(item.views)} · ${quando(item.publicado)}`));
  }

  function bloco() {
    const caixa = el('div', { id: 'unbubble' });
    caixa.append(el('style', {}, CSS));
    return caixa;
  }

  function desenharFileiras(caixa, home) {
    for (const f of home.fileiras) {
      if (!f.itens || !f.itens.length) continue;
      const esq = f.itens.filter(i => i.motivo === 'esquecido').length;
      caixa.append(
        el('div', { class: 'ub-cab' },
          el('h2', { class: 'ub-titulo' }, f.titulo),
          el('span', { class: 'ub-marca' }, 'unbubble'),
          el('span', { class: 'ub-sub' }, esq ? `${esq} de canais que você deixou de ver` : '')),
        el('div', { class: 'ub-trilho' }, ...f.itens.map(i => card(i, f.id))));
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

  let rodando = false;
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
        const home = await lerHome();
        if (!home) return;  // falhou e sem cache: deixa a home original
        desenharFileiras(caixa, home);
      }
      if (document.getElementById('unbubble')) return;
      // mesma largura e recuo da grade de vídeos do YouTube
      const pai = contents.parentElement.getBoundingClientRect(), g = contents.getBoundingClientRect();
      caixa.style.marginLeft = `${Math.max(g.left - pai.left, 0)}px`;
      caixa.style.marginRight = `${Math.max(pai.right - g.right, 0)}px`;
      contents.before(caixa);
    } catch (e) {
      log('erro, home original mantida:', e);
    } finally {
      rodando = false;
    }
  }

  GM_registerMenuCommand('Conectar / trocar token', configurarToken);
  GM_registerMenuCommand('Capturar meu histórico agora', () => capturarSeHora(true));
  GM_registerMenuCommand('Atualizar fileiras agora', () => { GM_setValue('home_cache', null); GM_setValue('ultimo_disparo', 0); location.reload(); });
  window.addEventListener('yt-navigate-finish', montar);
  montar();
  setTimeout(() => capturarSeHora(), 8000);  // depois da página carregar, sem atrapalhar
})();
