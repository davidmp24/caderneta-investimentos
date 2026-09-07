/* ============================================================
   CADERNETA DE INVESTIMENTOS v1.1
   app.js — Lógica principal
   - Autenticação: PBKDF2 + AES-256 via CryptoJS
   - Cotações: Yahoo Finance (proxy CORS) + Binance
   - Explorer B3: Tabela paginada com filtros e cotações
   - Widget de Favoritos: Radar Quick Access
   - CRUD: Carteira & Watchlist
   ============================================================ */

'use strict';

/* ─── Constantes ──────────────────────────────────────────── */
const APP_VERSION   = '1.1.0';
const STORAGE_KEY   = 'caderneta_v2_enc';    // Dados cifrados
const AUTH_KEY      = 'caderneta_auth_meta'; // Metadados de auth (salt, hash)
const SESSION_KEY   = 'caderneta_session';   // Sessão temporária
const MAX_ATTEMPTS  = 5;
const BLOCK_MS      = 30 * 60 * 1000;       // 30 min bloqueio
const SESSION_TTL   = 30 * 60 * 1000;       // 30 min inatividade
const PBKDF2_ITERS  = 150_000;

const CORS_PROXIES = [
  'https://corsproxy.io/?',
  'https://api.allorigins.win/raw?url=',
];

const DEFAULT_BEST = [
  { ticker: 'BBSE3', name: 'BB Seguridade' },
  { ticker: 'BBAS3', name: 'Banco do Brasil' },
  { ticker: 'CMIG4', name: 'Cemig' },
  { ticker: 'TAEE11', name: 'Taesa' },
  { ticker: 'TRPL4', name: 'ISA Cteep' },
  { ticker: 'UNIP6', name: 'Unipar' },
  { ticker: 'SANB4', name: 'Santander Brasil' },
  { ticker: 'AURE3', name: 'Auren Energia' },
  { ticker: 'KLBN4', name: 'Klabin' },
  { ticker: 'IRBR3', name: 'IRB Brasil' },
];

/* ─── Estado Global ───────────────────────────────────────── */
let state = {
  portfolio:   [],  // ativos na carteira
  watchlist:   [],  // ativos no radar
  best:        [],  // ativos no grupo Best
};

let currentFilter   = 'ALL';
let searchQuery     = '';
let editingId       = null;
let sessionTimer    = null;
let derivedKey      = null; // Chave AES derivada do PIN (em memória apenas)
let isFirstAccess   = false;

/* ─── Best Widget State ───────────────────────────────────── */
let bestEditList    = [];
let bestPrices      = {};

/* ─── Helper de Logos dos Ativos ──────────────────────────── */
function getAssetLogoUrl(ticker) {
  if (!ticker) return '';
  const clean = ticker.toUpperCase().trim();
  return `https://raw.githubusercontent.com/thefintz/icones-b3/main/icones/${clean}.png`;
}

function renderAssetLogoHtml(ticker, cssClass = 'asset-logo') {
  const clean = (ticker || '').toUpperCase().trim();
  const initials = clean.replace(/[^A-Z]/g, '').slice(0, 4) || clean.slice(0, 4);
  const url = getAssetLogoUrl(clean);
  const fbClass = cssClass === 'explorer-logo' ? 'explorer-logo-fb' : cssClass === 'fav-logo' ? 'fav-logo-fb' : 'asset-logo-fallback';
  return `
    <div class="${cssClass}" title="${clean}">
      <img src="${url}" alt="${clean}" loading="lazy"
           onerror="this.style.display='none'; if(this.nextElementSibling) this.nextElementSibling.style.display='flex';" />
      <span class="${fbClass}" style="display:none;">${initials}</span>
    </div>
  `;
}

/* ─── Explorer State ─────────────────────────────────────── */
let explorerData    = [];   // cópia de B3_STOCKS filtrada/ordenada
let explorerPage    = 1;
const EXPLORER_PAGE_SIZE = 20;
let explorerSortKey = 'ticker';
let explorerSortDir = 1; // 1 asc, -1 desc
let explorerType    = 'ALL';
let explorerQuery   = '';
let explorerPrices  = {}; // cache de cotações { ticker: { price, change } }

/* ═══════════════════════════════════════════════════════════
   SEGURANÇA — AUTH & CRIPTOGRAFIA
   ═══════════════════════════════════════════════════════════ */

/** Deriva chave AES de 256 bits a partir do PIN + salt via PBKDF2 */
function deriveKey(pin, salt) {
  return CryptoJS.PBKDF2(pin, salt, {
    keySize: 256 / 32,
    iterations: PBKDF2_ITERS,
    hasher: CryptoJS.algo.SHA256,
  }).toString();
}

/** Cifra o estado completo com AES-256 */
function encryptState(key) {
  try {
    const json = JSON.stringify(state);
    return CryptoJS.AES.encrypt(json, key).toString();
  } catch { return null; }
}

/** Decifra dados com a chave derivada. Retorna objeto ou null. */
function decryptState(ciphertext, key) {
  try {
    const bytes = CryptoJS.AES.decrypt(ciphertext, key);
    const json  = bytes.toString(CryptoJS.enc.Utf8);
    if (!json) return null;
    return JSON.parse(json);
  } catch { return null; }
}

/** Hash do PIN para verificação rápida sem armazenar o PIN */
function hashPin(pin, salt) {
  return CryptoJS.PBKDF2(pin + '__verify', salt, {
    keySize: 128 / 32,
    iterations: 10_000,
  }).toString();
}

/* ─── Gerenciamento de Tentativas de Login ──────────────── */
function getAuthAttempts() {
  try {
    return JSON.parse(localStorage.getItem('caderneta_attempts') || '{}');
  } catch { return {}; }
}

function saveAuthAttempts(data) {
  localStorage.setItem('caderneta_attempts', JSON.stringify(data));
}

function isBlocked() {
  const d = getAuthAttempts();
  if (!d.blockedAt) return false;
  return (Date.now() - d.blockedAt) < BLOCK_MS;
}

function getRemainingBlockMinutes() {
  const d = getAuthAttempts();
  if (!d.blockedAt) return 0;
  return Math.ceil((BLOCK_MS - (Date.now() - d.blockedAt)) / 60000);
}

/* ─── Sessão / Inatividade ──────────────────────────────── */
function startSessionTimer() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    showToast('Sessão expirada por inatividade.', 'info');
    handleLogout();
  }, SESSION_TTL);
}

function resetSessionTimer() { startSessionTimer(); }

/* Captura qualquer interação do usuário para resetar o timer */
['click','keydown','touchstart','scroll'].forEach(ev => {
  document.addEventListener(ev, resetSessionTimer, { passive: true });
});

/* ─── Login Flow ─────────────────────────────────────────── */
function initLoginScreen() {
  const meta = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null');
  if (!meta) {
    // Primeiro acesso — sem dados ainda
    isFirstAccess = true;
    document.getElementById('first-access-msg').style.display = 'block';
  }

  if (isBlocked()) {
    showBlockedUI();
  }
}

