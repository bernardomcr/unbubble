// ==UserScript==
// @name         unbubble
// @namespace    https://github.com/bernardomcr/unbubble
// @version      0.1.0
// @description  Home anti-bolha do YouTube: fileira "Dos seus canais" (favoritos + esquecidos que valem resgate).
// @match        https://www.youtube.com/*
// @noframes
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
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

  const agora = () => Date.now();
  const log = (...a) => console.log('[unbubble]', ...a);

  // ---------- GitHub ----------
  function github(metodo, caminho, corpo) {
    const token = GM_getValue('token', '');
    return new Promise((ok, falha) => {
      if (!token) return falha(new Error('sem token'));
      GM_xmlhttpRequest({
        method: metodo,
        url: `https://api.github.com/repos/${REPO}/${caminho}`,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.raw+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(corpo ? { 'Content-Type': 'application/json' } : {}),
        },
        data: corpo ? JSON.stringify(corpo) : undefined,
        timeout: 15000,
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
  GM_registerMenuCommand('Atualizar fileiras agora', () => { GM_setValue('home_cache', null); GM_setValue('ultimo_disparo', 0); location.reload(); });
  window.addEventListener('yt-navigate-finish', montar);
  montar();
})();