function showBlockedUI() {
  const blockedEl = document.getElementById('login-blocked');
  blockedEl.style.display = 'block';
  document.getElementById('login-btn').disabled = true;
  const update = () => {
    const rem = getRemainingBlockMinutes();
    document.getElementById('block-timer').textContent = rem;
    if (rem <= 0) {
      blockedEl.style.display = 'none';
      document.getElementById('login-btn').disabled = false;
      saveAuthAttempts({});
    }
  };
  update();
  setInterval(update, 15000);
}

document.getElementById('login-form').addEventListener('submit', async function(e) {
  e.preventDefault();

  if (isBlocked()) { showBlockedUI(); return; }

  const pin = document.getElementById('login-pin').value;
  if (!pin || pin.length < 4) {
    showLoginError('PIN deve ter pelo menos 4 caracteres.');
    return;
  }

  const btn = document.getElementById('login-btn');
  btn.disabled = true;
  btn.textContent = 'Verificando…';

  await new Promise(r => setTimeout(r, 30)); // Micro-delay anti-timing

  const meta = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null');

  if (!meta) {
    // Primeiro acesso: criar salt + hash + cifrar estado vazio
    const salt       = CryptoJS.lib.WordArray.random(128 / 8).toString();
    const verifyHash = hashPin(pin, salt);
    const key        = deriveKey(pin, salt);
    localStorage.setItem(AUTH_KEY, JSON.stringify({ salt, verifyHash }));
    derivedKey = key;
    saveAuthAttempts({});
    initDefaultData();
    saveEncryptedState();
    openApp();
  } else {
    const expectedHash = hashPin(pin, meta.salt);
    if (expectedHash !== meta.verifyHash) {
      // Tentativa falhou
      const attempts = getAuthAttempts();
      attempts.count = (attempts.count || 0) + 1;
      if (attempts.count >= MAX_ATTEMPTS) {
        attempts.blockedAt = Date.now();
        saveAuthAttempts(attempts);
        showBlockedUI();
      } else {
        saveAuthAttempts(attempts);
        const remaining = MAX_ATTEMPTS - attempts.count;
        showLoginError(`PIN incorreto. Tentativas restantes: ${remaining}.`);
        document.getElementById('login-attempts-info').textContent =
          `${attempts.count} de ${MAX_ATTEMPTS} tentativas usadas.`;
      }
    } else {
      // Login bem-sucedido
      const key = deriveKey(pin, meta.salt);
      const enc = localStorage.getItem(STORAGE_KEY);
      if (enc) {
        const decrypted = decryptState(enc, key);
        if (!decrypted) {
          showLoginError('Erro ao decifrar dados. O PIN pode estar incorreto ou os dados foram corrompidos.');
          btn.disabled = false; btn.textContent = 'Entrar'; return;
        }
        state = { portfolio: [], watchlist: [], best: JSON.parse(JSON.stringify(DEFAULT_BEST)), ...decrypted };
        if (!state.best || !Array.isArray(state.best) || state.best.length === 0) {
          state.best = JSON.parse(JSON.stringify(DEFAULT_BEST));
        }
      }
      derivedKey = key;
      saveAuthAttempts({});
      openApp();
    }
  }

  btn.disabled = false; btn.textContent = 'Entrar';
});

function showLoginError(msg) {
  const el = document.getElementById('login-error');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 4000);
}

function openApp() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app').style.display = 'flex';
  document.getElementById('app').style.flexDirection = 'column';
  startSessionTimer();
  renderAll();
  renderBestWidget();
  renderFavoritosWidget();
  initExplorer();
  refreshAllQuotes();
  refreshBestQuotes();
}

function handleLogout() {
  derivedKey = null;
  state = { portfolio: [], watchlist: [], best: [] };
  explorerPrices = {};
  bestPrices = {};
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-pin').value = '';
  document.getElementById('login-error').classList.remove('show');
  clearTimeout(sessionTimer);
}

/* ─── Alterar PIN ─────────────────────────────────────────── */
function openChangePinModal() {
  document.getElementById('old-pin').value = '';
  document.getElementById('new-pin').value = '';
  document.getElementById('confirm-pin').value = '';
  document.getElementById('change-pin-error').style.display = 'none';
  openModal('modal-change-pin');
}

document.getElementById('change-pin-form').addEventListener('submit', async function(e) {
  e.preventDefault();
  const oldPin = document.getElementById('old-pin').value;
  const newPin = document.getElementById('new-pin').value;
  const confPin = document.getElementById('confirm-pin').value;
  const errEl = document.getElementById('change-pin-error');

  if (newPin.length < 4) {
    errEl.textContent = 'Novo PIN deve ter pelo menos 4 caracteres.';
    errEl.style.display = 'block'; return;
  }
  if (newPin !== confPin) {
    errEl.textContent = 'Confirmação de PIN não coincide.';
    errEl.style.display = 'block'; return;
  }

  // Verificar PIN antigo
  const meta = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null');
  if (meta && hashPin(oldPin, meta.salt) !== meta.verifyHash) {
    errEl.textContent = 'PIN atual incorreto.';
    errEl.style.display = 'block'; return;
  }

  // Re-derivar com novo PIN
  const newSalt = CryptoJS.lib.WordArray.random(128 / 8).toString();
  const newHash = hashPin(newPin, newSalt);
  const newKey  = deriveKey(newPin, newSalt);
  localStorage.setItem(AUTH_KEY, JSON.stringify({ salt: newSalt, verifyHash: newHash }));
  derivedKey = newKey;
  saveEncryptedState();
  closeModal('modal-change-pin');
  showToast('PIN alterado com sucesso!', 'success');
});

/* ═══════════════════════════════════════════════════════════
   PERSISTÊNCIA (CIFRADA)
   ═══════════════════════════════════════════════════════════ */

function saveEncryptedState() {
  if (!derivedKey) return;
  const enc = encryptState(derivedKey);
  if (enc) localStorage.setItem(STORAGE_KEY, enc);
}

/* ═══════════════════════════════════════════════════════════
   COTAÇÕES — YAHOO FINANCE + BINANCE
   ═══════════════════════════════════════════════════════════ */

const QuoteService = {
  cache: {},
  CACHE_TTL: 5 * 60 * 1000,

  async fetchYahoo(symbols) {
    if (!symbols || symbols.length === 0) return {};
    const yahooSymbols = symbols.map(s => {
      s = s.toUpperCase().trim();
      if (/^[A-Z]{3,6}\d{1,2}$/.test(s)) return s + '.SA';
      if (/^[A-Z]{3,4}34$/.test(s)) return s + '.SA';
      return s;
    });
    const qs = yahooSymbols.join(',');
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(qs)}&fields=regularMarketPrice,regularMarketChangePercent,shortName`;

    for (const proxy of CORS_PROXIES) {
      try {
        const res = await fetch(proxy + encodeURIComponent(url), { signal: AbortSignal.timeout(7000) });
        if (!res.ok) continue;
        const data = await res.json();
        const quotes = data?.quoteResponse?.result || [];
        const result = {};
        for (const q of quotes) {
          const ticker = q.symbol.replace('.SA', '');
          result[ticker] = {
            price:  q.regularMarketPrice ?? null,
            change: q.regularMarketChangePercent ?? 0,
            name:   q.shortName || '',
          };
        }
        return result;
      } catch { continue; }
    }
    return {};
  },

  async fetchBinance(symbols) {
    const result = {};
    const btcPairs = symbols.filter(s => s.endsWith('BTC'));
    const usdtPairs = symbols.filter(s => s.endsWith('USDT'));

    const allPairs = [...btcPairs, ...usdtPairs];
    if (!allPairs.length) return result;

    try {
      const qs = encodeURIComponent(JSON.stringify(allPairs));
      const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbols=${qs}`,
        { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return result;
      const data = await res.json();
      for (const t of data) {
        result[t.symbol] = {
          price:  parseFloat(t.lastPrice),
          change: parseFloat(t.priceChangePercent),
          name:   t.symbol,
        };
      }
    } catch { /* noop */ }
    return result;
  },

  async getQuotes(tickers) {
    const now = Date.now();
    const toFetch = tickers.filter(t => {
      const c = this.cache[t];
      return !c || (now - c.ts) > this.CACHE_TTL;
    });

    if (toFetch.length > 0) {
      const cryptoTickers = toFetch.filter(t => t.endsWith('USDT') || t.endsWith('BTC'));
      const b3Tickers     = toFetch.filter(t => !t.endsWith('USDT') && !t.endsWith('BTC'));

      const [yahooData, binanceData] = await Promise.all([
        b3Tickers.length     ? this.fetchYahoo(b3Tickers)      : {},
        cryptoTickers.length ? this.fetchBinance(cryptoTickers) : {},
      ]);

      const allData = { ...yahooData, ...binanceData };
      for (const [ticker, data] of Object.entries(allData)) {
        this.cache[ticker] = { ...data, ts: now };
      }
    }

    return tickers.reduce((acc, t) => {
      acc[t] = this.cache[t] || null;
      return acc;
    }, {});
  },
};

/* ═══════════════════════════════════════════════════════════
   NAVEGAÇÃO
   ═══════════════════════════════════════════════════════════ */

let currentTab = 'carteira';

function switchTab(tab) {
  currentTab = tab;

  // Atualizar botões
  document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  // Mostrar/esconder seções
  document.querySelectorAll('.view-section').forEach(sec => {
    sec.classList.toggle('active', sec.id === `view-${tab}`);
  });

  // Resumo e toolbar: só aparecem na carteira e radar
  const showSummary  = ['carteira', 'radar'].includes(tab);
  const showToolbar  = ['carteira', 'radar'].includes(tab);
  document.getElementById('summary-hero-card').style.display = showSummary ? '' : 'none';
  document.getElementById('toolbar-section').style.display   = showToolbar ? '' : 'none';

  // Configurações: esconder summary e toolbar
  if (tab === 'config' || tab === 'explorer') {
    document.getElementById('summary-hero-card').style.display = 'none';
    document.getElementById('toolbar-section').style.display   = 'none';
  }

  if (tab === 'explorer') renderExplorerTable();
  if (tab === 'carteira') {
    renderBestWidget();
    renderFavoritosWidget();
  }
}

// Delegação de cliques nos botões de nav
document.querySelectorAll('[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

/* ═══════════════════════════════════════════════════════════
   RENDER — SUMMARY HERO
   ═══════════════════════════════════════════════════════════ */

function renderSummary() {
  let totalInvestido = 0, totalAtual = 0;

  for (const a of state.portfolio) {
    const qty = parseFloat(a.quantity) || 0;
    const avg = parseFloat(a.avgPrice) || 0;
    const cur = parseFloat(a.currentPrice) || avg;
    totalInvestido += qty * avg;
    totalAtual     += qty * cur;
  }

  const lucro = totalAtual - totalInvestido;
  const pct   = totalInvestido > 0 ? (lucro / totalInvestido) * 100 : 0;

  document.getElementById('total-patrimonio').textContent  = fmt(totalAtual);
  document.getElementById('total-investido').textContent   = fmt(totalInvestido);
  document.getElementById('total-lucro-nominal').textContent = (lucro >= 0 ? '+' : '') + fmt(lucro);

  const badge = document.getElementById('badge-rentabilidade-total');
  badge.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
  badge.className   = `badge-profit ${pct >= 0 ? 'positive' : 'negative'}`;

  const now = new Date();
  document.getElementById('last-sync-time').textContent =
    now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  renderAllocation();
}

function renderAllocation() {
  const cats = {};
  let total = 0;
  for (const a of state.portfolio) {
    const val = (parseFloat(a.quantity) || 0) * (parseFloat(a.currentPrice) || parseFloat(a.avgPrice) || 0);
    cats[a.type] = (cats[a.type] || 0) + val;
    total += val;
  }

  const colors = { STOCK:'cat-stock', FII:'cat-fii', ETF:'cat-etf', CRYPTO:'cat-crypto', FIXED:'cat-fixed', OTHER:'cat-other' };
  const labels = { STOCK:'Ações', FII:'FIIs', ETF:'ETFs', CRYPTO:'Cripto', FIXED:'R.Fixa', OTHER:'Outros' };

  const bar = document.getElementById('allocation-bar');
  const legend = document.getElementById('allocation-legend');
  bar.innerHTML = ''; legend.innerHTML = '';

  for (const [cat, val] of Object.entries(cats)) {
    if (!val) continue;
    const pct = total > 0 ? (val / total) * 100 : 0;
    const seg = document.createElement('div');
    seg.className = `alloc-segment ${colors[cat] || 'cat-other'}`;
    seg.style.width = pct + '%';
    bar.appendChild(seg);

    const li = document.createElement('div');
    li.className = 'legend-item';
    li.innerHTML = `<span class="legend-dot ${colors[cat] || 'cat-other'}"></span>${labels[cat] || cat} ${pct.toFixed(1)}%`;
    legend.appendChild(li);
  }
}

/* ═══════════════════════════════════════════════════════════
   RENDER — PORTFOLIO
   ═══════════════════════════════════════════════════════════ */

function renderPortfolio() {
  let items = [...state.portfolio];

  // Filtro de categoria
  if (currentFilter !== 'ALL') items = items.filter(a => a.type === currentFilter);

  // Filtro de busca
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    items = items.filter(a =>
      a.ticker.toLowerCase().includes(q) || (a.name || '').toLowerCase().includes(q)
    );
  }

  const list = document.getElementById('portfolio-items-list');
  const count = document.getElementById('portfolio-count-badge');
  count.textContent = state.portfolio.length;

  if (items.length === 0) {
    list.innerHTML = `
      <div class="empty-state-box">
        <div class="empty-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
        </div>
        <div class="empty-title">Carteira vazia</div>
        <div class="empty-desc">Adicione seu primeiro ativo clicando em "Novo Ativo".</div>
      </div>`;
    return;
  }

  const catBadges = {
    STOCK: ['cat-stock', 'AÇÃO'], FII: ['cat-fii', 'FII'], ETF: ['cat-etf', 'ETF'],
    CRYPTO: ['cat-crypto', 'CRIPTO'], FIXED: ['cat-fixed', 'R.FIXA'], OTHER: ['cat-other', 'OUTRO'],
  };

  list.innerHTML = items.map(a => {
    const qty = parseFloat(a.quantity) || 0;
    const avg = parseFloat(a.avgPrice) || 0;
    const cur = parseFloat(a.currentPrice) || avg;
    const invested = qty * avg;
    const atualVal = qty * cur;
    const pnl = atualVal - invested;
    const pnlPct = invested > 0 ? (pnl / invested) * 100 : 0;
    const [catClass, catLabel] = catBadges[a.type] || ['cat-other', 'OUTRO'];
    const pnlClass = pnl >= 0 ? 'positive' : 'negative';

    return `
    <div class="asset-card" id="card-${a.id}">
      <div class="asset-card-header">
        <div class="asset-identity" style="display:flex;align-items:center;gap:10px;">
          ${renderAssetLogoHtml(a.ticker, 'asset-logo')}
          <div>
            <div style="display:flex;align-items:center;gap:7px;">
              <span class="asset-tag">${escapeHtml(a.ticker)}</span>
              <span class="asset-category-badge ${catClass}"
                style="background:var(--${catClass === 'cat-stock'?'accent-blue-dim':catClass === 'cat-fii'?'accent-green-dim':catClass === 'cat-etf'?'':'bg-surface'});color:var(--${catClass === 'cat-stock'?'accent-blue':catClass === 'cat-fii'?'accent-green':catClass === 'cat-etf'?'accent-yellow':catClass === 'cat-crypto'?'accent-purple':'text-secondary'});">
                ${catLabel}
              </span>
            </div>
            ${a.name ? `<div class="asset-name">${escapeHtml(a.name)}</div>` : ''}
          </div>
        </div>
        <div class="asset-card-actions">
          <button class="action-btn-sm" onclick="openEditAssetModal('${a.id}')" title="Editar">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="action-btn-sm delete" onclick="deleteAsset('${a.id}')" title="Remover">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
          </button>
        </div>
      </div>
      <div class="asset-grid">
        <div class="asset-col">
          <span class="asset-col-label">Quantidade</span>
          <span class="asset-col-val">${qty.toLocaleString('pt-BR')}</span>
        </div>
        <div class="asset-col">
          <span class="asset-col-label">Preço Médio</span>
          <span class="asset-col-val">${fmtN(avg)}</span>
        </div>
        <div class="asset-col">
          <span class="asset-col-label">Preço Atual</span>
          <span class="asset-col-val price-editable" onclick="openEditAssetModal('${a.id}')">
            ${fmtN(cur)}
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </span>
        </div>
        <div class="asset-col">
          <span class="asset-col-label">Total Investido</span>
          <span class="asset-col-val">${fmtN(invested)}</span>
        </div>
        <div class="asset-col">
          <span class="asset-col-label">Valor Atual</span>
          <span class="asset-col-val">${fmtN(atualVal)}</span>
        </div>
        <div class="asset-col">
          <span class="asset-col-label">Resultado</span>
          <span class="badge-profit ${pnlClass}" style="font-size:.8rem;">
            ${pnl >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%
          </span>
        </div>
      </div>
      <div class="asset-card-footer">
        <span class="asset-notes">${escapeHtml(a.notes || '—')}</span>
        <span class="badge-profit ${pnlClass}">${pnl >= 0 ? '+' : ''}${fmtN(pnl)}</span>
      </div>
    </div>`;
  }).join('');
}

/* ═══════════════════════════════════════════════════════════
   RENDER — WATCHLIST / RADAR
   ═══════════════════════════════════════════════════════════ */

function renderWatchlist() {
  let items = [...state.watchlist];

  if (currentFilter !== 'ALL') items = items.filter(a => a.type === currentFilter);
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    items = items.filter(a => a.ticker.toLowerCase().includes(q) || (a.name||'').toLowerCase().includes(q));
  }

  const list = document.getElementById('watchlist-items-list');
  document.getElementById('watchlist-count-badge').textContent = state.watchlist.length;

  if (items.length === 0) {
    list.innerHTML = `
      <div class="empty-state-box">
        <div class="empty-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
        </div>
        <div class="empty-title">Radar vazio</div>
        <div class="empty-desc">Monitore ativos antes de aportar clicando em "Novo Radar".</div>
      </div>`;
    return;
  }

  list.innerHTML = items.map(a => {
    const cur    = parseFloat(a.currentPrice) || null;
    const target = parseFloat(a.targetPrice) || null;

    let badgeHtml = '';
    if (cur && target) {
      const below = cur < target;
      badgeHtml = `<span class="target-comparison-badge ${below ? 'buy-opportunity' : 'above-target'}">
        ${below ? '✓ Abaixo do Teto' : '✕ Acima do Teto'} — Teto: ${fmtN(target)}
      </span>`;
    } else if (target) {
      badgeHtml = `<span class="target-comparison-badge" style="background:var(--bg-surface);color:var(--text-secondary);">Teto: ${fmtN(target)}</span>`;
    }

    return `
    <div class="asset-card" id="card-w-${a.id}">
      <div class="asset-card-header">
        <div class="asset-identity" style="display:flex;align-items:center;gap:10px;">
          ${renderAssetLogoHtml(a.ticker, 'asset-logo')}
          <div>
            <div class="asset-tag">${escapeHtml(a.ticker)}</div>
            ${a.name ? `<div class="asset-name">${escapeHtml(a.name)}</div>` : ''}
          </div>
        </div>
        <div class="asset-card-actions">
          <button class="action-btn-sm" onclick="openEditWatchlistModal('${a.id}')" title="Editar">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="action-btn-sm delete" onclick="deleteWatchlistItem('${a.id}')" title="Remover">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
          </button>
        </div>
      </div>
      <div class="asset-grid">
        <div class="asset-col">
          <span class="asset-col-label">Preço Atual</span>
          <span class="asset-col-val">${cur ? fmtN(cur) : '—'}</span>
        </div>
        <div class="asset-col">
          <span class="asset-col-label">Preço Teto</span>
          <span class="asset-col-val">${target ? fmtN(target) : '—'}</span>
        </div>
        <div class="asset-col">
          <span class="asset-col-label">Tipo</span>
          <span class="asset-col-val">${a.type}</span>
        </div>
      </div>
      <div class="asset-card-footer">
        <span class="asset-notes">${escapeHtml(a.notes || '—')}</span>
        <div style="display:flex;gap:6px;align-items:center;">
          ${badgeHtml}
          <button class="btn-convert-wallet" onclick="convertToPortfolio('${a.id}')">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
            → Carteira
          </button>
        </div>
      </div>
    </div>`;
  }).join('');
}

/* ═══════════════════════════════════════════════════════════
   WIDGET DE FAVORITOS (Radar Quick Access)
   ═══════════════════════════════════════════════════════════ */

function renderFavoritosWidget() {
  const container = document.getElementById('favoritos-scroll');
  const items = state.watchlist.slice(0, 8);

  if (items.length === 0) {
    container.innerHTML = `
      <div class="fav-empty">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
        </svg>
        Adicione ativos ao Radar para vê-los aqui
      </div>`;
    return;
  }

  container.innerHTML = items.map(a => {
    const cur    = parseFloat(a.currentPrice) || null;
    const target = parseFloat(a.targetPrice)  || null;

    let marginHtml = '';
    if (cur && target) {
      const below = cur < target;
      const pct   = Math.abs(((cur - target) / target) * 100).toFixed(1);
      marginHtml = `<span class="fav-margin ${below ? 'ok' : 'over'}">
        ${below ? '▲' : '▼'} ${pct}% ${below ? 'abaixo' : 'acima'}
      </span>`;
    } else {
      marginHtml = `<span class="fav-margin neutral">Sem teto</span>`;
    }

    return `
    <div class="fav-card" onclick="switchTab('radar')">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
        ${renderAssetLogoHtml(a.ticker, 'fav-logo')}
        <div style="flex:1;min-width:0;">
          <div class="fav-ticker">${escapeHtml(a.ticker)}</div>
          ${a.name ? `<div class="fav-name">${escapeHtml(a.name)}</div>` : ''}
        </div>
      </div>
      <div class="fav-price">${cur ? fmtN(cur) : '—'}</div>
      ${marginHtml}
    </div>`;
  }).join('');
}

/* ═══════════════════════════════════════════════════════════
   WIDGET BEST — SELEÇÃO PESSOAL (Editável)
   ═══════════════════════════════════════════════════════════ */

function renderBestWidget() {
  const container = document.getElementById('best-scroll');
  if (!container) return;

  if (!state.best || !Array.isArray(state.best) || state.best.length === 0) {
    state.best = JSON.parse(JSON.stringify(DEFAULT_BEST));
  }

  container.innerHTML = state.best.map(item => {
    const pData = bestPrices[item.ticker] || explorerPrices[item.ticker];
    const price = pData?.price != null ? fmtN(pData.price) : '—';
    const chg = pData?.change;
    const chgClass = (chg > 0) ? 'pos' : (chg < 0) ? 'neg' : 'neutral';
    const chgText = (chg != null) ? `${chg > 0 ? '+' : ''}${chg.toFixed(2)}%` : '—';

    return `
      <div class="best-card" onclick="quickViewBestTicker('${item.ticker}')" title="Clique para detalhes no Explorer">
        <div class="best-card-top">
          ${renderAssetLogoHtml(item.ticker, 'fav-logo')}
          <div class="best-card-info">
            <div class="best-ticker">${escapeHtml(item.ticker)}</div>
            <div class="best-name" title="${escapeHtml(item.name || item.ticker)}">${escapeHtml(item.name || item.ticker)}</div>
          </div>
        </div>
        <div style="display:flex;align-items:baseline;justify-content:space-between;margin-top:2px;">
          <div class="best-price">${price}</div>
          <div class="best-change ${chgClass}">${chgText}</div>
        </div>
      </div>
    `;
  }).join('');
}

async function refreshBestQuotes() {
  if (!state.best || !state.best.length) return;
  const tickers = state.best.map(b => b.ticker);
  try {
    const quotes = await QuoteService.getQuotes(tickers);
    for (const [t, data] of Object.entries(quotes)) {
      if (data) bestPrices[t] = data;
    }
    renderBestWidget();
  } catch (err) {
    console.warn('Erro ao atualizar cotações Best:', err);
  }
}

function quickViewBestTicker(ticker) {
  const inRadar = state.watchlist.some(w => w.ticker === ticker);
  if (inRadar) {
    switchTab('radar');
  } else {
    switchTab('explorer');
    const input = document.getElementById('explorer-search-input');
    if (input) {
      input.value = ticker;
      explorerSearch();
    }
  }
}

function openBestEditModal() {
  if (!state.best || !state.best.length) {
    state.best = JSON.parse(JSON.stringify(DEFAULT_BEST));
  }
  bestEditList = JSON.parse(JSON.stringify(state.best));
  const input = document.getElementById('best-search-input');
  if (input) input.value = '';
  const sug = document.getElementById('best-search-suggestions');
  if (sug) sug.innerHTML = '';
  renderBestEditList();
  openModal('modal-best-edit');
}

function renderBestEditList() {
  const container = document.getElementById('best-current-list');
  if (!container) return;
  if (!bestEditList.length) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem;text-align:center;padding:12px;">Nenhum ativo na lista Best. Adicione novos ativos acima.</div>';
    return;
  }
  container.innerHTML = bestEditList.map((item, idx) => `
    <div class="best-edit-item">
      ${renderAssetLogoHtml(item.ticker, 'fav-logo')}
      <div class="best-edit-item-info">
        <div class="best-edit-ticker">${escapeHtml(item.ticker)}</div>
        <div class="best-edit-name">${escapeHtml(item.name || '')}</div>
      </div>
      <button class="best-remove-btn" onclick="removeBestItem(${idx})" title="Remover da lista">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  `).join('');
}

function removeBestItem(idx) {
  bestEditList.splice(idx, 1);
  renderBestEditList();
}

function bestSearchFilter() {
  const val = (document.getElementById('best-search-input').value || '').toUpperCase().trim();
  const sug = document.getElementById('best-search-suggestions');
  if (!val || val.length < 2) {
    sug.innerHTML = '';
    return;
  }
  const stockList = (typeof B3_STOCKS !== 'undefined') ? B3_STOCKS : [];
  const matches = stockList.filter(s =>
    s.ticker.includes(val) || (s.name || '').toUpperCase().includes(val)
  ).slice(0, 5);

  if (!matches.length) {
    sug.innerHTML = `<div style="font-size:0.75rem;color:var(--text-muted);padding:4px;">Nenhuma sugestão encontrada. Clique em "Adicionar" para incluir <b>${val}</b>.</div>`;
    return;
  }

  sug.innerHTML = matches.map(m => `
    <div class="best-suggestion-item" onclick="selectBestSuggestion('${m.ticker}', '${escapeAttr(m.name)}')">
      ${renderAssetLogoHtml(m.ticker, 'explorer-logo')}
      <span class="best-suggestion-ticker">${escapeHtml(m.ticker)}</span>
      <span class="best-suggestion-name">${escapeHtml(m.name)}</span>
      <span style="font-size:0.7rem;color:var(--accent-blue);font-weight:600;">+ Adicionar</span>
    </div>
  `).join('');
}

function selectBestSuggestion(ticker, name) {
  if (bestEditList.some(b => b.ticker === ticker)) {
    showToast(`${ticker} já está no grupo Best.`, 'info');
    return;
  }
  bestEditList.push({ ticker, name });
  const input = document.getElementById('best-search-input');
  if (input) input.value = '';
  const sug = document.getElementById('best-search-suggestions');
  if (sug) sug.innerHTML = '';
  renderBestEditList();
}

function bestAddFromSearch() {
  const input = document.getElementById('best-search-input');
  const val = (input?.value || '').toUpperCase().trim();
  if (!val) return;
  if (bestEditList.some(b => b.ticker === val)) {
    showToast(`${val} já está no grupo Best.`, 'info');
    return;
  }
  const stockList = (typeof B3_STOCKS !== 'undefined') ? B3_STOCKS : [];
  const stock = stockList.find(s => s.ticker === val);
  bestEditList.push({ ticker: val, name: stock ? stock.name : val });
  if (input) input.value = '';
  const sug = document.getElementById('best-search-suggestions');
  if (sug) sug.innerHTML = '';
  renderBestEditList();
}

function saveBestEdit() {
  state.best = [...bestEditList];
  saveEncryptedState();
  renderBestWidget();
  refreshBestQuotes();
  closeModal('modal-best-edit');
  showToast('Grupo Best atualizado com sucesso!', 'success');
}

/* ═══════════════════════════════════════════════════════════
   EXPLORER B3
   ═══════════════════════════════════════════════════════════ */

function initExplorer() {
  explorerData = [...B3_STOCKS];
  applyExplorerFilters();
}

function applyExplorerFilters() {
  let data = [...B3_STOCKS];

  if (explorerType !== 'ALL') {
    data = data.filter(s => s.type === explorerType);
  }
  if (explorerQuery) {
    const q = explorerQuery.toLowerCase();
    data = data.filter(s =>
      s.ticker.toLowerCase().includes(q) ||
      s.name.toLowerCase().includes(q) ||
      s.sector.toLowerCase().includes(q)
    );
  }

  // Sort
  data.sort((a, b) => {
    let va = a[explorerSortKey], vb = b[explorerSortKey];
    if (explorerSortKey === 'currentPrice' || explorerSortKey === 'change') {
      va = explorerPrices[a.ticker]?.[explorerSortKey === 'change' ? 'change' : 'price'] ?? -Infinity;
      vb = explorerPrices[b.ticker]?.[explorerSortKey === 'change' ? 'change' : 'price'] ?? -Infinity;
    }
    if (va === undefined) va = '';
    if (vb === undefined) vb = '';
    if (va < vb) return -explorerSortDir;
    if (va > vb) return explorerSortDir;
    return 0;
  });

  explorerData = data;
  explorerPage = 1;
  renderExplorerTable();
}

function explorerSearch() {
  explorerQuery = document.getElementById('explorer-search').value;
  applyExplorerFilters();
}

function explorerFilterType(btn) {
  document.querySelectorAll('#explorer-type-filter .pill-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  explorerType = btn.dataset.extype;
  applyExplorerFilters();
}

function explorerSort(key) {
  if (explorerSortKey === key) {
    explorerSortDir = -explorerSortDir;
  } else {
    explorerSortKey = key;
    explorerSortDir = 1;
  }
  // Marcar coluna ativa
  document.querySelectorAll('.explorer-table th').forEach(th => {
    th.classList.toggle('sorted', th.getAttribute('onclick') === `explorerSort('${key}')`);
  });
  applyExplorerFilters();
}

function renderExplorerTable() {
  const tbody = document.getElementById('explorer-tbody');
  if (!tbody) return;

  const start  = (explorerPage - 1) * EXPLORER_PAGE_SIZE;
  const end    = start + EXPLORER_PAGE_SIZE;
  const visible = explorerData.slice(start, end);
  const total   = explorerData.length;

  tbody.innerHTML = visible.map(s => {
    const priceData = explorerPrices[s.ticker];
    const priceStr  = priceData?.price != null ? fmtN(priceData.price) : '—';
    const change    = priceData?.change ?? null;
    const changeStr = change != null
      ? `<span class="explorer-change ${change >= 0 ? 'pos' : 'neg'}">${change >= 0 ? '+' : ''}${change.toFixed(2)}%</span>`
      : `<span class="explorer-change" style="color:var(--text-muted)">—</span>`;

    const inPortfolio = state.portfolio.some(p => p.ticker === s.ticker);
    const inWatchlist = state.watchlist.some(p => p.ticker === s.ticker);

    return `
    <tr>
      <td>
        <div style="display:flex;align-items:center;gap:8px;">
          ${renderAssetLogoHtml(s.ticker, 'explorer-logo')}
          <span class="explorer-ticker">${escapeHtml(s.ticker)}</span>
        </div>
      </td>
      <td><span class="explorer-name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</span></td>
      <td style="color:var(--text-secondary);font-size:.78rem;">${escapeHtml(s.sector)}</td>
      <td class="explorer-price">${priceStr}</td>
      <td>${changeStr}</td>
      <td>
        <div class="explorer-actions">
          ${inWatchlist
            ? `<span class="explorer-action-btn radar" style="opacity:.5;cursor:default;">★ Radar</span>`
            : `<button class="explorer-action-btn radar" onclick="explorerAddToRadar('${s.ticker}','${escapeAttr(s.name)}','${s.type}')">☆ Radar</button>`
          }
          ${inPortfolio
            ? `<span class="explorer-action-btn carteira" style="opacity:.5;cursor:default;">✓ Carteira</span>`
            : `<button class="explorer-action-btn carteira" onclick="explorerAddToCarteira('${s.ticker}','${escapeAttr(s.name)}','${s.type}')">+ Carteira</button>`
          }
        </div>
      </td>
    </tr>`;
  }).join('');

  // Info e paginação
  document.getElementById('explorer-info').textContent =
    `Mostrando ${Math.min(start+1, total)}–${Math.min(end, total)} de ${total} ativos`;

  renderExplorerPagination(total);
}

function renderExplorerPagination(total) {
  const pages   = Math.ceil(total / EXPLORER_PAGE_SIZE);
  const pagesEl = document.getElementById('explorer-pages');

  let html = `
    <button class="pagination-btn" ${explorerPage === 1 ? 'disabled' : ''} onclick="explorerGoPage(${explorerPage-1})">‹</button>`;

  const maxBtns = 5;
  const half    = Math.floor(maxBtns / 2);
  let start     = Math.max(1, explorerPage - half);
  let end       = Math.min(pages, start + maxBtns - 1);
  if (end - start < maxBtns - 1) start = Math.max(1, end - maxBtns + 1);

  for (let i = start; i <= end; i++) {
    html += `<button class="pagination-btn ${i === explorerPage ? 'current' : ''}" onclick="explorerGoPage(${i})">${i}</button>`;
  }

  html += `<button class="pagination-btn" ${explorerPage === pages ? 'disabled' : ''} onclick="explorerGoPage(${explorerPage+1})">›</button>`;

  pagesEl.innerHTML = html;
}

function explorerGoPage(n) {
  explorerPage = n;
  renderExplorerTable();
  document.getElementById('view-explorer').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* Atalho: Adicionar ativo do Explorer ao Radar */
function explorerAddToRadar(ticker, name, type) {
  const item = {
    id: genId(), ticker, name, type,
    currentPrice: explorerPrices[ticker]?.price || null,
    targetPrice: null, notes: '',
  };
  state.watchlist.push(item);
  saveEncryptedState();
  renderFavoritosWidget();
  renderExplorerTable();
  showToast(`${ticker} adicionado ao Radar!`, 'success');
}

/* Atalho: Adicionar ativo do Explorer à Carteira (abre modal pré-preenchido) */
function explorerAddToCarteira(ticker, name, type) {
  openAddAssetModal({ ticker, name, type });
}

/* Atualizar cotações dos ativos visíveis na tabela */
async function refreshExplorerPrices() {
  const btn = document.getElementById('btn-explorer-refresh');
  btn.classList.add('spinning');

  const start   = (explorerPage - 1) * EXPLORER_PAGE_SIZE;
  const visible = explorerData.slice(start, start + EXPLORER_PAGE_SIZE);
  const tickers = visible.map(s => s.ticker);

  try {
    const quotes = await QuoteService.getQuotes(tickers);
    for (const [ticker, data] of Object.entries(quotes)) {
      if (data) explorerPrices[ticker] = data;
    }
    renderExplorerTable();
    showToast(`${Object.keys(quotes).length} cotações atualizadas.`, 'info');
  } catch (e) {
    showToast('Erro ao buscar cotações.', 'error');
  } finally {
    btn.classList.remove('spinning');
  }
}

/* ═══════════════════════════════════════════════════════════
   ATUALIZAR TODAS AS COTAÇÕES (Carteira + Radar)
   ═══════════════════════════════════════════════════════════ */

async function refreshAllQuotes() {
  const btn = document.getElementById('btn-sync-quotes');
  btn.classList.add('spinning');

  const tickers = [
    ...state.portfolio.map(a => a.ticker),
    ...state.watchlist.map(a => a.ticker),
    ...(state.best || []).map(a => a.ticker),
  ];

  if (tickers.length === 0) {
    btn.classList.remove('spinning');
    showToast('Nenhum ativo para atualizar.', 'info');
    return;
  }

  try {
    const quotes = await QuoteService.getQuotes([...new Set(tickers)]);
    let updated = 0;

    state.portfolio.forEach(a => {
      const q = quotes[a.ticker];
      if (q?.price) { a.currentPrice = q.price; updated++; }
    });

    state.watchlist.forEach(a => {
      const q = quotes[a.ticker];
      if (q?.price) { a.currentPrice = q.price; }
    });

    (state.best || []).forEach(a => {
      const q = quotes[a.ticker];
      if (q) bestPrices[a.ticker] = q;
    });

    if (updated > 0) saveEncryptedState();

    renderAll();
    showToast(`Cotações atualizadas para ${updated} ativo(s).`, 'success');
  } catch {
    showToast('Erro na busca de cotações. Verifique a conexão.', 'error');
  } finally {
    btn.classList.remove('spinning');
  }
}

/* ═══════════════════════════════════════════════════════════
   CRUD — CARTEIRA
   ═══════════════════════════════════════════════════════════ */

function openAddAssetModal(prefill = {}) {
  editingId = null;
  document.getElementById('modal-asset-title').textContent = 'Adicionar Ativo';
  document.getElementById('asset-id').value = '';
  document.getElementById('asset-ticker').value   = prefill.ticker || '';
  document.getElementById('asset-name').value     = prefill.name   || '';
  document.getElementById('asset-type').value     = prefill.type   || 'STOCK';
  document.getElementById('asset-quantity').value = '';
  document.getElementById('asset-avg-price').value    = '';
  document.getElementById('asset-current-price').value = '';
  document.getElementById('asset-notes').value    = '';
  openModal('modal-asset');
}

function openEditAssetModal(id) {
  const a = state.portfolio.find(x => x.id === id);
  if (!a) return;
  editingId = id;
  document.getElementById('modal-asset-title').textContent = 'Editar Ativo';
  document.getElementById('asset-id').value = id;
  document.getElementById('asset-ticker').value   = a.ticker;
  document.getElementById('asset-name').value     = a.name || '';
  document.getElementById('asset-type').value     = a.type;
  document.getElementById('asset-quantity').value = a.quantity;
  document.getElementById('asset-avg-price').value    = a.avgPrice;
  document.getElementById('asset-current-price').value = a.currentPrice || '';
  document.getElementById('asset-notes').value    = a.notes || '';
  openModal('modal-asset');
}

document.getElementById('asset-form').addEventListener('submit', async function(e) {
  e.preventDefault();
  const id      = document.getElementById('asset-id').value || genId();
  const ticker  = document.getElementById('asset-ticker').value.toUpperCase().trim();
  const name    = document.getElementById('asset-name').value.trim();
  const type    = document.getElementById('asset-type').value;
  const qty     = parseFloat(document.getElementById('asset-quantity').value);
  const avg     = parseFloat(document.getElementById('asset-avg-price').value);
  const curRaw  = document.getElementById('asset-current-price').value;
  const cur     = curRaw ? parseFloat(curRaw) : null;
  const notes   = document.getElementById('asset-notes').value.trim();

  if (!ticker || isNaN(qty) || isNaN(avg)) {
    showToast('Preencha todos os campos obrigatórios.', 'error'); return;
  }

  const item = { id, ticker, name, type, quantity: qty, avgPrice: avg, currentPrice: cur, notes };

  if (editingId) {
    const idx = state.portfolio.findIndex(x => x.id === editingId);
    if (idx !== -1) state.portfolio[idx] = item;
  } else {
    state.portfolio.push(item);
    // Auto-fetch quote
    QuoteService.getQuotes([ticker]).then(quotes => {
      if (quotes[ticker]?.price) {
        const a = state.portfolio.find(x => x.id === id);
        if (a) { a.currentPrice = quotes[ticker].price; saveEncryptedState(); renderAll(); }
      }
    });
  }

  saveEncryptedState();
  closeModal('modal-asset');
  renderAll();
  showToast(editingId ? 'Ativo atualizado!' : 'Ativo adicionado!', 'success');
});

function deleteAsset(id) {
  if (!confirm('Remover este ativo da carteira?')) return;
  state.portfolio = state.portfolio.filter(x => x.id !== id);
  saveEncryptedState(); renderAll();
  showToast('Ativo removido.', 'info');
}

/* ═══════════════════════════════════════════════════════════
   CRUD — WATCHLIST
   ═══════════════════════════════════════════════════════════ */

function openAddWatchlistModal(prefill = {}) {
  editingId = null;
  document.getElementById('modal-watchlist-title').textContent = 'Adicionar no Radar';
  document.getElementById('watchlist-id').value = '';
  document.getElementById('watchlist-ticker').value       = prefill.ticker || '';
  document.getElementById('watchlist-name').value         = prefill.name   || '';
  document.getElementById('watchlist-type').value         = prefill.type   || 'STOCK';
  document.getElementById('watchlist-target-price').value  = '';
  document.getElementById('watchlist-current-price').value = '';
  document.getElementById('watchlist-notes').value        = '';
  openModal('modal-watchlist');
}

function openEditWatchlistModal(id) {
  const a = state.watchlist.find(x => x.id === id);
  if (!a) return;
  editingId = id;
  document.getElementById('modal-watchlist-title').textContent = 'Editar Radar';
  document.getElementById('watchlist-id').value = id;
  document.getElementById('watchlist-ticker').value       = a.ticker;
  document.getElementById('watchlist-name').value         = a.name || '';
  document.getElementById('watchlist-type').value         = a.type;
  document.getElementById('watchlist-target-price').value  = a.targetPrice || '';
  document.getElementById('watchlist-current-price').value = a.currentPrice || '';
  document.getElementById('watchlist-notes').value        = a.notes || '';
  openModal('modal-watchlist');
}

document.getElementById('watchlist-form').addEventListener('submit', async function(e) {
  e.preventDefault();
  const id     = document.getElementById('watchlist-id').value || genId();
  const ticker = document.getElementById('watchlist-ticker').value.toUpperCase().trim();
  const name   = document.getElementById('watchlist-name').value.trim();
  const type   = document.getElementById('watchlist-type').value;
  const target = parseFloat(document.getElementById('watchlist-target-price').value) || null;
  const cur    = parseFloat(document.getElementById('watchlist-current-price').value) || null;
  const notes  = document.getElementById('watchlist-notes').value.trim();

  if (!ticker) { showToast('Ticker obrigatório.', 'error'); return; }

  const item = { id, ticker, name, type, targetPrice: target, currentPrice: cur, notes };

  if (editingId) {
    const idx = state.watchlist.findIndex(x => x.id === editingId);
    if (idx !== -1) state.watchlist[idx] = item;
  } else {
    state.watchlist.push(item);
    QuoteService.getQuotes([ticker]).then(quotes => {
      if (quotes[ticker]?.price) {
        const a = state.watchlist.find(x => x.id === id);
        if (a) { a.currentPrice = quotes[ticker].price; saveEncryptedState(); renderAll(); }
      }
    });
  }

  saveEncryptedState();
  closeModal('modal-watchlist');
  renderAll();
  showToast(editingId ? 'Radar atualizado!' : 'Ativo adicionado ao Radar!', 'success');
});

function deleteWatchlistItem(id) {
  if (!confirm('Remover do Radar?')) return;
  state.watchlist = state.watchlist.filter(x => x.id !== id);
  saveEncryptedState(); renderAll();
  showToast('Removido do Radar.', 'info');
}

/* Mover do Radar para Carteira */
function convertToPortfolio(id) {
  const a = state.watchlist.find(x => x.id === id);
  if (!a) return;
  openAddAssetModal({ ticker: a.ticker, name: a.name, type: a.type });
}

/* ═══════════════════════════════════════════════════════════
   FILTROS & BUSCA
   ═══════════════════════════════════════════════════════════ */

document.querySelectorAll('[data-category]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-category]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.category;
    renderPortfolio();
    renderWatchlist();
  });
});

document.getElementById('search-assets').addEventListener('input', e => {
  searchQuery = e.target.value;
  renderPortfolio();
  renderWatchlist();
});

/* ═══════════════════════════════════════════════════════════
   BACKUP & RESTAURAÇÃO
   ═══════════════════════════════════════════════════════════ */

function exportBackupJSON() {
  const data  = { version: APP_VERSION, exportedAt: new Date().toISOString(), ...state };
  const blob  = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url   = URL.createObjectURL(blob);
  const a     = document.createElement('a');
  a.href      = url;
  a.download  = `caderneta-backup-${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Backup exportado com sucesso!', 'success');
}

function importBackupJSON(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const data = JSON.parse(ev.target.result);
      if (!data.portfolio || !Array.isArray(data.portfolio)) throw new Error('Formato inválido');
      state.portfolio = data.portfolio || [];
      state.watchlist = data.watchlist || [];
      saveEncryptedState(); renderAll();
      showToast('Backup restaurado com sucesso!', 'success');
    } catch {
      showToast('Arquivo de backup inválido.', 'error');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

function resetToDefault() {
  if (!confirm('Restaurar dados de demonstração? Isso substituirá seus dados atuais.')) return;
  state = { portfolio: [], watchlist: [] };
  initDefaultData();
  saveEncryptedState(); renderAll();
  showToast('Dados de demonstração restaurados.', 'info');
}

function clearDatabase() {
  if (!confirm('Zerar toda a carteira? Esta ação é irreversível.')) return;
  state = { portfolio: [], watchlist: [] };
  saveEncryptedState(); renderAll();
  showToast('Carteira zerada.', 'info');
}

/* ═══════════════════════════════════════════════════════════
   DADOS INICIAIS (Demo)
   ═══════════════════════════════════════════════════════════ */

function initDefaultData() {
  if (state.portfolio.length === 0 && state.watchlist.length === 0) {
    state.portfolio = [
      { id: genId(), ticker: 'PETR4', name: 'Petrobras PN', type: 'STOCK', quantity: 100, avgPrice: 35.5, currentPrice: 37.0, notes: 'Dividendos consistentes' },
      { id: genId(), ticker: 'VALE3', name: 'Vale S.A.', type: 'STOCK', quantity: 50, avgPrice: 68.0, currentPrice: 65.0, notes: 'Commodities — risco cambial' },
      { id: genId(), ticker: 'HGLG11', name: 'CSHG Logística', type: 'FII', quantity: 20, avgPrice: 162.0, currentPrice: 168.0, notes: 'DY mensal' },
      { id: genId(), ticker: 'WEGE3', name: 'WEG S.A.', type: 'STOCK', quantity: 30, avgPrice: 42.0, currentPrice: 45.0, notes: 'Crescimento internacional' },
      { id: genId(), ticker: 'BOVA11', name: 'iShares Ibovespa ETF', type: 'ETF', quantity: 40, avgPrice: 120.0, currentPrice: 125.0, notes: 'Diversificação ampla' },
    ];
    state.watchlist = [
      { id: genId(), ticker: 'ITUB4', name: 'Itaú Unibanco PN', type: 'STOCK', targetPrice: 32.0, currentPrice: null, notes: 'Aguardando preço de entrada' },
      { id: genId(), ticker: 'XPLG11', name: 'XP Log', type: 'FII', targetPrice: 108.0, currentPrice: null, notes: 'Logística — boa gestão' },
      { id: genId(), ticker: 'PRIO3', name: 'PRIO S.A.', type: 'STOCK', targetPrice: 50.0, currentPrice: null, notes: 'Petróleo independente' },
    ];
  }
  if (!state.best || !Array.isArray(state.best) || state.best.length === 0) {
    state.best = JSON.parse(JSON.stringify(DEFAULT_BEST));
  }
}

/* ═══════════════════════════════════════════════════════════
   MODAIS
   ═══════════════════════════════════════════════════════════ */

function openModal(id) {
  document.getElementById(id).classList.add('active');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('active');
}

// Fechar ao clicar no overlay
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeModal(overlay.id);
  });
});

/* ═══════════════════════════════════════════════════════════
   TOAST
   ═══════════════════════════════════════════════════════════ */

function showToast(msg, type = 'info') {
  const icons = {
    success: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>',
    error:   '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    info:    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  };

  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${icons[type] || ''}${escapeHtml(msg)}`;
  document.getElementById('toast-container').appendChild(el);

  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3200);
}

/* ═══════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════ */

function genId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function fmt(v) {
  return (v ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function fmtN(v) {
  if (v === null || v === undefined) return '—';
  return 'R$ ' + parseFloat(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function escapeAttr(str) {
  return String(str || '').replace(/'/g, "\\'");
}

/* ═══════════════════════════════════════════════════════════
   RENDER PRINCIPAL
   ═══════════════════════════════════════════════════════════ */

function renderAll() {
  renderSummary();
  renderPortfolio();
  renderWatchlist();
  renderBestWidget();
  renderFavoritosWidget();
  if (currentTab === 'explorer') renderExplorerTable();
}

/* ═══════════════════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {
  initLoginScreen();

  // Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
});
