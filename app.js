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
const APP_VERSION        = '1.7.6';
const STORAGE_KEY        = 'caderneta_v2_enc';    // Dados cifrados
const AUTH_KEY           = 'caderneta_auth_meta'; // Metadados de auth (salt, hash)
const SESSION_KEY        = 'caderneta_session';   // Sessão temporária
const SYNC_ID_KEY        = 'caderneta_sync_id';   // ID único da carteira para sincronização
const CLOUD_ENDPOINT_KEY = 'caderneta_cloud_endpoint';
const CLOUD_TOKEN_KEY    = 'caderneta_cloud_token';
const LAST_SYNC_KEY      = 'caderneta_last_synced';
const MAX_ATTEMPTS       = 5;
const BLOCK_MS           = 30 * 60 * 1000;       // 30 min bloqueio
const SESSION_TTL        = 30 * 60 * 1000;       // 30 min inatividade
const PBKDF2_ITERS       = 150_000;

// Configuração Padrão da Nuvem (Zero-Knowledge: apenas cofre cifrado trafega)
const DEFAULT_CLOUD_URL   = 'https://flexible-scorpion-106260.upstash.io';
const DEFAULT_CLOUD_TOKEN = 'gQAAAAAZ8UAQIgcDI0ZjI1YzU4ZTAxZTI0NWU1YjVmMzhjZWRjMDY2OGRmMA';

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
const KNOWN_CRYPTO_LIST = ['BTC','ETH','SOL','BNB','XRP','DOGE','ADA','AVAX','LINK','SUI','DOT','NEAR','LTC','SHIB','PEPE','UNI','RENDER','ATOM','ICP','APT','FIL','TRX','XLM','ARB','OP','POL','FET','TIA','RUNE','INJ','AAVE','KAS','USDT','USDC'];

function getAssetLogoUrl(ticker) {
  if (!ticker) return '';
  const clean = ticker.toUpperCase().trim();
  const rawClean = clean.replace(/USDT$|BRL$|BTC$/, '');

  // Se for Cripto: busca do repositório CoinCap ou CryptoLogos
  if (KNOWN_CRYPTO_LIST.includes(clean) || KNOWN_CRYPTO_LIST.includes(rawClean) || clean.endsWith('USDT')) {
    const symbol = (rawClean || clean).toLowerCase();
    return `https://assets.coincap.io/assets/icons/${symbol}@2x.png`;
  }

  // Se for B3: busca do repositório oficial de ícones B3
  return `https://raw.githubusercontent.com/thefintz/icones-b3/main/icones/${clean}.png`;
}

function getTickerColorGradient(ticker) {
  const gradients = [
    'linear-gradient(135deg, #2563eb, #1d4ed8)',
    'linear-gradient(135deg, #059669, #047857)',
    'linear-gradient(135deg, #d97706, #b45309)',
    'linear-gradient(135deg, #7c3aed, #6d28d9)',
    'linear-gradient(135deg, #dc2626, #b91c1c)',
    'linear-gradient(135deg, #0891b2, #0e7490)',
    'linear-gradient(135deg, #4f46e5, #4338ca)',
  ];
  let hash = 0;
  for (let i = 0; i < ticker.length; i++) hash += ticker.charCodeAt(i);
  return gradients[Math.abs(hash) % gradients.length];
}

function renderAssetLogoHtml(ticker, cssClass = 'asset-logo') {
  const clean = (ticker || '').toUpperCase().trim();
  const initials = clean.replace(/[^A-Z0-9]/g, '').slice(0, 4) || clean.slice(0, 4);
  const url = getAssetLogoUrl(clean);
  const fbClass = cssClass === 'explorer-logo' ? 'explorer-logo-fb' : cssClass === 'fav-logo' ? 'fav-logo-fb' : 'asset-logo-fallback';
  const baseTicker = clean.replace(/\d+$/, '');
  const bgGradient = getTickerColorGradient(clean);

  return `
    <div class="${cssClass}" title="${clean}" style="background:transparent;">
      <img src="${url}" alt="${clean}" loading="lazy"
           onerror="
             const fallbackUrl = 'https://raw.githubusercontent.com/thefintz/icones-b3/main/icones/${baseTicker}.png';
             if (this.src !== fallbackUrl && !this.dataset.tried) {
               this.dataset.tried = '1';
               this.src = fallbackUrl;
             } else {
               this.style.display = 'none';
               if (this.nextElementSibling) this.nextElementSibling.style.display = 'flex';
             }
           " />
      <span class="${fbClass}" style="display:none;background:${bgGradient};color:#fff;font-weight:700;border-radius:inherit;width:100%;height:100%;align-items:center;justify-content:center;letter-spacing:-0.03em;">${initials}</span>
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

/* ═══════════════════════════════════════════════════════════
   SERVIÇO DE SINCRONIZAÇÃO EM NUVEM (ZERO-KNOWLEDGE)
   ═══════════════════════════════════════════════════════════ */
let isLocallyModified = false;

const SyncService = {
  pushTimer: null,
  syncInterval: null,

  getSyncId() {
    let id = localStorage.getItem(SYNC_ID_KEY);
    if (!id) {
      const r = () => Math.random().toString(36).substring(2, 6).toUpperCase();
      id = `CAD-${r()}-${r()}`;
      localStorage.setItem(SYNC_ID_KEY, id);
    }
    return id.toUpperCase().trim();
  },

  setSyncId(id) {
    if (id) {
      localStorage.setItem(SYNC_ID_KEY, id.toUpperCase().trim());
      this.updateUi();
    }
  },

  getEndpoint() {
    return localStorage.getItem(CLOUD_ENDPOINT_KEY) || DEFAULT_CLOUD_URL;
  },

  getToken() {
    // Sanitização: se tiver o token antigo corrompido no localStorage, limpa e usa o padrão
    const saved = localStorage.getItem(CLOUD_TOKEN_KEY);
    if (saved && (saved.includes('AAAAAAAZ8UA') || saved.length > 70)) {
      localStorage.removeItem(CLOUD_TOKEN_KEY);
      return DEFAULT_CLOUD_TOKEN;
    }
    return saved || DEFAULT_CLOUD_TOKEN;
  },

  setUiStatus(status, text = null) {
    const pill = document.getElementById('cloud-sync-pill');
    const pillText = document.getElementById('cloud-sync-text');
    const statusDesc = document.getElementById('cfg-sync-status-desc');
    const syncTime = document.getElementById('cfg-sync-time');

    if (!pill) return;
    pill.classList.remove('syncing', 'offline');

    if (status === 'syncing') {
      pill.classList.add('syncing');
      if (pillText) pillText.textContent = text || 'Sincronizando…';
      if (statusDesc) {
        statusDesc.innerHTML = `<span class="sync-status-indicator syncing">●</span> Enviando alterações para a nuvem…`;
      }
    } else if (status === 'offline') {
      pill.classList.add('offline');
      if (pillText) pillText.textContent = text || 'Nuvem offline';
      if (statusDesc) {
        statusDesc.innerHTML = `<span class="sync-status-indicator" style="color:var(--text-muted);">○</span> Sem conexão com a nuvem (dados salvos localmente)`;
      }
    } else {
      const last = localStorage.getItem(LAST_SYNC_KEY);
      let timeStr = 'Agora';
      if (last) {
        const d = new Date(parseInt(last));
        timeStr = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      }
      if (pillText) pillText.textContent = text || 'Sincronizado';
      if (syncTime) syncTime.textContent = `Última: ${timeStr}`;
      if (statusDesc) {
        statusDesc.innerHTML = `<span class="sync-status-indicator online">●</span> Cofre sincronizado com a nuvem · <span id="cfg-sync-time">Última: ${timeStr}</span>`;
      }
    }
  },

  async pushVault(force = false) {
    if (!derivedKey) return false;

    // Garante que o estado mais recente em memória está cifrado e salvo
    const freshEnc = encryptState(derivedKey);
    if (freshEnc) {
      localStorage.setItem(STORAGE_KEY, freshEnc);
    }

    const authMeta = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null');
    const encData  = localStorage.getItem(STORAGE_KEY);
    if (!authMeta || !encData) return false;

    const syncId   = this.getSyncId();
    const endpoint = this.getEndpoint();
    const token    = this.getToken();

    const payload = {
      syncId,
      authMeta,
      encData,
      updatedAt: Date.now(),
      version: APP_VERSION,
    };

    this.setUiStatus('syncing');
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(['SET', `caderneta:vault:${syncId}`, JSON.stringify(payload)]),
      });

      if (res.ok) {
        localStorage.setItem(LAST_SYNC_KEY, payload.updatedAt.toString());
        isLocallyModified = false;
        this.setUiStatus('online');
        return true;
      } else {
        this.setUiStatus('offline');
        return false;
      }
    } catch {
      this.setUiStatus('offline');
      return false;
    }
  },

  debouncedPush() {
    isLocallyModified = true;
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      this.pushVault();
    }, 400);
  },

  async fetchVault(syncId) {
    const cleanId = (syncId || '').toUpperCase().trim();
    if (!cleanId) return null;

    const endpoint = this.getEndpoint();
    const token    = this.getToken();

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(['GET', `caderneta:vault:${cleanId}`]),
      });

      if (!res.ok) return null;
      const data = await res.json();
      if (!data || !data.result) return null;
      return JSON.parse(data.result);
    } catch {
      return null;
    }
  },

  async connectWallet(syncId, pin) {
    const cleanId = (syncId || '').toUpperCase().trim();
    if (!cleanId) return { success: false, error: 'ID de sincronização inválido.' };
    if (!pin || pin.length < 4) return { success: false, error: 'PIN muito curto.' };

    const vault = await this.fetchVault(cleanId);
    if (!vault || !vault.authMeta || !vault.encData) {
      return { success: false, error: 'Carteira não encontrada na nuvem com este ID.' };
    }

    // Validação do hash do PIN
    const expectedHash = hashPin(pin, vault.authMeta.salt);
    if (expectedHash !== vault.authMeta.verifyHash) {
      return { success: false, error: 'PIN incorreto para esta carteira.' };
    }

    // Deriva chave AES e decifra dados
    const key = deriveKey(pin, vault.authMeta.salt);
    const decrypted = decryptState(vault.encData, key);
    if (!decrypted) {
      return { success: false, error: 'Erro ao decifrar cofre com este PIN.' };
    }

    // Salva estado sincronizado localmente
    localStorage.setItem(SYNC_ID_KEY, cleanId);
    localStorage.setItem(AUTH_KEY, JSON.stringify(vault.authMeta));
    localStorage.setItem(STORAGE_KEY, vault.encData);
    localStorage.setItem(LAST_SYNC_KEY, (vault.updatedAt || Date.now()).toString());

    derivedKey = key;
    isLocallyModified = false;
    state = { portfolio: [], watchlist: [], best: JSON.parse(JSON.stringify(DEFAULT_BEST)), ...decrypted };
    if (!state.best || !Array.isArray(state.best) || state.best.length === 0) {
      state.best = JSON.parse(JSON.stringify(DEFAULT_BEST));
    }
    saveAuthAttempts({});
    this.updateUi();
    return { success: true };
  },

  async checkBackgroundSync(silent = true) {
    if (!derivedKey) return;
    const syncId = this.getSyncId();
    const localEnc = localStorage.getItem(STORAGE_KEY);
    const lastLocalSync = parseInt(localStorage.getItem(LAST_SYNC_KEY) || '0');

    try {
      const vault = await this.fetchVault(syncId);
      if (!vault) {
        // Enviar cofre local para inicializar na nuvem se ainda não existir
        if (localEnc) await this.pushVault(true);
        return;
      }

      // Se o cofre na nuvem for diferente do cofre local
      if (vault.encData && vault.encData !== localEnc) {
        const cloudTime = parseInt(vault.updatedAt || '0');

        // Se a nuvem tiver atualização ou se o local não estiver com edições pendentes
        if (cloudTime >= lastLocalSync || !isLocallyModified) {
          const meta = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null');
          if (meta && derivedKey) {
            const decrypted = decryptState(vault.encData, derivedKey);
            if (decrypted) {
              state = { portfolio: [], watchlist: [], best: JSON.parse(JSON.stringify(DEFAULT_BEST)), ...decrypted };
              if (!state.best || !Array.isArray(state.best) || state.best.length === 0) {
                state.best = JSON.parse(JSON.stringify(DEFAULT_BEST));
              }
              localStorage.setItem(STORAGE_KEY, vault.encData);
              localStorage.setItem(LAST_SYNC_KEY, cloudTime.toString());
              if (vault.authMeta) {
                localStorage.setItem(AUTH_KEY, JSON.stringify(vault.authMeta));
              }
              isLocallyModified = false;
              renderAll();
              this.setUiStatus('online');
              if (!silent) {
                showToast('Carteira sincronizada com a nuvem!', 'success');
              }
              return;
            }
          }
        } else if (isLocallyModified) {
          // O usuário fez edições locais nesta sessão que ainda não subiram
          await this.pushVault(true);
        }
      } else {
        this.setUiStatus('online');
        if (!silent) {
          showToast('Tudo atualizado! Sua carteira já está sincronizada.', 'info');
        }
      }
    } catch (err) {
      this.setUiStatus('offline');
      if (!silent) {
        showToast('Erro ao sincronizar com a nuvem. Verifique a conexão.', 'error');
      }
    }
  },

  startPeriodicSync() {
    if (this.syncInterval) clearInterval(this.syncInterval);
    // Sincronização automática a cada 20 segundos em segundo plano
    this.syncInterval = setInterval(() => {
      this.checkBackgroundSync(true);
    }, 20000);
  },

  updateUi() {
    const syncId = this.getSyncId();
    const cfgSyncEl = document.getElementById('cfg-sync-id');
    const qrModalEl = document.getElementById('qr-modal-sync-id');
    if (cfgSyncEl) cfgSyncEl.textContent = syncId;
    if (qrModalEl) qrModalEl.textContent = syncId;
    this.setUiStatus('online');
  }
};

// Sincronização instantânea ao focar ou voltar para a aba
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && derivedKey) {
    SyncService.checkBackgroundSync(true);
  }
});

window.addEventListener('focus', () => {
  if (derivedKey) {
    SyncService.checkBackgroundSync(true);
  }
});

/* ─── Alternador de Modo de Login ────────────────────────── */
function switchLoginMode(mode) {
  const tabPin   = document.getElementById('tab-login-pin');
  const tabSync  = document.getElementById('tab-login-sync');
  const formPin  = document.getElementById('login-form');
  const formSync = document.getElementById('sync-connect-form');
  const errSync  = document.getElementById('sync-connect-error');

  if (errSync) errSync.style.display = 'none';

  if (mode === 'sync') {
    if (tabPin)  tabPin.classList.remove('active');
    if (tabSync) tabSync.classList.add('active');
    if (formPin) formPin.style.display = 'none';
    if (formSync) {
      formSync.style.display = 'block';
      setTimeout(() => document.getElementById('sync-input-id')?.focus(), 50);
    }
  } else {
    if (tabSync) tabSync.classList.remove('active');
    if (tabPin)  tabPin.classList.add('active');
    if (formSync) formSync.style.display = 'none';
    if (formPin) {
      formPin.style.display = 'block';
      setTimeout(() => document.getElementById('login-pin')?.focus(), 50);
    }
  }
}

/* ─── Helpers de Parsing e Aplicação de Cofre (Zero-Knowledge) ─── */
function parseVaultTransferBlob(str) {
  if (!str) return null;
  const raw = str.trim();
  try {
    const jsonStr = decodeURIComponent(escape(atob(raw)));
    const parsed = JSON.parse(jsonStr);
    if (parsed && parsed.authMeta && parsed.encData) return parsed;
  } catch {}
  try {
    const jsonStr = decodeURIComponent(atob(raw));
    const parsed = JSON.parse(jsonStr);
    if (parsed && parsed.authMeta && parsed.encData) return parsed;
  } catch {}
  try {
    const parsed = JSON.parse(atob(raw));
    if (parsed && parsed.authMeta && parsed.encData) return parsed;
  } catch {}
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.authMeta && parsed.encData) return parsed;
  } catch {}
  return null;
}

function applyDecryptedVault(vault, pin) {
  if (!vault || !vault.authMeta || !vault.encData) {
    return { success: false, error: 'Dados do cofre inválidos ou incompletos.' };
  }
  if (!pin || pin.length < 4) {
    return { success: false, error: 'PIN deve ter pelo menos 4 caracteres.' };
  }

  const expectedHash = hashPin(pin, vault.authMeta.salt);
  if (expectedHash !== vault.authMeta.verifyHash) {
    return { success: false, error: 'PIN incorreto para esta carteira.' };
  }

  const key = deriveKey(pin, vault.authMeta.salt);
  const decrypted = decryptState(vault.encData, key);
  if (!decrypted) {
    return { success: false, error: 'Erro ao decifrar os dados. Verifique seu PIN.' };
  }

  // Atualiza armazenamento local com todos os novos lançamentos do cofre recebido
  const newSyncId = (vault.syncId || SyncService.getSyncId()).toUpperCase().trim();
  localStorage.setItem(SYNC_ID_KEY, newSyncId);
  localStorage.setItem(AUTH_KEY, JSON.stringify(vault.authMeta));
  localStorage.setItem(STORAGE_KEY, vault.encData);
  localStorage.setItem(LAST_SYNC_KEY, (vault.updatedAt || Date.now()).toString());

  derivedKey = key;
  isLocallyModified = false;
  state = { portfolio: [], watchlist: [], best: JSON.parse(JSON.stringify(DEFAULT_BEST)), ...decrypted };
  if (!state.best || !Array.isArray(state.best) || state.best.length === 0) {
    state.best = JSON.parse(JSON.stringify(DEFAULT_BEST));
  }
  saveAuthAttempts({});
  window.pendingVaultTransfer = null;
  const banner = document.getElementById('detected-vault-banner');
  if (banner) banner.style.display = 'none';

  try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch {}
  return { success: true };
}

/* ─── Detecção de Cofre na URL ───────────────────────────── */
function checkVaultInUrl() {
  if (!window.location.hash) return;

  // 1. Detecta cofre transferido diretamente via hash (#vault=...)
  if (window.location.hash.includes('vault=')) {
    try {
      const raw = window.location.hash.split('vault=')[1].split('&')[0];
      const parsed = parseVaultTransferBlob(raw);
      if (parsed && parsed.authMeta && parsed.encData) {
        window.pendingVaultTransfer = parsed;
        const banner = document.getElementById('detected-vault-banner');
        if (banner) banner.style.display = 'block';

        const inputId = document.getElementById('sync-input-id');
        if (inputId) {
          inputId.value = parsed.syncId || 'CARTEIRA-DETECTADA';
          inputId.style.borderColor = 'var(--accent-green)';
        }
        showToast('📱 Carteira do Smartphone detectada! Digite seu PIN para abrir.', 'success');
        setTimeout(() => {
          const pinInput = document.getElementById('login-pin') || document.getElementById('sync-input-pin');
          pinInput?.focus();
        }, 120);
        return;
      }
    } catch (e) {
      console.warn('Erro ao decodificar cofre da URL:', e);
    }
  }

  // 2. Detecta link com sync ID (#sync=CAD-XXXX-XXXX)
  if (window.location.hash.includes('sync=')) {
    const match = window.location.hash.match(/sync=([A-Za-z0-9-]+)/i);
    if (match && match[1]) {
      const syncId = match[1].toUpperCase();
      switchLoginMode('sync');
      const inputId = document.getElementById('sync-input-id');
      if (inputId) inputId.value = syncId;
      setTimeout(() => document.getElementById('sync-input-pin')?.focus(), 100);
      showToast(`ID de Sincronização detectado: ${syncId}`, 'info');
    }
  }
}

// Ouvir alterações na hash em tempo de execução (ex: se o usuário colar o link com o app aberto)
window.addEventListener('hashchange', () => {
  checkVaultInUrl();
});

/* ─── Login Flow ─────────────────────────────────────────── */
function initLoginScreen() {
  const meta = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null');
  if (!meta) {
    // Primeiro acesso — sem dados ainda
    isFirstAccess = true;
    const msg = document.getElementById('first-access-msg');
    if (msg) msg.style.display = 'block';
  }

  if (isBlocked()) {
    showBlockedUI();
  }

  checkVaultInUrl();
}

function showBlockedUI() {
  const blockedEl = document.getElementById('login-blocked');
  if (blockedEl) blockedEl.style.display = 'block';
  const loginBtn = document.getElementById('login-btn');
  if (loginBtn) loginBtn.disabled = true;
  const update = () => {
    const rem = getRemainingBlockMinutes();
    const timerEl = document.getElementById('block-timer');
    if (timerEl) timerEl.textContent = rem;
    if (rem <= 0) {
      if (blockedEl) blockedEl.style.display = 'none';
      if (loginBtn) loginBtn.disabled = false;
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

  // 1. Caso haja cofre recebido via URL pendente (#vault=...)
  if (window.pendingVaultTransfer) {
    const res = applyDecryptedVault(window.pendingVaultTransfer, pin);
    if (res.success) {
      btn.disabled = false;
      btn.textContent = 'Entrar';
      showToast('Carteira do Smartphone carregada com sucesso!', 'success');
      openApp();
      return;
    } else {
      showLoginError('PIN incorreto para a carteira recebida do smartphone.');
      btn.disabled = false;
      btn.textContent = 'Entrar';
      return;
    }
  }

  // 2. Fluxo normal local
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
        const attemptsInfo = document.getElementById('login-attempts-info');
        if (attemptsInfo) {
          attemptsInfo.textContent = `${attempts.count} de ${MAX_ATTEMPTS} tentativas usadas.`;
        }
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

/* Formulário de Conexão com Carteira (Nuvem ou Transferência Direta) */
document.getElementById('sync-connect-form').addEventListener('submit', async function(e) {
  e.preventDefault();

  const syncInput = (document.getElementById('sync-input-id').value || '').trim();
  const pin       = document.getElementById('sync-input-pin').value;
  const errEl     = document.getElementById('sync-connect-error');
  const btn       = document.getElementById('sync-connect-btn');

  if (errEl) errEl.style.display = 'none';

  if (!syncInput || syncInput.length < 5) {
    if (errEl) {
      errEl.textContent = 'Informe o Link de Acesso, Código do Cofre ou Sync ID.';
      errEl.style.display = 'block';
    }
    return;
  }
  if (!pin || pin.length < 4) {
    if (errEl) {
      errEl.textContent = 'PIN deve ter pelo menos 4 caracteres.';
      errEl.style.display = 'block';
    }
    return;
  }

  btn.disabled = true;
  btn.innerHTML = `<svg class="spinning" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg> Descriptografando e conectando…`;

  // 1. Caso venha via link direto (#vault=...)
  let vault = window.pendingVaultTransfer;

  // 2. Caso o usuário tenha colado o Link completo (#vault=...) ou o Código do Cofre (base64) no campo
  if (!vault) {
    let rawBlob = syncInput;
    if (syncInput.includes('#vault=')) {
      rawBlob = syncInput.split('#vault=')[1].split('&')[0];
    } else if (syncInput.includes('vault=')) {
      rawBlob = syncInput.split('vault=')[1].split('&')[0];
    }
    vault = parseVaultTransferBlob(rawBlob);
  }

  // Se tivermos o vault em mãos (via link ou código colado)
  if (vault && vault.authMeta && vault.encData) {
    const res = applyDecryptedVault(vault, pin);
    if (res.success) {
      btn.disabled = false;
      btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Conectar e Sincronizar`;
      showToast('Carteira conectada e sincronizada com sucesso!', 'success');
      openApp();
      return;
    } else {
      if (errEl) {
        errEl.textContent = res.error || 'PIN incorreto para este cofre.';
        errEl.style.display = 'block';
      }
      btn.disabled = false;
      btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Conectar e Sincronizar`;
      return;
    }
  }

  // 3. Caso padrão: busca pelo Sync ID na nuvem
  const cleanSyncId = syncInput.toUpperCase().replace(/.*SYNC=/i, '').split('&')[0].trim();
  try {
    const res = await SyncService.connectWallet(cleanSyncId, pin);
    if (res.success) {
      showToast('Carteira conectada e sincronizada com sucesso!', 'success');
      openApp();
    } else {
      if (errEl) {
        errEl.innerHTML = `${res.error || 'Cofre não encontrado para este ID.'}<br><span style="font-size:0.75rem;display:inline-block;margin-top:4px;">💡 <strong>Dica rápida:</strong> No seu celular, abra <em>Ajustes &gt; Transferência Celular ↔ PC</em> e use <strong>"Copiar Link Direto"</strong> ou <strong>"Copiar Código do Cofre"</strong> para transferir diretamente.</span>`;
        errEl.style.display = 'block';
      }
    }
  } catch (err) {
    if (errEl) {
      errEl.innerHTML = `Erro ao conectar com a nuvem.<br><span style="font-size:0.75rem;display:inline-block;margin-top:4px;">💡 <strong>Dica rápida:</strong> No seu celular, abra <em>Ajustes &gt; Transferência Celular ↔ PC</em> e use <strong>"Copiar Link Direto"</strong> para transferir instantaneamente.</span>`;
      errEl.style.display = 'block';
    }
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Conectar e Sincronizar`;
  }
});

function showLoginError(msg) {
  const el = document.getElementById('login-error');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 4000);
}

/* ─── Modo Privacidade ─────────────────────────────────────── */
let privacyMode = false;

function togglePrivacyMode() {
  privacyMode = !privacyMode;
  document.body.classList.toggle('privacy-mode', privacyMode);
  const btn = document.getElementById('btn-privacy-toggle');
  if (btn) {
    btn.title = privacyMode ? 'Exibir valores' : 'Ocultar valores';
    btn.innerHTML = privacyMode
      ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`
      : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
  }
  renderSummary();
}

function fmtPrivate(val) {
  if (privacyMode) return 'R$ ••••••';
  return fmt(val);
}

function fmtNPrivate(val) {
  if (privacyMode) return '••••';
  return fmtN(val);
}

/* ─── Exportar CSV ────────────────────────────────────────── */
function exportPortfolioCSV() {
  const header = ['Ticker','Nome','Tipo','Quantidade','Preço Médio','Preço Atual','Total Investido','Valor Atual','P&L R$','P&L %','Notas'];
  const rows = [header];

  state.portfolio.forEach(a => {
    const qty = parseFloat(a.quantity) || 0;
    const avg = parseFloat(a.avgPrice) || 0;
    const quote = getStockQuoteData(a.ticker);
    const cur = (a.currentPrice != null && parseFloat(a.currentPrice) > 0)
      ? parseFloat(a.currentPrice) : (quote?.price ?? avg);
    const inv = qty * avg;
    const atl = qty * cur;
    const pnl = atl - inv;
    const pct = inv > 0 ? (pnl / inv) * 100 : 0;
    rows.push([
      a.ticker, a.name || '', a.type,
      qty.toString().replace('.', ','),
      avg.toFixed(2).replace('.', ','),
      cur.toFixed(2).replace('.', ','),
      inv.toFixed(2).replace('.', ','),
      atl.toFixed(2).replace('.', ','),
      pnl.toFixed(2).replace('.', ','),
      pct.toFixed(2).replace('.', ',') + '%',
      (a.notes || '').replace(/;/g, ' '),
    ]);
  });

  // Separador ponto e vírgula para compatibilidade com Excel brasileiro
  const csvContent = rows.map(r => r.map(v => `"${v}"`).join(';')).join('\n');
  const bom = '\uFEFF'; // BOM para UTF-8 no Excel
  const blob = new Blob([bom + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `caderneta-carteira-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('CSV da carteira exportado!', 'success');
}

/* ─── Undo Delete ─────────────────────────────────────────── */
let _undoData = null;
let _undoTimer = null;

function showToastWithUndo(msg, onUndo) {
  // Limpar toast anterior se ainda estiver visível
  if (_undoTimer) clearTimeout(_undoTimer);

  const container = document.getElementById('toast-container');
  const existing = document.getElementById('toast-undo');
  if (existing) existing.remove();

  const el = document.createElement('div');
  el.className = 'toast info';
  el.id = 'toast-undo';
  el.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:260px;';
  el.innerHTML = `<span>${escapeHtml(msg)}</span>
    <button onclick="(${onUndo.toString()})()" style="background:rgba(88,166,255,.2);border:1px solid rgba(88,166,255,.4);color:var(--accent-blue);padding:3px 10px;border-radius:4px;font-size:0.75rem;font-weight:600;cursor:pointer;white-space:nowrap;flex-shrink:0;">
      Desfazer
    </button>`;
  container.appendChild(el);

  _undoTimer = setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
    _undoData = null;
  }, 5000);
}

function deleteAssetWithUndo(id) {
  const item = state.portfolio.find(a => a.id === id);
  if (!item) return;
  _undoData = { list: 'portfolio', item };
  state.portfolio = state.portfolio.filter(a => a.id !== id);
  saveEncryptedState(); renderAll();
  showToastWithUndo(`${item.ticker} removido da carteira`, () => {
    if (_undoData && _undoData.list === 'portfolio') {
      state.portfolio.push(_undoData.item);
      _undoData = null;
      saveEncryptedState(); renderAll();
      showToast('Remoção desfeita.', 'success');
    }
  });
}

function deleteWatchlistItemWithUndo(id) {
  const item = state.watchlist.find(a => a.id === id);
  if (!item) return;
  _undoData = { list: 'watchlist', item };
  state.watchlist = state.watchlist.filter(a => a.id !== id);
  saveEncryptedState(); renderAll();
  showToastWithUndo(`${item.ticker} removido dos Favoritos`, () => {
    if (_undoData && _undoData.list === 'watchlist') {
      state.watchlist.push(_undoData.item);
      _undoData = null;
      saveEncryptedState(); renderAll();
      showToast('Remoção desfeita.', 'success');
    }
  });
}

function openApp() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app').style.display = 'flex';
  document.getElementById('app').style.flexDirection = 'column';
  startSessionTimer();
  renderAll();
  renderFavoritosWidget();
  enableScrollDrag('favoritos-scroll');
  initExplorer();
  refreshAllQuotes();
  refreshBestQuotes();
  SyncService.updateUi();
  SyncService.checkBackgroundSync(true);
  SyncService.startPeriodicSync();
}

function handleLogout() {
  derivedKey = null;
  state = { portfolio: [], watchlist: [], best: [] };
  explorerPrices = {};
  bestPrices = {};
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-pin').value = '';
  document.getElementById('sync-input-pin').value = '';
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
  if (enc) {
    localStorage.setItem(STORAGE_KEY, enc);
    SyncService.debouncedPush();
  }
}

/* ─── Cotações Base de Fechamento (Último Fechamento da B3 / Fallback) ─ */
const BASELINE_CLOSING_PRICES = {
  'BBSE3':  { price: 42.16, change: 1.13,  name: 'BB Seguridade' },
  'BBAS3':  { price: 22.52, change: 0.31,  name: 'Banco do Brasil' },
  'CMIG4':  { price: 11.26, change: 0.72,  name: 'Cemig' },
  'TAEE11': { price: 41.53, change: -0.05, name: 'Taesa' },
  'TRPL4':  { price: 27.70, change: 0.22,  name: 'ISA Cteep' },
  'UNIP6':  { price: 56.97, change: -0.47, name: 'Unipar' },
  'SANB4':  { price: 15.03, change: -0.73, name: 'Santander Brasil' },
  'AURE3':  { price: 12.00, change: 3.18,  name: 'Auren Energia' },
  'KLBN4':  { price: 3.85,  change: -0.26, name: 'Klabin' },
  'IRBR3':  { price: 62.21, change: 4.64,  name: 'IRB Brasil' },
  'PETR4':  { price: 37.85, change: 0.53,  name: 'Petrobras PN' },
  'VALE3':  { price: 61.20, change: -0.81, name: 'Vale S.A.' },
  'ITUB4':  { price: 34.60, change: 0.29,  name: 'Itaú Unibanco PN' },
  'WEGE3':  { price: 52.40, change: 1.12,  name: 'WEG S.A.' },
  'HGLG11': { price: 165.20, change: 0.12, name: 'CSHG Logística' },
  'BOVA11': { price: 132.50, change: 0.45, name: 'iShares Ibovespa' },
  'XPLG11': { price: 104.80, change: -0.15, name: 'XP Log' },
  'PRIO3':  { price: 46.80, change: 1.30,  name: 'PRIO S.A.' },
  'B3SA3':  { price: 10.95, change: -0.18, name: 'B3 S.A.' },
  'BBDC4':  { price: 14.30, change: 0.28,  name: 'Bradesco PN' },
  'ABEV3':  { price: 12.35, change: -0.40, name: 'Ambev' },
  'RENT3':  { price: 44.80, change: -0.65, name: 'Localiza' },
  'SBSP3':  { price: 91.50, change: 0.85,  name: 'Sabesp' },
  'SUZB3':  { price: 57.20, change: 1.05,  name: 'Suzano' },
  'LREN3':  { price: 16.85, change: 0.35,  name: 'Lojas Renner' },
  'MGLU3':  { price: 8.90,  change: -1.20, name: 'Magazine Luiza' },
  'MXRF11': { price: 10.15, change: 0.00,  name: 'Maxi Renda' },
  'KNIP11': { price: 94.50, change: 0.15,  name: 'Kinea IP' },
  'KNCR11': { price: 103.80,change: 0.10,  name: 'Kinea Rendimentos' },
  'BTLG11': { price: 101.40,change: -0.10, name: 'BTG Logística' },
  'XPML11': { price: 112.50,change: 0.20,  name: 'XP Malls' },
  'IVVB11': { price: 348.00,change: 0.60,  name: 'iShares S&P 500' },
};

/** Verifica se a bolsa brasileira B3 está no horário de negociação aberto */
function isB3MarketOpen() {
  try {
    const now = new Date();
    // Converter para Horário Oficial de Brasília (UTC-3)
    const spStr = now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' });
    const spDate = new Date(spStr);
    const day = spDate.getDay(); // 0 = Domingo, 6 = Sábado
    if (day === 0 || day === 6) return false;

    const m = spDate.getMonth() + 1;
    const d = spDate.getDate();
    // Feriados nacionais principais B3
    if ((m === 1 && d === 1) || (m === 4 && d === 21) || (m === 5 && d === 1) ||
        (m === 9 && d === 7) || (m === 10 && d === 12) || (m === 11 && (d === 2 || d === 15 || d === 20)) ||
        (m === 12 && d === 25)) {
      return false;
    }

    const minutes = spDate.getHours() * 60 + spDate.getMinutes();
    // Sessão regular B3: 10h00 (600m) às 17h30 (1050m)
    return minutes >= 600 && minutes <= 1050;
  } catch {
    return false;
  }
}

/** Obtém cotação para exibição: se mercado fechado, prioriza último valor de fechamento */
function getStockQuoteData(ticker) {
  const clean = (ticker || '').toUpperCase().trim();
  const marketOpen = isB3MarketOpen();

  // 1. Cache do QuoteService (fonte primária) ou Best
  const qCache = QuoteService.cache[clean];
  const bCache = bestPrices[clean];
  // explorerPrices só é usado se tiver .price numérico (estrutura confirmada)
  const eCache = (explorerPrices[clean] && typeof explorerPrices[clean].price === 'number') ? explorerPrices[clean] : null;
  const cached = bCache || qCache || eCache;
  if (cached && cached.price != null) {
    return {
      price: cached.price,
      change: cached.change ?? cached.changePercent ?? 0,
      name: cached.name || clean,
      isClosed: !marketOpen || Boolean(cached.isClosed),
    };
  }

  // 2. Valores cadastrados no portfólio ou radar
  const portItem = state.portfolio.find(p => p.ticker === clean);
  if (portItem && portItem.currentPrice != null) {
    return {
      price: portItem.currentPrice,
      change: 0,
      name: portItem.name || clean,
      isClosed: !marketOpen,
    };
  }

  const watchItem = state.watchlist.find(w => w.ticker === clean);
  if (watchItem && watchItem.currentPrice != null) {
    return {
      price: watchItem.currentPrice,
      change: 0,
      name: watchItem.name || clean,
      isClosed: !marketOpen,
    };
  }

  // 3. Fallback de fechamento real para ativos conhecidos
  if (BASELINE_CLOSING_PRICES[clean]) {
    const base = BASELINE_CLOSING_PRICES[clean];
    return {
      price: base.price,
      change: base.change,
      name: base.name || clean,
      isClosed: true,
    };
  }

  return {
    price: null,
    change: null,
    name: clean,
    isClosed: !marketOpen,
  };
}

/* ═══════════════════════════════════════════════════════════
   COTAÇÕES — YAHOO FINANCE + BINANCE
   ═══════════════════════════════════════════════════════════ */

const QuoteService = {
  cache: {},
  CACHE_TTL: 5 * 60 * 1000,

  async fetchYahoo(symbols) {
    if (!symbols || symbols.length === 0) return {};
    const result = {};
    const marketOpen = isB3MarketOpen();

    const fetchOne = async (rawSymbol) => {
      const clean = rawSymbol.toUpperCase().trim();
      let yahooTicker = clean;
      if (clean === 'TRPL4') {
        yahooTicker = 'ISAE4.SA'; // Ticker atualizado na B3
      } else if (/^[A-Z]{3,6}\d{1,2}$/.test(clean) || /^[A-Z]{3,4}34$/.test(clean)) {
        yahooTicker = clean + '.SA';
      }

      const chartUrl = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker)}?interval=1d&range=1d`;

      for (const proxy of CORS_PROXIES) {
        try {
          const targetUrl = proxy.includes('corsproxy.io')
            ? `https://corsproxy.io/?${encodeURIComponent(chartUrl)}`
            : `${proxy}${encodeURIComponent(chartUrl)}`;

          const res = await fetch(targetUrl, { signal: AbortSignal.timeout(4500) });
          if (!res.ok) continue;
          const data = await res.json();
          const meta = data?.chart?.result?.[0]?.meta;
          if (meta) {
            // Se o mercado está fechado, o regularMarketPrice representa o último preço de fechamento
            const price = meta.regularMarketPrice ?? meta.chartPreviousClose ?? null;
            const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? price;
            let change = 0;
            if (price != null && prevClose != null && prevClose > 0) {
              change = ((price - prevClose) / prevClose) * 100;
            }
            result[clean] = {
              price,
              previousClose: prevClose,
              change,
              name: meta.shortName || clean,
              isClosed: !marketOpen,
            };
            return;
          }
        } catch { /* tentar próximo proxy */ }
      }
    };

    await Promise.allSettled(symbols.map(s => fetchOne(s)));
    return result;
  },

  async fetchBinance(symbols) {
    if (!symbols || !symbols.length) return {};
    const result = {};

    // Cache da taxa USDT→BRL por 10 minutos para evitar requisições extras
    const now = Date.now();
    if (!this._usdtBrlTs || (now - this._usdtBrlTs) > 600000) {
      try {
        const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=USDTBRL',
          { signal: AbortSignal.timeout(3500) });
        if (r.ok) {
          const d = await r.json();
          if (d?.price) { this._usdtBrl = parseFloat(d.price); this._usdtBrlTs = now; }
        }
      } catch { /* usa taxa padrão */ }
    }
    const usdtBrlRate = this._usdtBrl || 5.85;

    // Montar pares: preferir BRL direto; se não existir, usar USDT e converter
    const brlPairs = [];
    const usdtPairs = [];
    const symbolOfBrl  = {}; // "BTCBRL"  -> "BTC"
    const symbolOfUsdt = {}; // "BTCUSDT" -> "BTC"

    for (const raw of symbols) {
      const clean = raw.toUpperCase().trim().replace(/USDT$|BRL$|BTC$/, '');
      const sym = clean || raw.toUpperCase().trim();
      brlPairs.push(`${sym}BRL`);
      usdtPairs.push(`${sym}USDT`);
      symbolOfBrl[`${sym}BRL`]  = raw.toUpperCase().trim();
      symbolOfUsdt[`${sym}USDT`] = raw.toUpperCase().trim();
    }

    try {
      // Uma única requisição batch com todos os pares BRL
      const qs = encodeURIComponent(JSON.stringify([...new Set(brlPairs)]));
      const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbols=${qs}`,
        { signal: AbortSignal.timeout(5000) });

      const foundSymbols = new Set();
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          for (const t of data) {
            const original = symbolOfBrl[t.symbol];
            if (!original) continue;
            const price = parseFloat(t.lastPrice);
            if (!price) continue;
            result[original] = {
              price,
              change: parseFloat(t.priceChangePercent),
              changePercent: parseFloat(t.priceChangePercent),
              name: `${original} (Binance)`,
              isClosed: false,
            };
            foundSymbols.add(original);
          }
        }
      }

      // Para símbolos sem par BRL, tentar USDT e converter
      const missingSymbols = symbols.filter(s => !foundSymbols.has(s.toUpperCase().trim()));
      if (missingSymbols.length > 0) {
        const missingPairs = missingSymbols.map(s => {
          const clean = s.toUpperCase().trim().replace(/USDT$|BRL$|BTC$/, '') || s.toUpperCase().trim();
          return `${clean}USDT`;
        });
        try {
          const qs2 = encodeURIComponent(JSON.stringify([...new Set(missingPairs)]));
          const res2 = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbols=${qs2}`,
            { signal: AbortSignal.timeout(4000) });
          if (res2.ok) {
            const data2 = await res2.json();
            if (Array.isArray(data2)) {
              for (const t of data2) {
                const original = symbolOfUsdt[t.symbol];
                if (!original || result[original]) continue;
                const price = parseFloat(t.lastPrice) * usdtBrlRate;
                if (!price) continue;
                result[original] = {
                  price,
                  change: parseFloat(t.priceChangePercent),
                  changePercent: parseFloat(t.priceChangePercent),
                  name: `${original} (Binance)`,
                  isClosed: false,
                };
              }
            }
          }
        } catch { /* ignora pares USDT não encontrados */ }
      }
    } catch (e) {
      console.warn('Erro ao consultar Binance API:', e);
    }

    return result;
  },


  isCryptoSymbol(ticker) {
    const clean = (ticker || '').toUpperCase().trim();
    // Parênteses obrigatórios: && tem precedência maior que ||
    return KNOWN_CRYPTO_LIST.includes(clean) ||
           clean.endsWith('USDT') ||
           (clean.endsWith('BRL') && !clean.match(/^\w{4}\d{1,2}/));
  },

  async getQuotes(tickers) {
    const now = Date.now();
    const toFetch = tickers.filter(t => {
      const c = this.cache[t];
      return !c || (now - c.ts) > this.CACHE_TTL;
    });

    if (toFetch.length > 0) {
      const cryptoTickers = toFetch.filter(t => this.isCryptoSymbol(t));
      const b3Tickers     = toFetch.filter(t => !this.isCryptoSymbol(t));

      const [yahooData, binanceData] = await Promise.all([
        b3Tickers.length     ? this.fetchYahoo(b3Tickers)      : {},
        cryptoTickers.length ? this.fetchBinance(cryptoTickers) : {},
      ]);

      // Captura o timestamp APÓS o await para TTL preciso
      const fetchedAt = Date.now();
      const allData = { ...yahooData, ...binanceData };
      for (const [ticker, data] of Object.entries(allData)) {
        this.cache[ticker] = { ...data, ts: fetchedAt };
      }

      // Limpeza de entradas de cache mais antigas que 30 minutos (evita memory leak)
      const MAX_CACHE_AGE = 30 * 60 * 1000;
      for (const k of Object.keys(this.cache)) {
        if (fetchedAt - this.cache[k].ts > MAX_CACHE_AGE) delete this.cache[k];
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

  // Configurações, Explorer, Relatórios e Metas: esconder toolbar
  if (tab === 'config' || tab === 'explorer' || tab === 'reports' || tab === 'goals') {
    document.getElementById('toolbar-section').style.display = 'none';
  }
  if (tab === 'config' || tab === 'explorer' || tab === 'goals') {
    document.getElementById('summary-hero-card').style.display = 'none';
  }

  if (tab === 'explorer') renderExplorerTable();
  if (tab === 'reports')  { renderMiKpis(); switchMiTab(currentMiTab); }
  if (tab === 'goals')    renderGoalsView();
  if (tab === 'carteira') {
    renderFavoritosWidget();
    renderHeroGoalsBadge();
  }
}

// Delegação de cliques nos botões de nav
document.querySelectorAll('[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

/* ═══════════════════════════════════════════════════════════
   MEUS INVESTIMENTOS — Central de Controle Patrimonial
   ═══════════════════════════════════════════════════════════ */

let currentMiTab     = 'extrato';  // 'extrato' | 'posicoes' | 'historico' | 'desempenho'
let currentMiOpType  = 'ALL';      // 'ALL' | 'BUY' | 'SELL'
let currentReportMode = 'summary'; // backward compat

/* ── Navegação por sub-abas ── */
function switchMiTab(tab) {
  currentMiTab = tab;

  // Atualiza botões
  document.querySelectorAll('.mi-subnav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.miTab === tab);
  });

  // Oculta todos os painéis
  ['extrato','posicoes','historico','desempenho'].forEach(id => {
    const el = document.getElementById(`mi-pane-${id}`);
    if (el) el.style.display = 'none';
  });

  // Exibe o painel ativo
  const active = document.getElementById(`mi-pane-${tab}`);
  if (active) active.style.display = 'block';

  // Mostra/oculta filtros globais (ocultos no extrato que tem filtros próprios)
  const filtersEl = document.getElementById('mi-filters');
  if (filtersEl) filtersEl.style.display = tab === 'extrato' ? 'none' : 'flex';

  // Renderiza o conteúdo correto
  if (tab === 'extrato')     renderMiExtrato();
  else if (tab === 'posicoes')   renderReports();
  else if (tab === 'historico') {
    const assetFilter = document.getElementById('report-asset-select')?.value || 'ALL';
    const typeFilter  = document.getElementById('report-type-filter')?.value || 'ALL';
    renderReportsHistory(assetFilter, typeFilter);
  }
  else if (tab === 'desempenho') renderMiDesempenho();

  // Atualiza sempre os KPIs
  renderMiKpis();
}

/* ── KPIs do cabeçalho ── */
function renderMiKpis() {
  const assets = state.portfolio || [];
  let totalInv = 0, totalCur = 0, opsCount = 0;

  assets.forEach(a => {
    const quote = getStockQuoteData(a.ticker);
    const qty   = parseFloat(a.quantity) || 0;
    const avg   = parseFloat(a.avgPrice) || 0;
    const cur   = a.currentPrice != null && parseFloat(a.currentPrice) > 0
      ? parseFloat(a.currentPrice) : (quote?.price ?? avg);
    totalInv += qty * avg;
    totalCur += qty * cur;
    opsCount += Array.isArray(a.transactions) ? a.transactions.length : (qty > 0 ? 1 : 0);
  });

  const plVal = totalCur - totalInv;
  const plPct = totalInv > 0 ? (plVal / totalInv) * 100 : 0;
  const plClass = plVal >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const setStyle = (id, prop, val) => { const el = document.getElementById(id); if (el) el.style[prop] = val; };

  set('mi-kpi-invested', fmtCurrency(totalInv));
  set('mi-kpi-current',  fmtCurrency(totalCur));
  set('mi-kpi-pl',       (plVal >= 0 ? '+ ' : '− ') + fmtCurrency(Math.abs(plVal)));
  set('mi-kpi-pl-pct',   (plVal >= 0 ? '+' : '') + plPct.toFixed(2) + '%');
  setStyle('mi-kpi-pl',     'color', plClass);
  setStyle('mi-kpi-pl-pct', 'color', plClass);
  set('mi-kpi-count',    assets.length + (assets.length === 1 ? ' ativo' : ' ativos'));
  set('mi-kpi-ops-count', opsCount + (opsCount === 1 ? ' operação' : ' operações'));
}

/* ── Extrato cronológico de operações ── */
function renderMiExtrato() {
  const feed = document.getElementById('mi-extrato-feed');
  if (!feed) return;

  const dateFrom = document.getElementById('mi-filter-date-from')?.value || '';
  const dateTo   = document.getElementById('mi-filter-date-to')?.value   || '';

  // Coleta todas as operações de todos os ativos
  let allOps = [];
  (state.portfolio || []).forEach(a => {
    const transactions = Array.isArray(a.transactions) && a.transactions.length > 0
      ? a.transactions
      : [{ id: 'initial', date: a.date || '', type: 'BUY',
           quantity: parseFloat(a.quantity) || 0,
           price: parseFloat(a.avgPrice) || 0,
           total: (parseFloat(a.quantity) || 0) * (parseFloat(a.avgPrice) || 0),
           notes: 'Posição inicial' }];

    transactions.forEach(t => {
      allOps.push({
        ...t,
        ticker: a.ticker,
        assetName: a.name || a.ticker,
        assetType: a.type,
        assetId: a.id
      });
    });
  });

  // Filtros
  if (currentMiOpType !== 'ALL') {
    allOps = allOps.filter(op => (op.type || 'BUY') === currentMiOpType);
  }
  if (dateFrom) allOps = allOps.filter(op => op.date >= dateFrom);
  if (dateTo)   allOps = allOps.filter(op => op.date <= dateTo);

  // Ordena por data decrescente
  allOps.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  if (allOps.length === 0) {
    feed.innerHTML = `
      <div class="empty-state-box" style="padding:40px 20px;text-align:center;">
        <div style="font-size:2rem;margin-bottom:10px;">📋</div>
        <div style="font-weight:600;color:var(--text-primary);margin-bottom:6px;">Nenhuma operação encontrada</div>
        <div style="font-size:0.8rem;color:var(--text-muted);">Registre compras e vendas usando o botão "Nova Operação" acima.</div>
      </div>`;
    return;
  }

  // Agrupa por data
  const grouped = {};
  allOps.forEach(op => {
    const key = op.date || '0000-00-00';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(op);
  });

  let html = '';
  Object.keys(grouped).sort((a, b) => b.localeCompare(a)).forEach(dateKey => {
    const ops = grouped[dateKey];
    html += `<div class="mi-feed-date-group">
      <div class="mi-feed-date-label">${formatDatePtBr(dateKey) || 'Sem data'}</div>`;

    ops.forEach(op => {
      const isBuy  = (op.type || 'BUY') === 'BUY';
      const tQty   = parseFloat(op.quantity) || 0;
      const tPrice = parseFloat(op.price) || 0;
      const tTotal = op.total != null ? parseFloat(op.total) : tQty * tPrice;

      html += `
      <div class="mi-feed-item">
        <div class="mi-feed-item-left">
          <div class="mi-feed-op-badge ${isBuy ? 'buy' : 'sell'}">${isBuy ? '▲' : '▼'}</div>
          <div class="mi-feed-item-logo">${renderAssetLogoHtml(op.ticker, 'asset-logo-sm')}</div>
          <div class="mi-feed-item-info">
            <div class="mi-feed-item-ticker" onclick="openAssetDetail('${op.ticker}')">${escapeHtml(op.ticker)}</div>
            <div class="mi-feed-item-sub">${escapeHtml(op.assetName)} · <span class="${isBuy ? 'text-buy' : 'text-sell'}">${isBuy ? 'Compra' : 'Venda'}</span></div>
          </div>
        </div>
        <div class="mi-feed-item-right">
          <div class="mi-feed-item-qty">${tQty.toLocaleString('pt-BR')} ${tQty === 1 ? 'cota' : 'cotas'} × ${fmtCurrency(tPrice)}</div>
          <div class="mi-feed-item-total ${isBuy ? 'buy' : 'sell'}">${isBuy ? '−' : '+'} ${fmtCurrency(tTotal)}</div>
        </div>
      </div>`;
    });

    html += `</div>`;
  });

  feed.innerHTML = html;
}

/* ── Filtrar tipo de operação no extrato ── */
function filterMiOpType(type) {
  currentMiOpType = type;
  document.getElementById('mi-op-all')?.classList.toggle('active',  type === 'ALL');
  document.getElementById('mi-op-buy')?.classList.toggle('active',  type === 'BUY');
  document.getElementById('mi-op-sell')?.classList.toggle('active', type === 'SELL');
  renderMiExtrato();
}

/* ── Aba: Desempenho ── */
function renderMiDesempenho() {
  const assets = state.portfolio || [];

  // 1. Distribuição por categoria (donut simples por legendas)
  const catMap = {};
  assets.forEach(a => {
    const quote    = getStockQuoteData(a.ticker);
    const qty      = parseFloat(a.quantity) || 0;
    const avg      = parseFloat(a.avgPrice) || 0;
    const cur      = a.currentPrice != null && parseFloat(a.currentPrice) > 0
      ? parseFloat(a.currentPrice) : (quote?.price ?? avg);
    const val = qty * cur;
    if (!catMap[a.type]) catMap[a.type] = 0;
    catMap[a.type] += val;
  });

  const totalCur = Object.values(catMap).reduce((s, v) => s + v, 0);
  const catColors = { STOCK:'#3fb950', FII:'#58a6ff', ETF:'#e3b341', CRYPTO:'#a371f7', FIXED:'#f78166', '':'#8b949e' };
  const catLabels = { STOCK:'Ações', FII:'FIIs', ETF:'ETFs / BDRs', CRYPTO:'Criptomoedas', FIXED:'Renda Fixa' };

  const donutEl = document.getElementById('mi-perf-donut-legend');
  if (donutEl) {
    if (Object.keys(catMap).length === 0) {
      donutEl.innerHTML = `<div style="color:var(--text-muted);font-size:0.82rem;padding:16px;">Nenhum dado disponível.</div>`;
    } else {
      donutEl.innerHTML = Object.entries(catMap)
        .sort((a, b) => b[1] - a[1])
        .map(([cat, val]) => {
          const pct  = totalCur > 0 ? (val / totalCur) * 100 : 0;
          const color = catColors[cat] || '#8b949e';
          const label = catLabels[cat] || cat;
          return `
          <div class="mi-donut-row">
            <div class="mi-donut-color" style="background:${color};"></div>
            <div class="mi-donut-label">${label}</div>
            <div class="mi-donut-bar-wrap">
              <div class="mi-donut-bar" style="width:${pct.toFixed(1)}%;background:${color};"></div>
            </div>
            <div class="mi-donut-pct">${pct.toFixed(1)}%</div>
            <div class="mi-donut-val">${fmtCurrency(val)}</div>
          </div>`;
        }).join('');
    }
  }

  // 2. Melhores e piores ativos por P&L %
  const ranked = assets.map(a => {
    const quote = getStockQuoteData(a.ticker);
    const qty   = parseFloat(a.quantity) || 0;
    const avg   = parseFloat(a.avgPrice) || 0;
    const cur   = a.currentPrice != null && parseFloat(a.currentPrice) > 0
      ? parseFloat(a.currentPrice) : (quote?.price ?? avg);
    const inv   = qty * avg;
    const now   = qty * cur;
    const plVal = now - inv;
    const plPct = inv > 0 ? (plVal / inv) * 100 : 0;
    return { ticker: a.ticker, plVal, plPct, inv };
  }).filter(r => r.inv > 0);

  ranked.sort((a, b) => b.plPct - a.plPct);

  const winnersEl = document.getElementById('mi-perf-winners');
  if (winnersEl) {
    if (ranked.length === 0) {
      winnersEl.innerHTML = `<div style="color:var(--text-muted);font-size:0.82rem;padding:16px;">Nenhum dado disponível.</div>`;
    } else {
      const display = [
        ...ranked.slice(0, 3),
        ...ranked.slice(-3).reverse()
      ].filter((v, i, a) => a.findIndex(x => x.ticker === v.ticker) === i);

      const maxAbs = Math.max(...display.map(r => Math.abs(r.plPct)), 1);
      winnersEl.innerHTML = display.map((r, i) => {
        const isPos = r.plPct >= 0;
        const barW  = Math.abs(r.plPct) / maxAbs * 100;
        const color = isPos ? 'var(--accent-green)' : 'var(--accent-red)';
        return `
        <div class="mi-bar-row">
          <div class="mi-bar-ticker">${escapeHtml(r.ticker)}</div>
          <div class="mi-bar-track">
            <div class="mi-bar-fill" style="width:${barW}%;background:${color};"></div>
          </div>
          <div class="mi-bar-pct" style="color:${color};">${isPos ? '+' : ''}${r.plPct.toFixed(2)}%</div>
        </div>`;
      }).join('');
    }
  }

  // 3. Resumo Financeiro Detalhado
  let totalInv = 0;
  ranked.forEach(r => totalInv += r.inv);
  const totalCurAll = ranked.reduce((s, r) => {
    const a   = (state.portfolio || []).find(x => x.ticker === r.ticker);
    const q   = getStockQuoteData(r.ticker);
    const qty = parseFloat(a?.quantity) || 0;
    const avg = parseFloat(a?.avgPrice) || 0;
    const cur = a?.currentPrice != null && parseFloat(a.currentPrice) > 0
      ? parseFloat(a.currentPrice) : (q?.price ?? avg);
    return s + qty * cur;
  }, 0);
  const plTotalVal = totalCurAll - totalInv;
  const plTotalPct = totalInv > 0 ? (plTotalVal / totalInv) * 100 : 0;
  const positive = ranked.filter(r => r.plVal >= 0);
  const negative = ranked.filter(r => r.plVal < 0);

  const perfEl = document.getElementById('mi-perf-summary');
  if (perfEl) {
    perfEl.innerHTML = `
      <div class="mi-perf-stat"><span class="mi-perf-stat-label">Total Aportado</span><span class="mi-perf-stat-val">${fmtCurrency(totalInv)}</span></div>
      <div class="mi-perf-stat"><span class="mi-perf-stat-label">Patrimônio Atual</span><span class="mi-perf-stat-val">${fmtCurrency(totalCurAll)}</span></div>
      <div class="mi-perf-stat"><span class="mi-perf-stat-label">Resultado (P&L)</span><span class="mi-perf-stat-val ${plTotalVal >= 0 ? 'pos' : 'neg'}">${plTotalVal >= 0 ? '+' : ''}${fmtCurrency(plTotalVal)}</span></div>
      <div class="mi-perf-stat"><span class="mi-perf-stat-label">Rentabilidade Total</span><span class="mi-perf-stat-val ${plTotalVal >= 0 ? 'pos' : 'neg'}">${plTotalVal >= 0 ? '+' : ''}${plTotalPct.toFixed(2)}%</span></div>
      <div class="mi-perf-stat"><span class="mi-perf-stat-label">Ativos em Ganho</span><span class="mi-perf-stat-val pos">${positive.length} ativo${positive.length !== 1 ? 's' : ''}</span></div>
      <div class="mi-perf-stat"><span class="mi-perf-stat-label">Ativos em Perda</span><span class="mi-perf-stat-val neg">${negative.length} ativo${negative.length !== 1 ? 's' : ''}</span></div>
      <div class="mi-perf-stat"><span class="mi-perf-stat-label">Melhor Ativo</span><span class="mi-perf-stat-val pos">${ranked[0]?.ticker ?? '—'} ${ranked[0] ? '(+' + ranked[0].plPct.toFixed(2) + '%)' : ''}</span></div>
      <div class="mi-perf-stat"><span class="mi-perf-stat-label">Pior Ativo</span><span class="mi-perf-stat-val neg">${ranked[ranked.length-1]?.ticker ?? '—'} ${ranked[ranked.length-1]?.plPct < 0 ? '(' + ranked[ranked.length-1].plPct.toFixed(2) + '%)' : ''}</span></div>
    `;
  }
}

/* ── backward compat: setReportMode para a aba Posições ── */
function setReportMode(mode) {
  currentReportMode = mode;
  renderReports();
}



function formatDatePtBr(dateStr) {
  if (!dateStr) return '—';
  if (dateStr.includes('-')) {
    const [y, m, d] = dateStr.split('-');
    if (y && m && d) return `${d}/${m}/${y}`;
  }
  return dateStr;
}

function updateReportAssetSelect() {
  const select = document.getElementById('report-asset-select');
  if (!select) return;
  const currentVal = select.value || 'ALL';

  const tickers = (state.portfolio || []).map(p => p.ticker);
  let html = `<option value="ALL">Todas as Ações / Papéis</option>`;
  tickers.forEach(t => {
    const item = state.portfolio.find(p => p.ticker === t);
    const label = `${t}${item?.name ? ' — ' + item.name : ''}`;
    html += `<option value="${t}" ${t === currentVal ? 'selected' : ''}>${escapeHtml(label)}</option>`;
  });
  select.innerHTML = html;
}

function renderReports() {
  updateReportAssetSelect();

  const source      = document.getElementById('report-source')?.value || 'all';
  const typeFilter  = document.getElementById('report-type-filter')?.value || 'ALL';
  const sortBy      = document.getElementById('report-sort')?.value || 'ticker';
  const assetFilter = document.getElementById('report-asset-select')?.value || 'ALL';

  // Se o modo for Histórico / Extrato por Ação:
  if (currentReportMode === 'history') {
    renderReportsHistory(assetFilter, typeFilter);
    return;
  }

  // ── Modo 1: Visão Geral / Consolidado ──
  let rows = [];

  if (source !== 'watchlist') {
    state.portfolio.forEach(a => {
      if (assetFilter !== 'ALL' && a.ticker !== assetFilter) return;
      const quote   = getStockQuoteData(a.ticker);
      const qty     = parseFloat(a.quantity) || 0;
      const avg     = parseFloat(a.avgPrice) || 0;
      const cur     = a.currentPrice != null && parseFloat(a.currentPrice) > 0
        ? parseFloat(a.currentPrice)
        : (quote?.price ?? avg);
      const totalInv = qty * avg;
      const totalCur = qty * cur;
      const plVal   = totalCur - totalInv;
      const plPct   = totalInv > 0 ? (plVal / totalInv) * 100 : 0;
      rows.push({
        id: a.id,
        ticker: a.ticker, name: a.name || '', type: a.type,
        qty, avg, cur, totalInv, totalCur, plVal, plPct,
        targetPrice: null, rank: null, notes: a.notes || '',
        source: 'Carteira',
        date: a.date || null
      });
    });
  }

  if (source !== 'portfolio') {
    state.watchlist.forEach(a => {
      if (assetFilter !== 'ALL' && a.ticker !== assetFilter) return;
      const quote = getStockQuoteData(a.ticker);
      const cur   = a.currentPrice != null && parseFloat(a.currentPrice) > 0
        ? parseFloat(a.currentPrice)
        : (quote?.price ?? null);
      rows.push({
        id: a.id,
        ticker: a.ticker, name: a.name || '', type: a.type,
        qty: null, avg: null, cur, totalInv: null, totalCur: null, plVal: null, plPct: null,
        targetPrice: parseFloat(a.targetPrice) || null,
        rank: a.rank || null, notes: a.notes || '',
        source: 'Favoritos',
        date: a.date || null
      });
    });
  }

  // Filtro de tipo
  if (typeFilter !== 'ALL') rows = rows.filter(r => r.type === typeFilter);

  // Ordenação
  rows.sort((a, b) => {
    if (sortBy === 'pl_pct') return (b.plPct ?? -9999) - (a.plPct ?? -9999);
    if (sortBy === 'pl_val') return (b.plVal ?? -9999) - (a.plVal ?? -9999);
    if (sortBy === 'total')  return (b.totalInv ?? 0) - (a.totalInv ?? 0);
    if (sortBy === 'rank') {
      const ra = parseInt(a.rank) || 9999;
      const rb = parseInt(b.rank) || 9999;
      return ra - rb;
    }
    return a.ticker.localeCompare(b.ticker);
  });

  // ── Cards de Resumo ──
  const portRows = rows.filter(r => r.source === 'Carteira');
  const totalInv = portRows.reduce((s, r) => s + (r.totalInv || 0), 0);
  const totalCur = portRows.reduce((s, r) => s + (r.totalCur || 0), 0);
  const plTotal  = totalCur - totalInv;
  const plPct    = totalInv > 0 ? (plTotal / totalInv) * 100 : 0;
  const plClass  = plTotal >= 0 ? 'pos' : 'neg';

  const summaryEl = document.getElementById('reports-summary-row');
  if (summaryEl) {
    summaryEl.innerHTML = `
      <div class="report-summary-card">
        <div class="rsc-label">Total Investido</div>
        <div class="rsc-value">${fmtCurrency(totalInv)}</div>
      </div>
      <div class="report-summary-card">
        <div class="rsc-label">Valor Atual</div>
        <div class="rsc-value">${fmtCurrency(totalCur)}</div>
      </div>
      <div class="report-summary-card">
        <div class="rsc-label">P&amp;L Total</div>
        <div class="rsc-value ${plClass}">${plTotal >= 0 ? '+' : ''}${fmtCurrency(plTotal)}</div>
        <div class="rsc-sub ${plClass}">${plTotal >= 0 ? '+' : ''}${plPct.toFixed(2)}%</div>
      </div>
      <div class="report-summary-card">
        <div class="rsc-label">Ativos</div>
        <div class="rsc-value">${rows.length}</div>
        <div class="rsc-sub">${portRows.length} carteira · ${rows.length - portRows.length} favoritos</div>
      </div>`;
  }

  // ── Tabela ──
  const tbody = document.getElementById('reports-tbody');
  if (!tbody) return;

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="12" style="text-align:center;color:var(--text-muted);padding:24px;">Nenhum ativo encontrado com os filtros selecionados.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const plClass = r.plVal == null ? '' : r.plVal >= 0 ? 'pos' : 'neg';
    const rankHtml = r.rank
      ? `<span class="rank-badge rank-${r.rank <= 3 ? r.rank : 'n'}">#${r.rank}</span>`
      : '<span style="color:var(--text-muted)">—</span>';
    const srcBadge = `<span class="report-src-badge ${r.source === 'Carteira' ? 'carteira' : 'radar'}">${r.source}</span>`;
    return `<tr>
      <td><div style="display:flex;align-items:center;gap:8px;">${renderAssetLogoHtml(r.ticker,'explorer-logo')}<div><strong style="cursor:pointer;" onclick="openAssetDetail('${r.ticker}')">${escapeHtml(r.ticker)}</strong><div style="font-size:0.7rem;color:var(--text-muted);">${escapeHtml(r.name)}</div></div>${srcBadge}</div></td>
      <td><span class="asset-category-badge cat-${(r.type||'').toLowerCase()}">${r.type}</span></td>
      <td class="num">${r.qty != null ? r.qty : '—'}</td>
      <td class="num">${r.avg != null ? fmtN(r.avg) : '—'}</td>
      <td class="num">${r.cur != null ? fmtN(r.cur) : '—'}</td>
      <td class="num">${r.totalInv != null ? fmtCurrency(r.totalInv) : '—'}</td>
      <td class="num">${r.totalCur != null ? fmtCurrency(r.totalCur) : '—'}</td>
      <td class="num ${plClass}">${r.plVal != null ? (r.plVal >= 0 ? '+' : '') + fmtCurrency(r.plVal) : '—'}</td>
      <td class="num ${plClass}">${r.plPct != null ? (r.plPct >= 0 ? '+' : '') + r.plPct.toFixed(2) + '%' : '—'}</td>
      <td class="num">${r.targetPrice != null ? fmtN(r.targetPrice) : '—'}</td>
      <td style="text-align:center;">${rankHtml}</td>
      <td class="report-notes-cell" title="${escapeHtml(r.notes)}">${r.notes ? escapeHtml(r.notes.slice(0, 40)) + (r.notes.length > 40 ? '…' : '') : '<span style="color:var(--text-muted)">—</span>'}</td>
    </tr>`;
  }).join('');
}

// ── Modo 2: Extrato Detalhado com Datas de Aquisição por Ação ──
function renderReportsHistory(assetFilter = 'ALL', typeFilter = 'ALL') {
  const container = document.getElementById('reports-history-wrapper');
  if (!container) return;

  let assets = [...(state.portfolio || [])];
  if (assetFilter !== 'ALL') assets = assets.filter(a => a.ticker === assetFilter);
  if (typeFilter !== 'ALL')  assets = assets.filter(a => a.type === typeFilter);

  if (assets.length === 0) {
    container.innerHTML = `
      <div class="empty-state-box" style="padding:32px;">
        <div class="empty-icon">📜</div>
        <div class="empty-title">Nenhum papel encontrado</div>
        <div class="empty-desc">Cadastre ativos na carteira ou lance novas operações com data para visualizar o extrato detalhado.</div>
      </div>`;
    return;
  }

  container.innerHTML = assets.map(a => {
    const quote = getStockQuoteData(a.ticker);
    const qty   = parseFloat(a.quantity) || 0;
    const avg   = parseFloat(a.avgPrice) || 0;
    const cur   = a.currentPrice != null && parseFloat(a.currentPrice) > 0 ? parseFloat(a.currentPrice) : (quote?.price ?? avg);
    const totalInv = qty * avg;
    const totalCur = qty * cur;
    const plVal = totalCur - totalInv;
    const plPct = totalInv > 0 ? (plVal / totalInv) * 100 : 0;
    const plClass = plVal >= 0 ? 'pos' : 'neg';

    // Lista de transações históricas do papel
    let transactions = Array.isArray(a.transactions) && a.transactions.length > 0
      ? [...a.transactions]
      : [{
          id: 'initial',
          date: a.date || '',
          type: 'BUY',
          quantity: qty,
          price: avg,
          total: totalInv,
          notes: a.notes || 'Posição Inicial'
        }];

    // Ordenar transações por data decrescente (mais recentes primeiro)
    transactions.sort((x, y) => (y.date || '').localeCompare(x.date || ''));

    const rowsHtml = transactions.map((t, idx) => {
      const isBuy = (t.type || 'BUY') === 'BUY';
      const tQty = parseFloat(t.quantity) || 0;
      const tPrice = parseFloat(t.price) || 0;
      const tTotal = t.total != null ? parseFloat(t.total) : tQty * tPrice;
      const dateFormatted = formatDatePtBr(t.date);

      return `
        <tr>
          <td><strong style="color:var(--text-primary);">${dateFormatted}</strong></td>
          <td>
            <span class="history-badge ${isBuy ? 'buy' : 'sell'}">
              ${isBuy ? '▲ Compra' : '▼ Venda'}
            </span>
          </td>
          <td class="num"><strong>${tQty.toLocaleString('pt-BR')}</strong></td>
          <td class="num">${fmtCurrency(tPrice)}</td>
          <td class="num" style="font-weight:700;">${fmtCurrency(tTotal)}</td>
          <td style="color:var(--text-muted);font-size:0.75rem;">${escapeHtml(t.notes || '—')}</td>
          <td style="text-align:center;">
            ${t.id !== 'initial' ? `
              <button class="action-btn-sm delete" onclick="deleteAssetTransaction('${a.id}','${t.id}')" title="Excluir este aporte/operação">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            ` : '<span style="color:var(--text-muted);font-size:0.68rem;">Base</span>'}
          </td>
        </tr>
      `;
    }).join('');

    return `
      <div class="history-asset-card">
        <div class="history-asset-header">
          <div class="history-asset-identity">
            ${renderAssetLogoHtml(a.ticker, 'asset-logo')}
            <div>
              <div style="display:flex;align-items:center;gap:8px;">
                <strong style="font-size:1.05rem;cursor:pointer;" onclick="openAssetDetail('${a.ticker}')">${escapeHtml(a.ticker)}</strong>
                <span class="asset-category-badge cat-${(a.type||'').toLowerCase()}">${a.type}</span>
              </div>
              <div style="font-size:0.72rem;color:var(--text-muted);">${escapeHtml(a.name || a.ticker)}</div>
            </div>
          </div>

          <div class="history-asset-metrics">
            <div class="ham-item">
              <span class="ham-label">Total em Carteira</span>
              <span class="ham-val">${qty.toLocaleString('pt-BR')} cotas</span>
            </div>
            <div class="ham-item">
              <span class="ham-label">Preço Médio</span>
              <span class="ham-val">${fmtCurrency(avg)}</span>
            </div>
            <div class="ham-item">
              <span class="ham-label">Total Investido</span>
              <span class="ham-val">${fmtCurrency(totalInv)}</span>
            </div>
            <div class="ham-item">
              <span class="ham-label">Cotação Atual</span>
              <span class="ham-val">${fmtCurrency(cur)}</span>
            </div>
            <div class="ham-item">
              <span class="ham-label">Resultado Total</span>
              <span class="ham-val ${plClass}">${plVal >= 0 ? '+' : ''}${fmtCurrency(plVal)} (${plVal >= 0 ? '+' : ''}${plPct.toFixed(2)}%)</span>
            </div>
            <button class="btn-secondary" onclick="openAddOperationModal('${a.ticker}')" style="font-size:0.72rem;padding:4px 10px;margin-left:6px;">
              + Aporte
            </button>
          </div>
        </div>

        <div class="history-table-container">
          <table class="history-table">
            <thead>
              <tr>
                <th>Data da Operação</th>
                <th>Tipo</th>
                <th class="num">Quantidade Adquirida</th>
                <th class="num">Preço Unitário Pago</th>
                <th class="num">Total da Operação</th>
                <th>Notas / Motivo</th>
                <th style="text-align:center;">Ação</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }).join('');
}

// ── Modal de Nova Operação / Aporte com Data ──
function openAddOperationModal(prefillTicker = null) {
  const select = document.getElementById('operation-asset-select');
  if (!select) return;

  const assets = state.portfolio || [];
  if (assets.length === 0) {
    showToast('Adicione ativos à carteira primeiro antes de registrar operações.', 'info');
    openAddAssetModal();
    return;
  }

  let html = '';
  assets.forEach(a => {
    const isSelected = prefillTicker && a.ticker === prefillTicker;
    html += `<option value="${a.ticker}" ${isSelected ? 'selected' : ''}>${a.ticker} — ${escapeHtml(a.name || a.ticker)}</option>`;
  });
  select.innerHTML = html;

  document.getElementById('operation-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('operation-type').value = 'BUY';
  document.getElementById('operation-qty').value = '';
  document.getElementById('operation-price').value = '';
  document.getElementById('operation-notes').value = '';
  document.getElementById('operation-total-val').textContent = 'R$ 0,00';

  // Pré-carregar cotação atual se disponível
  const selectedTicker = prefillTicker || assets[0]?.ticker;
  if (selectedTicker) {
    const q = getStockQuoteData(selectedTicker);
    if (q?.price) document.getElementById('operation-price').value = q.price.toFixed(2);
  }

  calcOperationTotal();
  openModal('modal-operation');
}

function onOperationAssetSelectChange() {
  const ticker = document.getElementById('operation-asset-select').value;
  if (!ticker) return;
  const q = getStockQuoteData(ticker);
  if (q?.price) {
    document.getElementById('operation-price').value = q.price.toFixed(2);
    calcOperationTotal();
  }
}

function calcOperationTotal() {
  const qty = parseFloat(document.getElementById('operation-qty')?.value) || 0;
  const price = parseFloat(document.getElementById('operation-price')?.value) || 0;
  const total = qty * price;
  const el = document.getElementById('operation-total-val');
  if (el) el.textContent = fmtCurrency(total);
}

document.getElementById('operation-form')?.addEventListener('submit', function(e) {
  e.preventDefault();
  const ticker = document.getElementById('operation-asset-select').value;
  const date   = document.getElementById('operation-date').value;
  const opType = document.getElementById('operation-type').value;
  const qty    = parseFloat(document.getElementById('operation-qty').value);
  const price  = parseFloat(document.getElementById('operation-price').value);
  const notes  = document.getElementById('operation-notes').value.trim();

  if (!ticker || !date || isNaN(qty) || qty <= 0 || isNaN(price) || price <= 0) {
    showToast('Preencha os campos obrigatórios corretamente.', 'error');
    return;
  }

  const asset = state.portfolio.find(p => p.ticker === ticker);
  if (!asset) {
    showToast('Ativo não encontrado na carteira.', 'error');
    return;
  }

  if (!Array.isArray(asset.transactions)) {
    asset.transactions = [];
    if (parseFloat(asset.quantity) > 0) {
      asset.transactions.push({
        id: genId(),
        date: asset.date || date,
        type: 'BUY',
        quantity: parseFloat(asset.quantity),
        price: parseFloat(asset.avgPrice) || price,
        total: (parseFloat(asset.quantity) * (parseFloat(asset.avgPrice) || price)),
        notes: asset.notes || 'Posição Inicial'
      });
    }
  }

  const transId = genId();
  asset.transactions.push({
    id: transId,
    date,
    type: opType,
    quantity: qty,
    price,
    total: qty * price,
    notes
  });

  // Recalcular saldo total e preço médio ponderado a partir de todas as transações
  let totalQty = 0;
  let totalInvested = 0;

  asset.transactions.forEach(t => {
    const tQty = parseFloat(t.quantity) || 0;
    const tPrice = parseFloat(t.price) || 0;
    if ((t.type || 'BUY') === 'BUY') {
      totalInvested += (tQty * tPrice);
      totalQty += tQty;
    } else if (t.type === 'SELL') {
      totalQty = Math.max(0, totalQty - tQty);
    }
  });

  asset.quantity = totalQty;
  asset.avgPrice = totalQty > 0 ? (totalInvested / totalQty) : price;
  asset.date = date;

  saveEncryptedState();
  closeModal('modal-operation');
  renderAll();
  showToast(`Operação de ${ticker} registrada com sucesso!`, 'success');
});

function deleteAssetTransaction(assetId, transId) {
  const asset = state.portfolio.find(p => p.id === assetId);
  if (!asset || !Array.isArray(asset.transactions)) return;

  asset.transactions = asset.transactions.filter(t => t.id !== transId);

  // Recalcular
  let totalQty = 0;
  let totalInvested = 0;
  asset.transactions.forEach(t => {
    const tQty = parseFloat(t.quantity) || 0;
    const tPrice = parseFloat(t.price) || 0;
    if ((t.type || 'BUY') === 'BUY') {
      totalInvested += (tQty * tPrice);
      totalQty += tQty;
    } else if (t.type === 'SELL') {
      totalQty = Math.max(0, totalQty - tQty);
    }
  });

  if (asset.transactions.length === 0) {
    // Se não restou nenhuma transação, mantém a quantidade atual ou base
  } else {
    asset.quantity = totalQty;
    asset.avgPrice = totalQty > 0 ? (totalInvested / totalQty) : asset.avgPrice;
  }

  saveEncryptedState();
  renderAll();
  showToast('Operação removida do extrato.', 'info');
}

// Auxiliar de formatação monetária
function fmtCurrency(v) {
  if (v == null || isNaN(v)) return '—';
  const abs = Math.abs(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (v < 0 ? '−' : '') + 'R$ ' + abs;
}

/* ═══════════════════════════════════════════════════════════
   RENDER — SUMMARY HERO
   ═══════════════════════════════════════════════════════════ */

function renderSummary() {
  let totalInvestido = 0, totalAtual = 0;

  for (const a of state.portfolio) {
    const qty = parseFloat(a.quantity) || 0;
    const avg = parseFloat(a.avgPrice) || 0;
    const quote = getStockQuoteData(a.ticker);
    const cur = (a.currentPrice != null && parseFloat(a.currentPrice) > 0)
      ? parseFloat(a.currentPrice)
      : (quote?.price != null ? quote.price : avg);
    totalInvestido += qty * avg;
    totalAtual     += qty * cur;
  }

  const lucro = totalAtual - totalInvestido;
  const pct   = totalInvestido > 0 ? (lucro / totalInvestido) * 100 : 0;

  document.getElementById('total-patrimonio').textContent  = fmtPrivate(totalAtual);
  document.getElementById('total-investido').textContent   = fmtPrivate(totalInvestido);
  document.getElementById('total-lucro-nominal').textContent = privacyMode ? 'R$ ••••••' : (lucro >= 0 ? '+' : '') + fmt(lucro);

  const badge = document.getElementById('badge-rentabilidade-total');
  if (badge) {
    badge.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
    badge.className   = `badge-profit ${pct >= 0 ? 'positive' : 'negative'}`;
  }

  const now = new Date();
  const syncTimeEl = document.getElementById('last-sync-time');
  if (syncTimeEl) {
    syncTimeEl.textContent = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  const goals = getGoalsState();
  const metaTarget = parseFloat(goals.retirementTarget) || 1000000;
  const metaTargetEl = document.getElementById('summary-meta-target');
  if (metaTargetEl) {
    metaTargetEl.textContent = fmtPrivate(metaTarget);
  }

  renderAllocation();
  renderHeroGoalsBadge(totalAtual);
}

function renderAllocation() {
  const sectors = {};
  let total = 0;

  for (const a of state.portfolio) {
    const qty = parseFloat(a.quantity) || 0;
    const quote = getStockQuoteData(a.ticker);
    const cur = (a.currentPrice != null && parseFloat(a.currentPrice) > 0)
      ? parseFloat(a.currentPrice)
      : (quote?.price != null ? quote.price : (parseFloat(a.avgPrice) || 0));
    const val = qty * cur;
    if (val <= 0) continue;

    // Determinar o Setor do Investimento
    let sectorName = '';
    const info = getStockInfo(a.ticker);

    if (a.type === 'CRYPTO') {
      sectorName = 'Criptoativos';
    } else if (a.type === 'FIXED') {
      sectorName = 'Renda Fixa';
    } else if (a.type === 'ETF') {
      sectorName = (info.sector && info.sector !== 'Carteira Pessoal' && info.sector !== 'Mercado B3') ? info.sector : 'ETFs & Índices';
    } else if (a.type === 'FII') {
      sectorName = (info.sector && info.sector !== 'Carteira Pessoal' && info.sector !== 'Mercado B3') ? info.sector : 'FIIs Imobiliários';
    } else {
      sectorName = (info.sector && info.sector !== 'Carteira Pessoal' && info.sector !== 'Mercado B3') ? info.sector : 'Ações B3';
    }

    sectors[sectorName] = (sectors[sectorName] || 0) + val;
    total += val;
  }

  const bar = document.getElementById('allocation-bar');
  const legend = document.getElementById('allocation-legend');
  if (!bar || !legend) return;
  bar.innerHTML = ''; legend.innerHTML = '';

  if (total <= 0) {
    bar.innerHTML = `<div class="alloc-segment" style="width:100%;background:var(--border-card);"></div>`;
    legend.innerHTML = `<div class="legend-item" style="color:var(--text-muted);">Nenhum ativo alocado</div>`;
    return;
  }

  const SECTOR_PALETTE = [
    '#388bfd', '#3fb950', '#d29922', '#bc8cff', '#f85149',
    '#58a6ff', '#56d364', '#e3b341', '#db61a2', '#f0883e',
    '#79c0ff', '#7ee787', '#d89c36', '#a371f7', '#8b949e'
  ];

  // Ordenar setores do maior para o menor valor
  const sorted = Object.entries(sectors).sort((a, b) => b[1] - a[1]);

  sorted.forEach(([sector, val], idx) => {
    const pct = (val / total) * 100;
    const color = SECTOR_PALETTE[idx % SECTOR_PALETTE.length];

    const seg = document.createElement('div');
    seg.className = 'alloc-segment';
    seg.style.width = pct + '%';
    seg.style.backgroundColor = color;
    seg.title = `${sector}: ${fmtPrivate(val)} (${pct.toFixed(1)}%)`;
    bar.appendChild(seg);

    const li = document.createElement('div');
    li.className = 'legend-item';
    li.innerHTML = `<span class="legend-dot" style="background-color:${color};"></span>${escapeHtml(sector)} <strong>${pct.toFixed(1)}%</strong>`;
    legend.appendChild(li);
  });
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
  if (count) {
    count.textContent = currentFilter === 'ALL' ? state.portfolio.length : `${items.length} de ${state.portfolio.length}`;
  }

  if (items.length === 0) {
    const catLabels = { STOCK:'Ações', FII:'FIIs', ETF:'ETFs / BDRs', CRYPTO:'Cripto', FIXED:'Renda Fixa', OTHER:'Outros' };
    const currentCatLabel = catLabels[currentFilter] || '';
    list.innerHTML = `
      <div class="empty-state-box">
        <div class="empty-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
        </div>
        <div class="empty-title">${currentFilter !== 'ALL' ? 'Nenhum ativo de ' + currentCatLabel : 'Carteira vazia'}</div>
        <div class="empty-desc">${currentFilter !== 'ALL' ? 'Você ainda não possui ' + currentCatLabel + ' na carteira. Clique em "Novo Ativo" para adicionar.' : 'Adicione seu primeiro ativo clicando em "Novo Ativo".'}</div>
      </div>`;
    return;
  }

  const catBadges = {
    STOCK: ['cat-stock', 'AÇÃO'], FII: ['cat-fii', 'FII'], ETF: ['cat-etf', 'ETF'],
    CRYPTO: ['cat-crypto', 'CRIPTO'], FIXED: ['cat-fixed', 'R.FIXA'], OTHER: ['cat-other', 'OUTRO'],
  };

  const marketOpen = isB3MarketOpen();

  list.innerHTML = items.map(a => {
    const qty = parseFloat(a.quantity) || 0;
    const avg = parseFloat(a.avgPrice) || 0;
    const quote = getStockQuoteData(a.ticker);
    const cur = (a.currentPrice != null && parseFloat(a.currentPrice) > 0)
      ? parseFloat(a.currentPrice)
      : (quote?.price != null ? quote.price : avg);
    const invested = qty * avg;
    const atualVal = qty * cur;
    const pnl = atualVal - invested;
    const pnlPct = invested > 0 ? (pnl / invested) * 100 : 0;
    const [catClass, catLabel] = catBadges[a.type] || ['cat-other', 'OUTRO'];
    const pnlClass = pnl >= 0 ? 'positive' : 'negative';
    const isClosedVal = !marketOpen || quote?.isClosed;

    return `
    <div class="asset-card" id="card-${a.id}">
      <div class="asset-card-header">
        <div class="asset-identity" style="display:flex;align-items:center;gap:10px;cursor:pointer;" onclick="openAssetDetail('${a.ticker}')" title="Clique para ver gráfico TradingView e Preço Justo">
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
          <span class="asset-col-label">${isClosedVal ? 'Últ. Fechamento' : 'Preço Atual'}</span>
          <span class="asset-col-val price-editable" onclick="openEditAssetModal('${a.id}')" title="${isClosedVal ? 'Mercado Fechado: último valor de fechamento registrado' : 'Preço em negociação'}">
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
        <div style="display:flex;align-items:center;gap:6px;">
          <span class="asset-notes">${escapeHtml(a.notes || '—')}</span>
          <span class="best-badge-status ${isClosedVal ? 'closed' : 'open'}" style="font-size:0.6rem;">
            ${isClosedVal ? 'Fechamento' : 'Ao vivo'}
          </span>
        </div>
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

  // Ordenar por prioridade: com rank primeiro (crescente), sem rank depois
  items.sort((a, b) => {
    const ra = parseInt(a.rank) || 9999;
    const rb = parseInt(b.rank) || 9999;
    return ra - rb;
  });

  const list = document.getElementById('watchlist-items-list');
  const count = document.getElementById('watchlist-count-badge');
  if (count) {
    count.textContent = currentFilter === 'ALL' ? state.watchlist.length : `${items.length} de ${state.watchlist.length}`;
  }

  if (items.length === 0) {
    const catLabels = { STOCK:'Ações', FII:'FIIs', ETF:'ETFs / BDRs', CRYPTO:'Cripto', FIXED:'Renda Fixa', OTHER:'Outros' };
    const currentCatLabel = catLabels[currentFilter] || '';
    list.innerHTML = `
      <div class="empty-state-box">
        <div class="empty-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
        </div>
        <div class="empty-title">${currentFilter !== 'ALL' ? 'Nenhum ativo de ' + currentCatLabel + ' nos Favoritos' : 'Favoritos vazio'}</div>
        <div class="empty-desc">${currentFilter !== 'ALL' ? 'Adicione ativos de ' + currentCatLabel + ' clicando em "Novo Favorito".' : 'Adicione ativos favoritos para monitorar clicando em "Novo Favorito".'}</div>
      </div>`;
    return;
  }

  const marketOpen = isB3MarketOpen();

  list.innerHTML = items.map(a => {
    const quote  = getStockQuoteData(a.ticker);
    const cur    = (a.currentPrice != null && parseFloat(a.currentPrice) > 0)
      ? parseFloat(a.currentPrice)
      : (quote?.price != null ? quote.price : null);
    const target = parseFloat(a.targetPrice) || null;
    const isClosedVal = !marketOpen || quote?.isClosed;

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
        <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;">
          ${a.rank ? `<span class="rank-badge rank-${a.rank <= 3 ? a.rank : 'n'}" title="Prioridade de investimento #${a.rank}">#${a.rank}</span>` : ''}
          <div class="asset-identity" style="display:flex;align-items:center;gap:10px;cursor:pointer;flex:1;" onclick="openAssetDetail('${a.ticker}')" title="Clique para ver gráfico TradingView e Preço Justo">
            ${renderAssetLogoHtml(a.ticker, 'asset-logo')}
            <div>
              <div class="asset-tag">${escapeHtml(a.ticker)}</div>
              ${a.name ? `<div class="asset-name">${escapeHtml(a.name)}</div>` : ''}
            </div>
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
          <span class="asset-col-label">${isClosedVal ? 'Últ. Fechamento' : 'Preço Atual'}</span>
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
        <div style="display:flex;align-items:center;gap:6px;">
          <span class="asset-notes">${escapeHtml(a.notes || '—')}</span>
          <span class="best-badge-status ${isClosedVal ? 'closed' : 'open'}" style="font-size:0.6rem;">
            ${isClosedVal ? 'Fechamento' : 'Ao vivo'}
          </span>
        </div>
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
   FAVORITAS (Lista Clean com Logos & Cotações em Tempo Real)
   ═══════════════════════════════════════════════════════════ */

function renderFavoritosWidget() {
  const container = document.getElementById('favoritos-scroll');
  if (!container) return;

  if (!state.best || !Array.isArray(state.best) || state.best.length === 0) {
    state.best = JSON.parse(JSON.stringify(DEFAULT_BEST));
  }

  let items = [...state.best];

  // Filtragem por categoria se houver filtro ativo
  if (currentFilter !== 'ALL') {
    const filtered = items.filter(b => {
      const info = getStockInfo(b.ticker);
      return info.type === currentFilter;
    });

    if (filtered.length > 0) {
      items = filtered;
    } else {
      // Se não tiver no Best, tenta buscar da watchlist ou primeiros da categoria
      const watchCat = (state.watchlist || []).filter(w => w.type === currentFilter);
      if (watchCat.length > 0) {
        items = watchCat.slice(0, 8).map(w => ({ ticker: w.ticker, name: w.name || w.ticker }));
      } else if (typeof B3_STOCKS !== 'undefined' && Array.isArray(B3_STOCKS)) {
        const b3Cat = B3_STOCKS.filter(s => s.type === currentFilter).slice(0, 8);
        items = b3Cat.map(s => ({ ticker: s.ticker, name: s.name || s.ticker }));
      }
    }
  }

  const marketOpen = isB3MarketOpen();

  // Atualizar indicador de status do mercado no cabeçalho de Favoritas
  const statusBadge = document.getElementById('market-status-badge');
  const statusText  = document.getElementById('market-status-text');
  if (statusBadge && statusText) {
    statusBadge.className = `market-status-badge ${marketOpen ? 'open' : 'closed'}`;
    statusText.textContent = marketOpen ? 'Aberto' : 'Fechado';
    statusBadge.title = marketOpen
      ? 'Mercado em negociação ao vivo'
      : 'Mercado fechado. Exibindo último fechamento registrado.';
  }

  if (!items || items.length === 0) {
    container.innerHTML = `
      <div class="fav-empty">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
        </svg>
        Nenhum ativo favorito nesta categoria. Clique em "Editar Favoritas" para adicionar.
      </div>`;
    return;
  }

  container.innerHTML = items.map(item => {
    const info  = getStockInfo(item.ticker);
    const q     = getStockQuoteData(item.ticker);
    const price = q?.price != null ? fmtN(q.price) : '—';
    const chg   = q?.changePercent ?? q?.change ?? null;
    const chgClass = chg == null ? 'neutral' : chg >= 0 ? 'ok' : 'over';
    const chgText  = chg != null ? `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%` : '—';
    const nameStr  = item.name || info.name || item.ticker;

    return `
      <div class="fav-list-card" onclick="openAssetDetail('${escapeAttr(item.ticker)}')" title="Clique para ver gráfico TradingView e Detalhes de ${escapeAttr(item.ticker)}">
        <div class="fav-list-left">
          ${renderAssetLogoHtml(item.ticker, 'fav-logo')}
          <div class="fav-list-info">
            <div class="fav-ticker">${escapeHtml(item.ticker)}</div>
            <div class="fav-name" title="${escapeHtml(nameStr)}">${escapeHtml(nameStr)}</div>
          </div>
        </div>
        <div class="fav-list-right">
          <div class="fav-price">${price}</div>
          <div class="fav-margin ${chgClass}">${chgText}</div>
        </div>
      </div>
    `;
  }).join('');

  // Atualização em background das cotações da lista
  const tickers = items.map(it => it.ticker);
  QuoteService.getQuotes(tickers).then(quotes => {
    tickers.forEach(t => {
      const quote = quotes[t];
      if (!quote?.price) return;
      bestPrices[t] = quote;

      const card = container.querySelector(`.fav-list-card[onclick*="'${t}'"]`);
      if (!card) return;
      const priceEl = card.querySelector('.fav-price');
      if (priceEl) priceEl.textContent = fmtN(quote.price);

      const chgVal = quote.changePercent ?? quote.change ?? null;
      const chgEl = card.querySelector('.fav-margin');
      if (chgEl && chgVal != null) {
        chgEl.className = `fav-margin ${chgVal >= 0 ? 'ok' : 'over'}`;
        chgEl.textContent = `${chgVal >= 0 ? '+' : ''}${chgVal.toFixed(2)}%`;
      }
    });
  });

  enableScrollDrag('favoritos-scroll');
}

function scrollFavoritos(offset) {
  const el = document.getElementById('favoritos-scroll');
  if (el) el.scrollBy({ left: offset, behavior: 'smooth' });
}

function enableScrollDrag(containerId) {
  const container = document.getElementById(containerId);
  if (!container || container._hasDragListener) return;
  container._hasDragListener = true;

  container.addEventListener('wheel', (e) => {
    if (e.deltaY !== 0) {
      e.preventDefault();
      container.scrollBy({ left: e.deltaY * 2, behavior: 'smooth' });
    }
  }, { passive: false });

  let isDown = false;
  let startX;
  let scrollLeft;

  container.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    isDown = true;
    container.classList.add('grabbing');
    startX = e.pageX - container.offsetLeft;
    scrollLeft = container.scrollLeft;
  });

  window.addEventListener('mouseup', () => {
    isDown = false;
    container.classList.remove('grabbing');
  });

  container.addEventListener('mousemove', (e) => {
    if (!isDown) return;
    e.preventDefault();
    const x = e.pageX - container.offsetLeft;
    const walk = (x - startX) * 1.5;
    container.scrollLeft = scrollLeft - walk;
  });
}

async function refreshBestQuotes() {
  if (!state.best || !state.best.length) return;
  const tickers = state.best.map(b => b.ticker);
  try {
    const quotes = await QuoteService.getQuotes(tickers);
    for (const [t, data] of Object.entries(quotes)) {
      if (data) bestPrices[t] = data;
    }
    renderFavoritosWidget();
  } catch (err) {
    console.warn('Erro ao atualizar cotações de Favoritos:', err);
  }
}

async function refreshAllQuotes() {
  const btn = document.getElementById('btn-sync-quotes');
  if (btn) btn.classList.add('spinning');

  const portfolioTickers = (state.portfolio || []).map(p => p.ticker);
  const watchlistTickers = (state.watchlist || []).map(w => w.ticker);
  const bestTickers = (state.best || []).map(b => b.ticker);
  const allTickers = [...new Set([...portfolioTickers, ...watchlistTickers, ...bestTickers])];

  try {
    if (allTickers.length > 0) {
      allTickers.forEach(t => delete QuoteService.cache[t]);
      const quotes = await QuoteService.getQuotes(allTickers);
      for (const [t, q] of Object.entries(quotes)) {
        if (q) bestPrices[t] = q;
      }
    }
    renderAll();
    renderFavoritosWidget();

    // Sincronização em nuvem
    if (derivedKey) {
      await SyncService.checkBackgroundSync(true);
    }
  } catch (err) {
    console.warn('Erro ao atualizar cotações:', err);
  } finally {
    if (btn) btn.classList.remove('spinning');
  }
}

/* ═══════════════════════════════════════════════════════════
   DETALHES DO ATIVO — TRADINGVIEW & PREÇO JUSTO / VALUATION
   ═══════════════════════════════════════════════════════════ */

let currentDetailTicker = null;
let currentValuationMethod = 'graham'; // 'graham', 'bazin', 'target', 'custom'
let customTargetPrices = {};

function getStockInfo(ticker) {
  const clean = (ticker || '').toUpperCase().trim();
  if (typeof B3_STOCKS !== 'undefined' && Array.isArray(B3_STOCKS)) {
    const found = B3_STOCKS.find(s => s.ticker === clean);
    if (found) return found;
  }
  // Se não estiver na lista estática, montar objeto a partir da carteira/radar
  const portItem = state.portfolio.find(p => p.ticker === clean);
  if (portItem) {
    return {
      ticker: clean,
      name: portItem.name || clean,
      type: portItem.type || 'STOCK',
      sector: 'Carteira Pessoal',
      targetPrice: null,
    };
  }
  const watchItem = state.watchlist.find(w => w.ticker === clean);
  if (watchItem) {
    return {
      ticker: clean,
      name: watchItem.name || clean,
      type: watchItem.type || 'STOCK',
      sector: 'Radar',
      targetPrice: watchItem.targetPrice,
    };
  }
  return {
    ticker: clean,
    name: clean,
    type: 'STOCK',
    sector: 'Mercado B3',
  };
}

function openAssetDetail(ticker) {
  if (!ticker) return;
  const clean = ticker.toUpperCase().trim();
  currentDetailTicker = clean;

  const stockInfo = getStockInfo(clean);
  const quote = getStockQuoteData(clean);

  // 1. Logo e Identificação
  const logoContainer = document.getElementById('detail-asset-logo-container');
  if (logoContainer) {
    logoContainer.innerHTML = renderAssetLogoHtml(clean, 'fav-logo');
  }

  const tickerEl = document.getElementById('detail-asset-ticker');
  if (tickerEl) tickerEl.textContent = clean;

  const nameEl = document.getElementById('detail-asset-name');
  if (nameEl) nameEl.textContent = stockInfo.name || quote.name || clean;

  const sectorEl = document.getElementById('detail-asset-sector');
  if (sectorEl) sectorEl.textContent = stockInfo.sector || 'Mercado Geral';

  const typeBadge = document.getElementById('detail-asset-type-badge');
  const type = stockInfo.type || (clean.endsWith('11') ? (clean.startsWith('BOVA')||clean.startsWith('HASH')||clean.startsWith('IVVB') ? 'ETF' : 'FII') : clean.endsWith('34') ? 'ETF' : 'STOCK');
  if (typeBadge) {
    typeBadge.textContent = type === 'STOCK' ? 'AÇÃO' : type;
    typeBadge.className = `asset-category-badge cat-${type.toLowerCase()}`;
  }

  // Define método padrão de acordo com a categoria
  if (type === 'FII') {
    currentValuationMethod = 'bazin';
  } else if (type === 'ETF') {
    currentValuationMethod = 'target';
  } else {
    currentValuationMethod = 'graham';
  }

  // 2. Atualizar Preço e Variação
  updateDetailPriceUI(clean);

  // 3. Atualizar Valuation e Preço Justo
  renderDetailValuation(clean);

  // 4. Grid de Indicadores Fundamentalistas
  renderDetailFundamentals(stockInfo, quote);

  // 5. Descrição / Sobre o ativo
  const aboutBox = document.getElementById('detail-about-box');
  const aboutText = document.getElementById('detail-about-text');
  if (aboutBox && aboutText) {
    if (stockInfo.desc) {
      aboutText.textContent = stockInfo.desc;
      aboutBox.style.display = 'block';
    } else {
      aboutBox.style.display = 'none';
    }
  }

  // 6. Resumo de Posição do Usuário
  updateDetailUserPosition(clean);

  // 7. Abrir como tela cheia (slide da direita)
  const detailEl = document.getElementById('modal-asset-detail');
  if (detailEl) {
    detailEl.classList.add('active');
    detailEl.scrollTop = 0;
    document.body.style.overflow = 'hidden';
  }
  const navTitle = document.getElementById('detail-nav-title');
  if (navTitle) navTitle.textContent = `${clean} — Detalhes`;

  // 8. Renderizar Gráfico em Tempo Real TradingView
  renderTradingViewChart(clean, type);

  // 9. Atualizar cotação fresca em segundo plano
  QuoteService.getQuotes([clean]).then(quotes => {
    if (quotes[clean] && currentDetailTicker === clean) {
      bestPrices[clean] = quotes[clean];
      updateDetailPriceUI(clean);
      renderDetailValuation(clean);
    }
  });
}

function closeAssetDetail() {
  const detailEl = document.getElementById('modal-asset-detail');
  if (detailEl) {
    detailEl.classList.remove('active');
    document.body.style.overflow = '';
  }
  currentDetailTicker = null;
}

// Fechar com tecla Escape
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    const detailEl = document.getElementById('modal-asset-detail');
    if (detailEl && detailEl.classList.contains('active')) {
      closeAssetDetail();
    }
  }
});

function updateDetailPriceUI(ticker) {
  const quote = getStockQuoteData(ticker);
  const marketOpen = isB3MarketOpen();
  const isClosedVal = !marketOpen || quote.isClosed;

  const priceEl = document.getElementById('detail-asset-price');
  if (priceEl) priceEl.textContent = quote.price != null ? fmtN(quote.price) : '—';

  const chgEl = document.getElementById('detail-asset-change');
  if (chgEl) {
    const chg = quote.change;
    if (chg != null) {
      chgEl.textContent = `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`;
      chgEl.className = `badge-profit ${chg >= 0 ? 'positive' : 'negative'}`;
    } else {
      chgEl.textContent = '0.00%';
      chgEl.className = 'badge-profit neutral';
    }
  }

  const marketBadge = document.getElementById('detail-market-badge');
  if (marketBadge) {
    marketBadge.className = `best-badge-status ${isClosedVal ? 'closed' : 'open'}`;
    marketBadge.textContent = isClosedVal ? 'Últ. Fechamento' : 'Ao vivo';
  }
}

function switchValuationMethod(method) {
  currentValuationMethod = method;
  document.querySelectorAll('#valuation-tabs .val-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.method === method);
  });
  if (currentDetailTicker) {
    renderDetailValuation(currentDetailTicker);
  }
}

function renderDetailValuation(ticker) {
  const stockInfo = getStockInfo(ticker);
  const quote = getStockQuoteData(ticker);
  const curPrice = quote?.price || null;

  // Atualizar botões das tabs
  document.querySelectorAll('#valuation-tabs .val-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.method === currentValuationMethod);
  });

  let fairPrice = null;
  let methodTitle = '';
  let methodTag = '';
  let explanationHtml = '';

  const lpa = stockInfo.lpa != null ? stockInfo.lpa : null;
  const vpa = stockInfo.vpa != null ? stockInfo.vpa : null;
  const divAnual = stockInfo.divAnual != null
    ? stockInfo.divAnual
    : (stockInfo.dy && curPrice ? (curPrice * stockInfo.dy / 100) : null);

  if (currentValuationMethod === 'graham') {
    methodTitle = 'Preço Justo (Benjamin Graham)';
    methodTag = 'Fórmula: √(22.5 × LPA × VPA)';
    if (lpa && vpa && lpa > 0 && vpa > 0) {
      fairPrice = Math.sqrt(22.5 * lpa * vpa);
      explanationHtml = `
        <strong>Fórmula de Benjamin Graham:</strong> √(22.5 × LPA × VPA)<br>
        • Lucro por Ação (LPA): <strong>R$ ${lpa.toFixed(2)}</strong><br>
        • Valor Patrimonial por Ação (VPA): <strong>R$ ${vpa.toFixed(2)}</strong><br>
        Indica o valor intrínseco teórico máximo a pagar para manter múltiplos combinados P/L ≤ 15 e P/VP ≤ 1.5.
      `;
    } else {
      fairPrice = stockInfo.targetPrice || null;
      explanationHtml = `
        Ativo sem LPA ou VPA positivo registrado (comum em FIIs ou empresas em reestruturação).<br>
        Recomendamos analisar pelo <strong>Método Décio Bazin (Dividendos)</strong> ou <strong>Preço Alvo Consenso</strong>.
      `;
    }
  } else if (currentValuationMethod === 'bazin') {
    methodTitle = 'Preço Teto de Dividendos (Décio Bazin)';
    methodTag = 'Fórmula: Proventos Anuais / 6%';
    if (divAnual && divAnual > 0) {
      fairPrice = divAnual / 0.06;
      explanationHtml = `
        <strong>Método Décio Bazin:</strong> Proventos Anuais / 6%<br>
        • Dividendos Projetados/Ano: <strong>R$ ${divAnual.toFixed(2)}</strong> por ação/cota.<br>
        Comprando até <strong>R$ ${fairPrice.toFixed(2)}</strong>, você assegura um Dividend Yield mínimo de <strong>6,0% ao ano</strong> em renda passiva.
      `;
    } else {
      explanationHtml = `Proventos anuais não informados para cálculo automático do Preço Teto Bazin.`;
    }
  } else if (currentValuationMethod === 'target') {
    methodTitle = 'Preço Alvo / Consenso do Mercado';
    methodTag = 'Consenso de Analistas & DCF';
    fairPrice = stockInfo.targetPrice || (curPrice ? curPrice * 1.20 : null);
    explanationHtml = `
      Estimativa média de preço alvo apurada por casas de análise e projeções de fluxo de caixa descontado (DCF).
    `;
  } else if (currentValuationMethod === 'custom') {
    methodTitle = 'Meu Preço Teto Personalizado';
    methodTag = 'Definido pelo Investidor';
    const watchItem = state.watchlist.find(w => w.ticker === ticker);
    const savedCustom = customTargetPrices[ticker] || watchItem?.targetPrice || null;
    fairPrice = savedCustom;
    explanationHtml = `
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <span>Defina o seu Preço Teto de compra:</span>
        <input type="number" step="any" id="input-custom-target" class="form-input" style="width:110px;padding:4px 8px;font-size:0.8rem;" placeholder="R$ 0,00" value="${savedCustom || ''}">
        <button type="button" class="btn-primary" style="padding:4px 10px;font-size:0.75rem;" onclick="saveCustomTargetFromDetail()">Salvar</button>
      </div>
      <div style="font-size:0.7rem;color:var(--text-muted);margin-top:4px;">
        O seu preço teto será salvo nos Favoritos para alertar quando estiver em zona de oportunidade.
      </div>
    `;
  }

  // Preço Justo Label & Value
  const labelEl = document.getElementById('val-fair-label');
  const priceEl = document.getElementById('val-fair-price');
  const methodTagEl = document.getElementById('val-fair-method-tag');
  if (labelEl) labelEl.textContent = methodTitle || 'Preço Justo Estimado';
  if (priceEl) priceEl.textContent = fairPrice != null ? fmtN(fairPrice) : '—';
  if (methodTagEl) methodTagEl.textContent = methodTag;

  // Upside / Projeção de Valorização
  const upsideEl = document.getElementById('val-upside-pct');
  const statusBadge = document.getElementById('val-status-badge');
  const marginNominalEl = document.getElementById('val-margin-nominal');
  const marginDescEl = document.getElementById('val-margin-desc');

  const gaugeCurrent = document.getElementById('val-gauge-current');
  const gaugeTarget = document.getElementById('val-gauge-target');
  const gaugeAssessment = document.getElementById('val-gauge-assessment');
  const gaugeFill = document.getElementById('val-gauge-fill');

  if (gaugeCurrent) gaugeCurrent.textContent = curPrice ? fmtN(curPrice) : '—';
  if (gaugeTarget) gaugeTarget.textContent = fairPrice ? fmtN(fairPrice) : '—';

  if (curPrice != null && fairPrice != null && curPrice > 0) {
    const upsidePct = ((fairPrice - curPrice) / curPrice) * 100;
    const marginNominal = fairPrice - curPrice;

    if (upsideEl) {
      upsideEl.textContent = `${upsidePct >= 0 ? '+' : ''}${upsidePct.toFixed(2)}%`;
      upsideEl.className = `val-metric-value upside ${upsidePct >= 0 ? 'upside' : 'downside'}`;
    }

    if (marginNominalEl) {
      marginNominalEl.textContent = (marginNominal >= 0 ? '+' : '') + fmtN(marginNominal);
    }
    if (marginDescEl) {
      marginDescEl.textContent = marginNominal >= 0
        ? `Desconto de ${fmtN(marginNominal)} por ação`
        : `Ágio de ${fmtN(Math.abs(marginNominal))} acima do justo`;
    }

    // Avaliação & Badge
    if (statusBadge) {
      if (upsidePct >= 20) {
        statusBadge.textContent = '✓ Oportunidade Clara (Margem Alta)';
        statusBadge.className = 'val-status-badge opportunity';
        if (gaugeAssessment) gaugeAssessment.textContent = 'Potencial de Valorização Alto';
      } else if (upsidePct >= 0) {
        statusBadge.textContent = '✓ Abaixo do Preço Justo (Comprar)';
        statusBadge.className = 'val-status-badge opportunity';
        if (gaugeAssessment) gaugeAssessment.textContent = 'Margem de Segurança Positiva';
      } else if (upsidePct >= -8) {
        statusBadge.textContent = '≈ Preço Justo / Neutro';
        statusBadge.className = 'val-status-badge neutral';
        if (gaugeAssessment) gaugeAssessment.textContent = 'Negociando Próximo ao Valor Justo';
      } else {
        statusBadge.textContent = '✕ Acima do Preço Justo (Aguardar)';
        statusBadge.className = 'val-status-badge overvalued';
        if (gaugeAssessment) gaugeAssessment.textContent = 'Preço Esticado / Risco Elevado';
      }
    }

    // Gauge bar fill
    if (gaugeFill) {
      if (upsidePct >= 0) {
        gaugeFill.className = 'val-gauge-fill';
        const fillW = Math.min(100, Math.max(15, Math.round((curPrice / fairPrice) * 100)));
        gaugeFill.style.width = fillW + '%';
      } else {
        gaugeFill.className = 'val-gauge-fill downside';
        gaugeFill.style.width = '100%';
      }
    }
  } else {
    if (upsideEl) {
      upsideEl.textContent = '—';
      upsideEl.className = 'val-metric-value upside';
    }
    if (statusBadge) {
      statusBadge.textContent = 'Aguardando cotação';
      statusBadge.className = 'val-status-badge neutral';
    }
    if (marginNominalEl) marginNominalEl.textContent = '—';
    if (gaugeFill) gaugeFill.style.width = '0%';
  }

  const explBox = document.getElementById('val-formula-explanation');
  if (explBox) explBox.innerHTML = explanationHtml;
}

function saveCustomTargetFromDetail() {
  const input = document.getElementById('input-custom-target');
  if (!input || !currentDetailTicker) return;
  const val = parseFloat(input.value);
  if (isNaN(val) || val <= 0) {
    showToast('Informe um valor de Preço Teto válido.', 'error');
    return;
  }
  customTargetPrices[currentDetailTicker] = val;

  // Se já estiver no radar, atualizar o targetPrice
  const watchItem = state.watchlist.find(w => w.ticker === currentDetailTicker);
  if (watchItem) {
    watchItem.targetPrice = val;
    saveEncryptedState();
    renderWatchlist();
    renderFavoritosWidget();
  }

  renderDetailValuation(currentDetailTicker);
  showToast(`Preço Teto de ${currentDetailTicker} definido para ${fmtN(val)}!`, 'success');
}

function renderDetailFundamentals(stockInfo, quote) {
  const container = document.getElementById('detail-fundamentals-grid');
  if (!container) return;

  const curPrice = quote?.price;
  const pl = stockInfo.pl != null ? (typeof stockInfo.pl === 'number' ? stockInfo.pl.toFixed(2) : stockInfo.pl) : '—';
  const pvp = stockInfo.pvp != null ? (typeof stockInfo.pvp === 'number' ? stockInfo.pvp.toFixed(2) : stockInfo.pvp) : '—';
  const dy = stockInfo.dy != null ? `${stockInfo.dy.toFixed(2)}%` : '—';
  const roe = stockInfo.roe != null ? `${stockInfo.roe.toFixed(2)}%` : '—';
  const margem = stockInfo.netMargin != null ? `${stockInfo.netMargin.toFixed(1)}%` : '—';
  const lpa = stockInfo.lpa != null ? fmtN(stockInfo.lpa) : '—';
  const vpa = stockInfo.vpa != null ? fmtN(stockInfo.vpa) : '—';
  const min52 = stockInfo.min52 != null ? fmtN(stockInfo.min52) : '—';
  const max52 = stockInfo.max52 != null ? fmtN(stockInfo.max52) : '—';

  const metrics = [
    { label: 'P/L (Preço/Lucro)', val: pl },
    { label: 'P/VP (Preço/Patrimônio)', val: pvp },
    { label: 'Div. Yield 12m', val: dy, highlight: true },
    { label: 'ROE (Rentab. PL)', val: roe },
    { label: 'Margem Líquida', val: margem },
    { label: 'LPA (Lucro/Ação)', val: lpa },
    { label: 'VPA (Valor Patrim.)', val: vpa },
    { label: 'Mínima 52 sem.', val: min52 },
    { label: 'Máxima 52 sem.', val: max52 },
  ];

  container.innerHTML = metrics.map(m => `
    <div class="fundamental-item">
      <span class="fundamental-label">${m.label}</span>
      <span class="fundamental-val" style="${m.highlight ? 'color:var(--accent-green);' : ''}">${m.val}</span>
    </div>
  `).join('');
}

function updateDetailUserPosition(ticker) {
  const portItem = state.portfolio.find(p => p.ticker === ticker);
  const watchItem = state.watchlist.find(w => w.ticker === ticker);
  const pill = document.getElementById('detail-user-pos-pill');
  const btnPortText = document.getElementById('btn-detail-portfolio-text');
  const btnRadarText = document.getElementById('btn-detail-radar-text');

  if (btnPortText) btnPortText.textContent = portItem ? 'Editar na Carteira' : '+ Carteira';
  if (btnRadarText) btnRadarText.textContent = watchItem ? 'Editar nos Favoritos' : '☆ Favoritos';

  if (!pill) return;

  if (portItem) {
    const qty = parseFloat(portItem.quantity) || 0;
    const avg = parseFloat(portItem.avgPrice) || 0;
    pill.innerHTML = `💼 <strong>Na Carteira:</strong> ${qty} cotas · PM: ${fmtN(avg)}`;
    pill.style.display = 'block';
  } else if (watchItem) {
    const teto = watchItem.targetPrice ? fmtN(watchItem.targetPrice) : 'Sem teto';
    pill.innerHTML = `⭐ <strong>Nos Favoritos:</strong> Teto monitorado: ${teto}`;
    pill.style.display = 'block';
  } else {
    pill.style.display = 'none';
  }
}

function renderTradingViewChart(ticker, type) {
  const container = document.getElementById('tradingview-chart-box');
  if (!container) return;
  container.innerHTML = '';

  const clean = (ticker || '').toUpperCase().trim();
  const rawBase = clean.replace(/USDT$|BRL$|BTC$/, '');
  const isCrypto = type === 'CRYPTO' ||
                   KNOWN_CRYPTO_LIST.includes(clean) ||
                   KNOWN_CRYPTO_LIST.includes(rawBase) ||
                   clean.endsWith('USDT') ||
                   clean.endsWith('BTC');

  let tvSymbol = `BMFBOVESPA:${clean}`;
  if (clean === 'TRPL4') tvSymbol = 'BMFBOVESPA:ISAE4';
  if (isCrypto) {
    tvSymbol = `BINANCE:${rawBase || clean}USDT`;
  }

  const widgetId = `tv_chart_${Date.now()}`;
  container.innerHTML = `<div id="${widgetId}" style="width:100%;height:100%;min-height:380px;"></div>`;

  const instantiateWidget = () => {
    if (typeof TradingView !== 'undefined' && TradingView.widget) {
      try {
        new TradingView.widget({
          autosize: true,
          symbol: tvSymbol,
          interval: 'D',
          timezone: 'America/Sao_Paulo',
          theme: 'dark',
          style: '1',
          locale: 'br',
          toolbar_bg: '#161b22',
          enable_publishing: false,
          allow_symbol_change: true,
          container_id: widgetId,
          hide_side_toolbar: false,
          studies: ['RSI@tv-basicstudies', 'MASimple@tv-basicstudies'],
        });
        return true;
      } catch (e) {
        console.warn('Erro ao instanciar TradingView:', e);
      }
    }
    return false;
  };

  if (!instantiateWidget()) {
    if (!document.getElementById('tv-script-tag')) {
      const script = document.createElement('script');
      script.id = 'tv-script-tag';
      script.src = 'https://s3.tradingview.com/tv.js';
      script.onload = () => instantiateWidget();
      document.head.appendChild(script);
    } else {
      setTimeout(instantiateWidget, 400);
    }
  }
}

function detailActionCarteira() {
  if (!currentDetailTicker) return;
  const stockInfo = getStockInfo(currentDetailTicker);
  const portItem = state.portfolio.find(p => p.ticker === currentDetailTicker);
  closeAssetDetail();
  if (portItem) {
    openEditAssetModal(portItem.id);
  } else {
    openAddAssetModal({ ticker: currentDetailTicker, name: stockInfo.name, type: stockInfo.type });
  }
}

function detailActionRadar() {
  if (!currentDetailTicker) return;
  const stockInfo = getStockInfo(currentDetailTicker);
  const watchIndex = state.watchlist.findIndex(w => w.ticker === currentDetailTicker);

  if (watchIndex !== -1) {
    // Se já estiver nos Favoritos, remove diretamente (1-clique toggle)
    state.watchlist.splice(watchIndex, 1);
    saveEncryptedState();
    renderAll();
    updateDetailUserPos(currentDetailTicker);
    showToast(`${currentDetailTicker} removido dos Favoritos.`, 'info');
  } else {
    // Se não estiver nos Favoritos, adiciona DIRETAMENTE sem abrir formulário e sem pedir dados
    const quote = getStockQuoteData(currentDetailTicker);
    const cur = (quote?.price != null) ? quote.price : null;
    let target = null;
    if (stockInfo.lpa && stockInfo.vpa && stockInfo.lpa > 0 && stockInfo.vpa > 0) {
      target = parseFloat((Math.sqrt(22.5 * stockInfo.lpa * stockInfo.vpa)).toFixed(2));
    } else if (stockInfo.targetPrice) {
      target = stockInfo.targetPrice;
    }

    const item = {
      id: genId(),
      ticker: currentDetailTicker,
      name: stockInfo.name || currentDetailTicker,
      type: stockInfo.type || 'STOCK',
      targetPrice: target,
      currentPrice: cur,
      rank: null,
      notes: ''
    };

    state.watchlist.push(item);
    saveEncryptedState();
    renderAll();
    updateDetailUserPos(currentDetailTicker);
    showToast(`★ ${currentDetailTicker} adicionado aos Favoritos!`, 'success');
  }
}

function copyAssetSummary() {
  if (!currentDetailTicker) return;
  const stockInfo = getStockInfo(currentDetailTicker);
  const quote = getStockQuoteData(currentDetailTicker);
  const priceStr = quote.price != null ? fmtN(quote.price) : 'N/D';
  const chgStr = quote.change != null ? `${quote.change >= 0 ? '+' : ''}${quote.change.toFixed(2)}%` : '0.00%';

  let summary = `📊 ${currentDetailTicker} — ${stockInfo.name || currentDetailTicker}\n`;
  summary += `💰 Preço Atual: ${priceStr} (${chgStr})\n`;
  if (stockInfo.lpa && stockInfo.vpa) {
    const graham = Math.sqrt(22.5 * stockInfo.lpa * stockInfo.vpa);
    const upside = quote.price ? (((graham - quote.price) / quote.price) * 100).toFixed(1) : '—';
    summary += `🎯 Preço Justo (Graham): ${fmtN(graham)} (Upside: ${upside}%)\n`;
  }
  if (stockInfo.dy) summary += `📈 Dividend Yield: ${stockInfo.dy.toFixed(2)}%\n`;
  if (stockInfo.pl) summary += `📉 P/L: ${stockInfo.pl.toFixed(2)} | P/VP: ${(stockInfo.pvp||0).toFixed(2)}\n`;

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(summary).then(() => {
      showToast('Resumo do ativo copiado!', 'success');
    }).catch(() => prompt('Copie o resumo:', summary));
  } else {
    prompt('Copie o resumo:', summary);
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
  renderFavoritosWidget();
  refreshBestQuotes();
  closeModal('modal-best-edit');
  showToast('Favoritas atualizadas com sucesso!', 'success');
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
    const quote     = getStockQuoteData(s.ticker);
    const priceData = explorerPrices[s.ticker] || (quote?.price != null ? quote : null);
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
        <div style="display:flex;align-items:center;gap:8px;cursor:pointer;" onclick="openAssetDetail('${s.ticker}')" title="Ver gráfico TradingView e Preço Justo">
          ${renderAssetLogoHtml(s.ticker, 'explorer-logo')}
          <span class="explorer-ticker">${escapeHtml(s.ticker)}</span>
        </div>
      </td>
      <td><span class="explorer-name" style="cursor:pointer;" onclick="openAssetDetail('${s.ticker}')" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</span></td>
      <td style="color:var(--text-secondary);font-size:.78rem;">${escapeHtml(s.sector)}</td>
      <td class="explorer-price">${priceStr}</td>
      <td>${changeStr}</td>
      <td>
        <div class="explorer-actions">
          ${inWatchlist
            ? `<span class="explorer-action-btn radar" style="opacity:.5;cursor:default;">★ Favoritos</span>`
            : `<button class="explorer-action-btn radar" onclick="explorerAddToRadar('${s.ticker}','${escapeAttr(s.name)}','${s.type}')">☆ Favoritos</button>`
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

/* Atalho: Adicionar ativo do Explorer aos Favoritos */
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
  showToast(`${ticker} adicionado aos Favoritos!`, 'success');
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
  document.getElementById('asset-date').value     = new Date().toISOString().split('T')[0];
  document.getElementById('asset-op-type').value  = 'BUY';
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
  document.getElementById('asset-date').value     = a.date || new Date().toISOString().split('T')[0];
  document.getElementById('asset-op-type').value  = 'BUY';
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
  const date    = document.getElementById('asset-date').value || new Date().toISOString().split('T')[0];
  const opType  = document.getElementById('asset-op-type').value || 'BUY';
  const qty     = parseFloat(document.getElementById('asset-quantity').value);
  const avg     = parseFloat(document.getElementById('asset-avg-price').value);
  const curRaw  = document.getElementById('asset-current-price').value;
  const cur     = curRaw ? parseFloat(curRaw) : null;
  const notes   = document.getElementById('asset-notes').value.trim();

  if (!ticker || isNaN(qty) || isNaN(avg)) {
    showToast('Preencha todos os campos obrigatórios.', 'error'); return;
  }

  const existing = editingId ? state.portfolio.find(x => x.id === editingId) : null;
  let transactions = existing && Array.isArray(existing.transactions) ? [...existing.transactions] : [];

  if (!editingId || transactions.length === 0) {
    transactions = [{
      id: genId(),
      date,
      type: opType,
      quantity: qty,
      price: avg,
      total: qty * avg,
      notes
    }];
  }

  const item = {
    id, ticker, name, type,
    quantity: qty,
    avgPrice: avg,
    currentPrice: cur,
    notes,
    date,
    transactions
  };

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
  showToast(editingId ? 'Ativo atualizado!' : 'Ativo adicionado com sucesso!', 'success');
});

function deleteAsset(id) {
  deleteAssetWithUndo(id);
}

/* ═══════════════════════════════════════════════════════════
   CRUD — WATCHLIST
   ═══════════════════════════════════════════════════════════ */

function openAddWatchlistModal(prefill = {}) {
  editingId = null;
  document.getElementById('modal-watchlist-title').textContent = 'Adicionar aos Favoritos';
  document.getElementById('watchlist-id').value = '';
  document.getElementById('watchlist-ticker').value       = prefill.ticker || '';
  document.getElementById('watchlist-name').value         = prefill.name   || '';
  document.getElementById('watchlist-type').value         = prefill.type   || 'STOCK';
  document.getElementById('watchlist-target-price').value  = '';
  document.getElementById('watchlist-current-price').value = '';
  document.getElementById('watchlist-rank').value         = '';
  document.getElementById('watchlist-notes').value        = '';
  openModal('modal-watchlist');
}

function openEditWatchlistModal(id) {
  const a = state.watchlist.find(x => x.id === id);
  if (!a) return;
  editingId = id;
  document.getElementById('modal-watchlist-title').textContent = 'Editar Favorito';
  document.getElementById('watchlist-id').value = id;
  document.getElementById('watchlist-ticker').value       = a.ticker;
  document.getElementById('watchlist-name').value         = a.name || '';
  document.getElementById('watchlist-type').value         = a.type;
  document.getElementById('watchlist-target-price').value  = a.targetPrice || '';
  document.getElementById('watchlist-current-price').value = a.currentPrice || '';
  document.getElementById('watchlist-rank').value         = a.rank || '';
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
  const rank   = parseInt(document.getElementById('watchlist-rank').value) || null;
  const notes  = document.getElementById('watchlist-notes').value.trim();

  if (!ticker) { showToast('Ticker obrigatório.', 'error'); return; }

  const item = { id, ticker, name, type, targetPrice: target, currentPrice: cur, rank, notes };

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
  showToast(editingId ? 'Favorito atualizado!' : 'Ativo adicionado aos Favoritos!', 'success');
});

function deleteWatchlistItem(id) {
  deleteWatchlistItemWithUndo(id);
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
    renderFavoritosWidget();
  });
});

document.getElementById('search-assets').addEventListener('input', e => {
  searchQuery = e.target.value;
  renderPortfolio();
  renderWatchlist();
});

// Auto-preenchimento inteligente ao digitar ticker nos formulários
function setupTickerAutoComplete(tickerInputId, nameInputId, typeSelectId) {
  const tickerInput = document.getElementById(tickerInputId);
  const nameInput   = document.getElementById(nameInputId);
  const typeSelect  = document.getElementById(typeSelectId);

  if (!tickerInput || !nameInput || !typeSelect) return;

  tickerInput.addEventListener('input', (e) => {
    const val = (e.target.value || '').toUpperCase().trim();
    if (val.length >= 2) {
      const info = getStockInfo(val);
      if (info && info.name && info.name !== val) {
        if (!nameInput.value || nameInput.value === val) {
          nameInput.value = info.name;
        }
        if (info.type) {
          typeSelect.value = info.type;
        }
      } else {
        // Detecção automática de tipo por padrão de ticker
        if (val.endsWith('11') && !val.startsWith('BOVA') && !val.startsWith('IVVB') && !val.startsWith('HASH') && !val.startsWith('SMAL') && !val.startsWith('SPXI') && !val.startsWith('BITH') && !val.startsWith('ETHE')) {
          typeSelect.value = 'FII';
        } else if (val.endsWith('34') || val.startsWith('BOVA') || val.startsWith('IVVB') || val.startsWith('HASH') || val.startsWith('SMAL') || val.startsWith('SPXI')) {
          typeSelect.value = 'ETF';
        } else if (['BTC','ETH','SOL','BNB','XRP','ADA','DOGE'].includes(val)) {
          typeSelect.value = 'CRYPTO';
        }
      }
    }
  });
}

setupTickerAutoComplete('asset-ticker', 'asset-name', 'asset-type');
setupTickerAutoComplete('watchlist-ticker', 'watchlist-name', 'watchlist-type');

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
   DADOS INICIAIS (Demo Completo: Ações, FIIs, ETFs, Cripto)
   ═══════════════════════════════════════════════════════════ */

function initDefaultData() {
  if (state.portfolio.length === 0 && state.watchlist.length === 0) {
    state.portfolio = [
      { id: genId(), ticker: 'PETR4', name: 'Petrobras PN', type: 'STOCK', quantity: 100, avgPrice: 35.5, currentPrice: 37.0, notes: 'Dividendos consistentes' },
      { id: genId(), ticker: 'ALUP4', name: 'Alupar PN', type: 'STOCK', quantity: 80, avgPrice: 28.5, currentPrice: 30.2, notes: 'Transmissão de energia previsível' },
      { id: genId(), ticker: 'VALE3', name: 'Vale S.A.', type: 'STOCK', quantity: 50, avgPrice: 68.0, currentPrice: 65.0, notes: 'Commodities — minério de ferro' },
      { id: genId(), ticker: 'BBAS3', name: 'Banco do Brasil S.A.', type: 'STOCK', quantity: 60, avgPrice: 26.0, currentPrice: 28.4, notes: 'Dividendos e valuation atrativo' },
      { id: genId(), ticker: 'WEGE3', name: 'WEG S.A.', type: 'STOCK', quantity: 30, avgPrice: 42.0, currentPrice: 45.0, notes: 'Crescimento e inovação' },
      { id: genId(), ticker: 'HGLG11', name: 'CSHG Logística', type: 'FII', quantity: 20, avgPrice: 162.0, currentPrice: 168.0, notes: 'Galpões logísticos classe A+' },
      { id: genId(), ticker: 'MXRF11', name: 'Maxi Renda', type: 'FII', quantity: 250, avgPrice: 10.2, currentPrice: 10.5, notes: 'Rendimento mensal de CRI' },
      { id: genId(), ticker: 'XPML11', name: 'XP Malls', type: 'FII', quantity: 25, avgPrice: 112.0, currentPrice: 116.0, notes: 'Shoppings premium' },
      { id: genId(), ticker: 'BOVA11', name: 'iShares Ibovespa ETF', type: 'ETF', quantity: 30, avgPrice: 120.0, currentPrice: 125.0, notes: 'Diversificação no mercado Brasil' },
      { id: genId(), ticker: 'IVVB11', name: 'iShares S&P 500 ETF', type: 'ETF', quantity: 15, avgPrice: 310.0, currentPrice: 345.0, notes: 'Exposição a dólar e S&P 500' },
      { id: genId(), ticker: 'BTC', name: 'Bitcoin', type: 'CRYPTO', quantity: 0.05, avgPrice: 320000.0, currentPrice: 360000.0, notes: 'Reserva digital descentralizada' },
    ];
    state.watchlist = [
      { id: genId(), ticker: 'ALUP11', name: 'Alupar Unit', type: 'STOCK', targetPrice: 32.0, currentPrice: null, rank: 1, notes: 'Comprar se atingir preço teto' },
      { id: genId(), ticker: 'ITUB4', name: 'Itaú Unibanco PN', type: 'STOCK', targetPrice: 33.0, currentPrice: null, rank: 2, notes: 'Aguardando correção' },
      { id: genId(), ticker: 'BTLG11', name: 'BTG Pactual Logística', type: 'FII', targetPrice: 102.0, currentPrice: null, rank: 3, notes: 'FII logístico raio 30km SP' },
      { id: genId(), ticker: 'KNCR11', name: 'Kinea Rendimentos', type: 'FII', targetPrice: 104.0, currentPrice: null, rank: 4, notes: 'Indexado ao CDI' },
      { id: genId(), ticker: 'HASH11', name: 'Hashdex Nasdaq Crypto', type: 'ETF', targetPrice: 52.0, currentPrice: null, rank: 5, notes: 'Cripto regulado na B3' },
      { id: genId(), ticker: 'ETH', name: 'Ethereum', type: 'CRYPTO', targetPrice: 18000.0, currentPrice: null, rank: 6, notes: 'Líder em contratos inteligentes' },
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
  if (id === 'modal-goals-config') {
    const g = getGoalsState();
    const retInput = document.getElementById('cfg-retirement-goal');
    const pasInput = document.getElementById('cfg-target-passive');
    const livInput = document.getElementById('cfg-cost-of-living');
    const yldInput = document.getElementById('cfg-estimated-yield');
    if (retInput) retInput.value = g.retirementTarget || 1000000;
    if (pasInput) pasInput.value = g.targetPassiveIncome || 5000;
    if (livInput) livInput.value = g.costOfLiving || 3500;
    if (yldInput) yldInput.value = g.estimatedMonthlyYield || 0.60;
  }
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
   HELPERS DE SINCRONIZAÇÃO & QR CODE
   ═══════════════════════════════════════════════════════════ */

function getVaultTransferBlob() {
  const syncId = SyncService.getSyncId();
  if (derivedKey) {
    const freshEnc = encryptState(derivedKey);
    if (freshEnc) localStorage.setItem(STORAGE_KEY, freshEnc);
  }
  const authMeta = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null');
  const encData  = localStorage.getItem(STORAGE_KEY);
  if (!authMeta || !encData) return null;
  const payload = {
    syncId,
    authMeta,
    encData,
    updatedAt: Date.now(),
    version: APP_VERSION,
  };
  try {
    return btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
  } catch {
    try {
      return btoa(JSON.stringify(payload));
    } catch {
      return null;
    }
  }
}

async function copySyncId() {
  const syncId = SyncService.getSyncId();
  SyncService.pushVault(true).catch(() => {});
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(syncId).then(() => {
      showToast(`ID copiado: ${syncId}`, 'success');
    }).catch(() => {
      prompt('Copie seu ID de Sincronização:', syncId);
    });
  } else {
    prompt('Copie seu ID de Sincronização:', syncId);
  }
}

async function copySyncPairingLink() {
  const syncId = SyncService.getSyncId();
  SyncService.pushVault(true).catch(() => {});
  const blob   = getVaultTransferBlob();
  const base   = window.location.href.split('#')[0];
  const url    = blob ? `${base}#vault=${blob}` : `${base}#sync=${syncId}`;

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => {
      showToast('Link direto com sua carteira copiado!', 'success');
    }).catch(() => {
      prompt('Copie o link direto de acesso:', url);
    });
  } else {
    prompt('Copie o link direto de acesso:', url);
  }
}

async function copyVaultCode() {
  SyncService.pushVault(true).catch(() => {});
  const blob = getVaultTransferBlob();
  if (!blob) {
    showToast('Nenhum cofre encontrado para transferir.', 'error');
    return;
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(blob).then(() => {
      showToast('Código do cofre copiado! Cole no PC.', 'success');
    }).catch(() => {
      prompt('Copie o Código do Cofre:', blob);
    });
  } else {
    prompt('Copie o Código do Cofre:', blob);
  }
}

async function handleImportVaultModal(e) {
  e.preventDefault();
  const inputEl = document.getElementById('import-vault-input');
  const pinEl   = document.getElementById('import-vault-pin');
  const errEl   = document.getElementById('import-vault-error');
  const btn     = document.getElementById('btn-import-vault-submit');

  if (errEl) errEl.style.display = 'none';
  const text = (inputEl?.value || '').trim();
  const pin  = pinEl?.value || '';

  if (!text) {
    if (errEl) { errEl.textContent = 'Cole o link ou código do cofre.'; errEl.style.display = 'block'; }
    return;
  }
  if (!pin || pin.length < 4) {
    if (errEl) { errEl.textContent = 'PIN deve ter pelo menos 4 caracteres.'; errEl.style.display = 'block'; }
    return;
  }

  btn.disabled = true;
  btn.innerHTML = `<svg class="spinning" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg> Importando…`;

  // 1. Tentar extrair do link #vault=... ou código base64 direto
  let rawBlob = text;
  if (text.includes('#vault=')) {
    rawBlob = text.split('#vault=')[1].split('&')[0];
  } else if (text.includes('vault=')) {
    rawBlob = text.split('vault=')[1].split('&')[0];
  }

  let vault = parseVaultTransferBlob(rawBlob);

  if (vault) {
    const res = applyDecryptedVault(vault, pin);
    if (res.success) {
      closeModal('modal-import-vault');
      renderAll();
      SyncService.updateUi();
      showToast('Carteira importada e atualizada com sucesso!', 'success');
      btn.disabled = false;
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Carregar Carteira`;
      return;
    } else {
      if (errEl) { errEl.textContent = res.error || 'PIN incorreto para este cofre.'; errEl.style.display = 'block'; }
      btn.disabled = false;
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Carregar Carteira`;
      return;
    }
  }

  // 2. Se for um Sync ID (ex: CAD-XXXX-XXXX), buscar na nuvem
  const cleanId = text.toUpperCase().replace(/.*SYNC=/i, '').split('&')[0].trim();
  if (cleanId.startsWith('CAD-')) {
    try {
      const res = await SyncService.connectWallet(cleanId, pin);
      if (res.success) {
        closeModal('modal-import-vault');
        renderAll();
        SyncService.updateUi();
        showToast('Carteira conectada e atualizada com sucesso!', 'success');
      } else {
        if (errEl) { errEl.textContent = res.error || 'Erro ao sincronizar cofre.'; errEl.style.display = 'block'; }
      }
    } catch {
      if (errEl) { errEl.textContent = 'Erro de rede ao conectar com a nuvem.'; errEl.style.display = 'block'; }
    }
    btn.disabled = false;
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Carregar Carteira`;
    return;
  }

  if (errEl) {
    errEl.textContent = 'Código ou Link não reconhecido. Certifique-se de copiar o Link Direto ou Código completo gerado no seu celular.';
    errEl.style.display = 'block';
  }
  btn.disabled = false;
  btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Carregar Carteira`;
}

let qrcodeInstance = null;
async function openSyncQrModal() {
  const syncId = SyncService.getSyncId();
  SyncService.pushVault(true).catch(() => {});
  SyncService.updateUi();

  const container = document.getElementById('sync-qrcode-container');
  if (container) {
    container.innerHTML = '';
    const blob = getVaultTransferBlob();
    const base = window.location.href.split('#')[0];
    const url  = (blob && blob.length < 2400) ? `${base}#vault=${blob}` : `${base}#sync=${syncId}`;

    if (typeof QRCode !== 'undefined') {
      try {
        qrcodeInstance = new QRCode(container, {
          text: url,
          width: 170,
          height: 170,
          colorDark: '#0d1117',
          colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.L,
        });
      } catch {
        qrcodeInstance = new QRCode(container, {
          text: `${base}#sync=${syncId}`,
          width: 170,
          height: 170,
          colorDark: '#0d1117',
          colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.M,
        });
      }
    } else {
      container.innerHTML = `<p style="font-size:0.75rem;color:var(--text-muted);padding:20px;">Use o ID: <strong>${syncId}</strong></p>`;
    }
  }

  openModal('modal-sync-qr');
}

function openCloudModal() {
  const epInput = document.getElementById('cloud-cfg-endpoint');
  const tkInput = document.getElementById('cloud-cfg-token');
  if (epInput) epInput.value = SyncService.getEndpoint();
  if (tkInput) tkInput.value = SyncService.getToken();
  openModal('modal-cloud-config');
}

async function forceCloudSync() {
  const btn = document.getElementById('btn-force-sync');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<svg class="spinning" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg> Sincronizando…`;
  }

  try {
    await SyncService.checkBackgroundSync();
    showToast('Sincronização concluída com sucesso!', 'success');
  } catch {
    showToast('Erro ao sincronizar com a nuvem.', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg> Sincronizar Agora`;
    }
  }
}

function restoreDefaultCloudConfig() {
  localStorage.removeItem(CLOUD_ENDPOINT_KEY);
  localStorage.removeItem(CLOUD_TOKEN_KEY);
  const epInput = document.getElementById('cloud-cfg-endpoint');
  const tkInput = document.getElementById('cloud-cfg-token');
  if (epInput) epInput.value = DEFAULT_CLOUD_URL;
  if (tkInput) tkInput.value = DEFAULT_CLOUD_TOKEN;
  showToast('Configuração padrão da nuvem restaurada.', 'info');
}

async function saveCustomCloudConfig() {
  const ep = (document.getElementById('cloud-cfg-endpoint')?.value || '').trim();
  const tk = (document.getElementById('cloud-cfg-token')?.value || '').trim();

  if (!ep || !tk) {
    showToast('Preencha o Endpoint e o Token.', 'error');
    return;
  }

  localStorage.setItem(CLOUD_ENDPOINT_KEY, ep);
  localStorage.setItem(CLOUD_TOKEN_KEY, tk);
  closeModal('modal-cloud-config');
  showToast('Configuração salva. Testando sincronização…', 'info');
  await SyncService.pushVault(true);
}

/* ═══════════════════════════════════════════════════════════
   ATALHO DE TECLADO — / ou Ctrl+K para busca
   ═══════════════════════════════════════════════════════════ */
document.addEventListener('keydown', e => {
  const tag = (document.activeElement || {}).tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if ((e.key === '/' ) || (e.ctrlKey && e.key === 'k')) {
    e.preventDefault();
    const searchEl = document.getElementById('search-assets');
    if (searchEl) {
      // Navegar para a aba carteira se não estiver nela
      if (currentTab !== 'carteira' && currentTab !== 'radar') switchTab('carteira');
      searchEl.focus();
      searchEl.select();
    }
  }
});

/* ═══════════════════════════════════════════════════════════
   META DE APORTE MENSAL
   ═══════════════════════════════════════════════════════════ */
function saveMonthlyGoal() {
  const input = document.getElementById('cfg-monthly-goal');
  if (!input) return;
  const val = parseFloat(input.value.replace(',', '.')) || 0;
  state.monthlyGoal = val;
  saveEncryptedState();
  renderSummary();
  showToast('Meta de aporte salva!', 'success');
}

function renderMonthlyGoalProgress() {
  const el = document.getElementById('monthly-goal-progress');
  if (!el || !state.monthlyGoal) { if (el) el.style.display = 'none'; return; }

  // Calcular total investido no mês atual (baseado nos aportes — aproximado pelo total investido)
  const goal = parseFloat(state.monthlyGoal) || 0;
  if (!goal) { el.style.display = 'none'; return; }

  // Como não temos histórico de datas de aporte, usamos um valor fixo de progresso do mês
  // (o usuário pode ajustar manualmente via campo)
  const contributed = parseFloat(state.monthlyContributed || 0);
  const pct = Math.min((contributed / goal) * 100, 100);

  el.style.display = '';
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;">
      <span style="font-size:0.7rem;color:var(--text-secondary);font-weight:600;text-transform:uppercase;letter-spacing:.06em;">Meta Aporte Mensal</span>
      <span style="font-size:0.72rem;color:var(--text-muted);">${privacyMode ? '••••' : fmtN(contributed)} / ${privacyMode ? '••••' : fmtN(goal)}</span>
    </div>
    <div style="height:5px;background:var(--bg-surface);border-radius:var(--radius-full);overflow:hidden;">
      <div style="height:100%;width:${pct}%;background:${pct >= 100 ? 'var(--accent-green)' : 'var(--accent-blue)'};border-radius:var(--radius-full);transition:width .4s ease;"></div>
    </div>
    <div style="font-size:0.65rem;color:var(--text-muted);margin-top:3px;text-align:right;">${pct.toFixed(0)}% da meta atingida</div>`;
}

/* ═══════════════════════════════════════════════════════════
   MÓDULO: METAS DE APOSENTADORIA & ALVOS INTERATIVOS
   ═══════════════════════════════════════════════════════════ */

const MOTIVATIONAL_QUOTES = [
  { quote: "Cada centavo investido hoje é um soldado trabalhando 24h por dia pela sua liberdade amanhã.", author: "Mentalidade Investidora" },
  { quote: "O primeiro milhão é o mais difícil porque você trabalha pelo dinheiro. Os seguintes acontecem porque o dinheiro trabalha por você.", author: "Charlie Munger" },
  { quote: "A riqueza é o que você não vê: são as escolhas silenciosas de economizar para poder comprar seu próprio tempo.", author: "Morgan Housel" },
  { quote: "A melhor época para plantar uma árvore foi há 20 anos. O segundo melhor momento é agora.", author: "Provérbio" },
  { quote: "Os juros compostos são a oitava maravilha do mundo. Aquele que entende, ganha; aquele que não entende, paga.", author: "Albert Einstein" },
  { quote: "Não economize o que sobra depois de gastar, mas gaste o que sobra depois de investir.", author: "Warren Buffett" },
  { quote: "A liberdade financeira não é sobre ostentação, é sobre a paz de ser dono do seu próprio destino.", author: "Independência Financeira" },
  { quote: "Com consistência e paciência, o efeito bola de neve transforma pequenos aportes em fortunas inevitáveis.", author: "Poder dos Aportes" }
];

const DEFAULT_MILESTONES = [
  { level: 1, name: "Pé de Meia", target: 10000, icon: "🛡️", desc: "A primeira barreira da segurança financeira pessoal." },
  { level: 2, name: "Primeiros Passos", target: 50000, icon: "🌱", desc: "O hábito consistente de investir consolidado." },
  { level: 3, name: "A Barreira dos 100k", target: 100000, icon: "🚀", desc: "O marco mais difícil! A partir daqui a bola de neve acelera." },
  { level: 4, name: "O Efeito Bola de Neve", target: 250000, icon: "❄️", desc: "Os rendimentos mensais começam a superar o valor do seu aporte." },
  { level: 5, name: "Meio Milhão", target: 500000, icon: "💎", desc: "Reta final da independência. Liberdade parcial garantida." },
  { level: 6, name: "Aposentadoria & Liberdade", target: 1000000, icon: "👑", desc: "Independência financeira plena! Seus dividendos pagam sua vida." }
];

function getGoalsState() {
  if (!state.goals || typeof state.goals !== 'object') {
    state.goals = {
      retirementTarget: 1000000,
      targetPassiveIncome: 5000,
      costOfLiving: 3500,
      estimatedMonthlyYield: 0.60,
      customTargets: [
        { id: 't-reserva', title: 'Reserva de Emergência', category: '🛡️', amount: 20000, saved: 12000 },
        { id: 't-viagem', title: 'Viagem dos Sonhos', category: '✈️', amount: 15000, saved: 5500 }
      ]
    };
  }
  if (!Array.isArray(state.goals.customTargets)) state.goals.customTargets = [];
  if (!state.goals.retirementTarget) state.goals.retirementTarget = 1000000;
  if (!state.goals.targetPassiveIncome) state.goals.targetPassiveIncome = 5000;
  if (!state.goals.costOfLiving) state.goals.costOfLiving = 3500;
  if (!state.goals.estimatedMonthlyYield) state.goals.estimatedMonthlyYield = 0.60;
  return state.goals;
}

function calculateCurrentPortfolioTotal() {
  let total = 0;
  for (const a of (state.portfolio || [])) {
    const qty = parseFloat(a.quantity) || 0;
    const avg = parseFloat(a.avgPrice) || 0;
    const quote = getStockQuoteData(a.ticker);
    const cur = (a.currentPrice != null && parseFloat(a.currentPrice) > 0)
      ? parseFloat(a.currentPrice)
      : (quote?.price != null ? quote.price : avg);
    total += qty * cur;
  }
  return total;
}

function renderHeroGoalsBadge(totalOverride) {
  const badgeEl = document.getElementById('hero-goals-badge');
  if (!badgeEl) return;

  const g = getGoalsState();
  const total = totalOverride != null ? totalOverride : calculateCurrentPortfolioTotal();
  const retirementGoal = parseFloat(g.retirementTarget) || 1000000;
  const pct = Math.min((total / retirementGoal) * 100, 100);

  const pctEl = document.getElementById('hgb-pct');
  const descEl = document.getElementById('hgb-desc');

  if (pctEl) pctEl.textContent = `${pct.toFixed(1)}%`;

  // Descobrir próximo marco
  let nextMilestone = DEFAULT_MILESTONES[DEFAULT_MILESTONES.length - 1];
  for (const m of DEFAULT_MILESTONES) {
    if (total < m.target) {
      nextMilestone = m;
      break;
    }
  }

  if (descEl) {
    if (total >= retirementGoal) {
      descEl.textContent = '👑 Meta de Aposentadoria Conquistada! Parabéns!';
    } else {
      const missing = nextMilestone.target - total;
      descEl.textContent = `${nextMilestone.icon} Próximo Marco: ${fmt(nextMilestone.target)} · Faltam ${fmt(missing)}`;
    }
  }
}

function renderGoalsView() {
  const g = getGoalsState();
  const total = calculateCurrentPortfolioTotal();
  const retirementGoal = parseFloat(g.retirementTarget) || 1000000;
  const targetPassive = parseFloat(g.targetPassiveIncome) || 5000;
  const costOfLiving = parseFloat(g.costOfLiving) || 3500;
  const monthlyYieldRate = (parseFloat(g.estimatedMonthlyYield) || 0.60) / 100;

  const currentPassiveMonthly = total * monthlyYieldRate;
  const pctOfRetirement = Math.min((total / retirementGoal) * 100, 100);
  const passivePct = targetPassive > 0 ? Math.min((currentPassiveMonthly / targetPassive) * 100, 100) : 0;
  const coverageMonths = costOfLiving > 0 ? (total / costOfLiving) : 0;

  // 1. Termômetro Principal
  const mainPctEl = document.getElementById('freedom-main-pct');
  const barFillEl = document.getElementById('freedom-bar-fill');
  const statusBadgeEl = document.getElementById('freedom-status-badge');
  const markerMidEl = document.getElementById('freedom-marker-mid');
  const markerGoalEl = document.getElementById('freedom-marker-goal');

  if (mainPctEl) mainPctEl.textContent = `${pctOfRetirement.toFixed(1)}%`;
  if (barFillEl) barFillEl.style.width = `${pctOfRetirement}%`;
  if (markerMidEl) markerMidEl.textContent = fmt(retirementGoal / 2);
  if (markerGoalEl) markerGoalEl.textContent = `Meta: ${fmt(retirementGoal)}`;

  if (statusBadgeEl) {
    if (pctOfRetirement >= 100) {
      statusBadgeEl.textContent = '👑 Nível 6: Liberdade Plena Conquistada!';
      statusBadgeEl.className = 'freedom-status-badge level-6';
    } else if (pctOfRetirement >= 50) {
      statusBadgeEl.textContent = '💎 Nível 5: Reta Final da Independência';
      statusBadgeEl.className = 'freedom-status-badge level-5';
    } else if (pctOfRetirement >= 25) {
      statusBadgeEl.textContent = '❄️ Nível 4: O Efeito Bola de Neve';
      statusBadgeEl.className = 'freedom-status-badge level-4';
    } else if (pctOfRetirement >= 10) {
      statusBadgeEl.textContent = '🚀 Nível 3: Rompendo a Barreira';
      statusBadgeEl.className = 'freedom-status-badge level-3';
    } else if (pctOfRetirement >= 5) {
      statusBadgeEl.textContent = '🌱 Nível 2: Hábito Consistente';
      statusBadgeEl.className = 'freedom-status-badge level-2';
    } else {
      statusBadgeEl.textContent = '🛡️ Nível 1: Construindo a Base';
      statusBadgeEl.className = 'freedom-status-badge level-1';
    }
  }

  // 2. Grid de Métricas
  const curEl = document.getElementById('f-metric-current');
  const missingEl = document.getElementById('f-metric-missing');
  const passiveEl = document.getElementById('f-metric-passive');
  const targetPassiveEl = document.getElementById('f-metric-target-passive');
  const passivePctEl = document.getElementById('f-metric-passive-pct');
  const coverageEl = document.getElementById('f-metric-coverage');
  const coverageHintEl = document.getElementById('f-metric-coverage-hint');

  if (curEl) curEl.textContent = fmt(total);
  if (missingEl) {
    const miss = Math.max(retirementGoal - total, 0);
    missingEl.textContent = miss > 0 ? `Faltam ${fmt(miss)}` : '🎉 Meta Atingida!';
  }
  if (passiveEl) passiveEl.textContent = `${fmt(currentPassiveMonthly)} /mês`;
  if (targetPassiveEl) targetPassiveEl.textContent = `${fmt(targetPassive)} /mês`;
  if (passivePctEl) passivePctEl.textContent = `${passivePct.toFixed(1)}% da renda passiva almejada`;
  
  if (coverageEl) {
    if (coverageMonths >= 12) {
      const years = (coverageMonths / 12).toFixed(1);
      coverageEl.textContent = `${years} anos de vida`;
    } else {
      coverageEl.textContent = `${coverageMonths.toFixed(1)} meses de vida`;
    }
  }
  if (coverageHintEl) coverageHintEl.textContent = `Cobrindo ${fmt(costOfLiving)}/mês de despesas`;

  // 3. Renderizar Milestones Gamificados
  renderMilestones(total, retirementGoal);

  // 4. Renderizar Alvos Personalizados
  renderCustomTargets(total);

  // 5. Atualizar Simulador
  updateFreedomSimulator();
}

function renderMilestones(currentTotal, maxGoal) {
  const container = document.getElementById('milestones-grid');
  if (!container) return;

  const milestones = DEFAULT_MILESTONES.map(m => {
    // Se a meta de aposentadoria do usuário for diferente de 1M, ajusta o último nível
    if (m.level === 6 && maxGoal) return { ...m, target: maxGoal };
    return m;
  });

  container.innerHTML = milestones.map(m => {
    const isCompleted = currentTotal >= m.target;
    const isCurrent = !isCompleted && (milestones.find(x => currentTotal < x.target) || {}).level === m.level;
    const pct = Math.min((currentTotal / m.target) * 100, 100);
    const missing = Math.max(m.target - currentTotal, 0);

    let statusHtml = '';
    let cardClass = 'milestone-card';

    if (isCompleted) {
      cardClass += ' completed';
      statusHtml = `<span class="milestone-badge completed"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Conquistado</span>`;
    } else if (isCurrent) {
      cardClass += ' in-progress';
      statusHtml = `<span class="milestone-badge current">🔥 Em Andamento (${pct.toFixed(0)}%)</span>`;
    } else {
      cardClass += ' locked';
      statusHtml = `<span class="milestone-badge locked">🔒 Bloqueado</span>`;
    }

    return `
      <div class="${cardClass}">
        <div class="milestone-top">
          <div class="milestone-icon-wrap">${m.icon}</div>
          <div class="milestone-info">
            <div class="milestone-level">Nível ${m.level}</div>
            <div class="milestone-title">${m.name}</div>
          </div>
          ${statusHtml}
        </div>
        <div class="milestone-target-val">${fmt(m.target)}</div>
        <div class="milestone-desc">${m.desc}</div>
        <div class="milestone-progress-bar">
          <div class="milestone-progress-fill" style="width: ${pct}%;"></div>
        </div>
        <div class="milestone-footer">
          <span>${pct.toFixed(1)}% atingido</span>
          <span>${isCompleted ? '✓ Concluído' : `Faltam ${fmt(missing)}`}</span>
        </div>
      </div>
    `;
  }).join('');
}

function renderCustomTargets(currentTotal) {
  const container = document.getElementById('custom-targets-grid');
  if (!container) return;

  const g = getGoalsState();
  const list = g.customTargets || [];

  if (list.length === 0) {
    container.innerHTML = `
      <div class="empty-custom-targets" style="grid-column: 1/-1; padding: 24px; text-align: center; background: var(--bg-card); border: 1px dashed var(--border-card); border-radius: var(--radius-md); color: var(--text-muted);">
        <div style="font-size: 1.4rem; margin-bottom: 6px;">✨</div>
        <div style="font-weight: 600; color: var(--text-primary); margin-bottom: 4px;">Nenhum alvo personalizado cadastrado</div>
        <div style="font-size: 0.78rem; margin-bottom: 12px;">Defina metas como Reserva de Emergência, Viagem dos Sonhos, Carro Novo ou Imóvel.</div>
        <button class="btn-secondary" onclick="openAddCustomTargetModal()" style="font-size:0.75rem;">+ Adicionar Primeiro Alvo</button>
      </div>`;
    return;
  }

  container.innerHTML = list.map(t => {
    const saved = parseFloat(t.saved) || 0;
    const amount = parseFloat(t.amount) || 1;
    const pct = Math.min((saved / amount) * 100, 100);
    const missing = Math.max(amount - saved, 0);
    const isDone = saved >= amount;

    return `
      <div class="custom-target-card ${isDone ? 'done' : ''}">
        <div class="ct-header">
          <div class="ct-title-wrap">
            <span class="ct-icon">${t.category || '🎯'}</span>
            <div>
              <div class="ct-title">${escapeHtml(t.title)}</div>
              ${t.deadline ? `<div class="ct-date">Meta até: ${new Date(t.deadline + 'T00:00:00').toLocaleDateString('pt-BR')}</div>` : ''}
            </div>
          </div>
          <div class="ct-actions">
            <button class="action-btn-sm" onclick="openEditCustomTargetModal('${t.id}')" title="Editar">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="action-btn-sm delete" onclick="deleteCustomTarget('${t.id}')" title="Remover">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
            </button>
          </div>
        </div>

        <div class="ct-values">
          <span class="ct-saved">${fmt(saved)}</span>
          <span class="ct-total">de ${fmt(amount)}</span>
        </div>

        <div class="ct-progress-bar">
          <div class="ct-progress-fill ${isDone ? 'done' : ''}" style="width: ${pct}%;"></div>
        </div>

        <div class="ct-footer">
          <span>${pct.toFixed(0)}% concluído</span>
          <span>${isDone ? '🎉 Conquistado!' : `Faltam ${fmt(missing)}`}</span>
        </div>
      </div>
    `;
  }).join('');
}

/* ─── Simulador Interativo de Aposentadoria ───────────────────── */
function syncSimAporte(val) {
  const v = parseFloat(val) || 0;
  const s1 = document.getElementById('sim-aporte-slider');
  const n1 = document.getElementById('sim-aporte');
  if (s1 && s1.value != v) s1.value = Math.min(Math.max(v, 100), 20000);
  if (n1 && n1.value != v) n1.value = v;
  updateFreedomSimulator();
}

function syncSimRate(val) {
  const v = parseFloat(val) || 0;
  const s2 = document.getElementById('sim-rate-slider');
  const n2 = document.getElementById('sim-rate');
  if (s2 && s2.value != v) s2.value = Math.min(Math.max(v, 6), 20);
  if (n2 && n2.value != v) n2.value = v;
  updateFreedomSimulator();
}

function updateFreedomSimulator() {
  const g = getGoalsState();
  const currentTotal = calculateCurrentPortfolioTotal();
  const targetGoal = parseFloat(g.retirementTarget) || 1000000;
  
  const aporteInput = document.getElementById('sim-aporte');
  const rateInput = document.getElementById('sim-rate');

  const pmt = aporteInput ? (parseFloat(aporteInput.value) || 1500) : 1500;
  const annualRate = rateInput ? (parseFloat(rateInput.value) || 11) : 11;
  const monthlyRate = Math.pow(1 + (annualRate / 100), 1 / 12) - 1;

  const resultTimeEl = document.getElementById('sim-time-result');
  const totalInvestidoEl = document.getElementById('sim-total-investido');
  const totalJurosEl = document.getElementById('sim-total-juros');
  const barPrincipalEl = document.getElementById('sim-bar-principal');
  const barJurosEl = document.getElementById('sim-bar-juros');

  if (currentTotal >= targetGoal) {
    if (resultTimeEl) resultTimeEl.innerHTML = `🎉 <strong>Parabéns!</strong> Você já atingiu sua meta de aposentadoria de <strong>${fmt(targetGoal)}</strong>!`;
    if (totalInvestidoEl) totalInvestidoEl.textContent = fmt(currentTotal);
    if (totalJurosEl) totalJurosEl.textContent = 'Meta Conquistada';
    return;
  }

  // Simular mês a mês até atingir a meta
  let balance = currentTotal;
  let months = 0;
  let totalContributed = currentTotal;
  const MAX_MONTHS = 1200; // 100 anos

  while (balance < targetGoal && months < MAX_MONTHS) {
    balance = balance * (1 + monthlyRate) + pmt;
    totalContributed += pmt;
    months++;
  }

  const years = Math.floor(months / 12);
  const remMonths = months % 12;
  const interestEarned = Math.max(targetGoal - totalContributed, 0);
  const principalPct = Math.min((totalContributed / targetGoal) * 100, 100);
  const jurosPct = Math.max(100 - principalPct, 0);

  if (resultTimeEl) {
    let timeStr = '';
    if (years > 0 && remMonths > 0) timeStr = `<strong>${years} anos</strong> e <strong>${remMonths} meses</strong>`;
    else if (years > 0) timeStr = `<strong>${years} anos</strong>`;
    else timeStr = `<strong>${remMonths} meses</strong>`;

    resultTimeEl.innerHTML = `
      ⏱ Com aportes de <strong>${fmt(pmt)}/mês</strong> a <strong>${annualRate.toFixed(1)}% a.a.</strong>, você atinge sua meta de <strong>${fmt(targetGoal)}</strong> em ${timeStr}!
    `;
  }

  if (totalInvestidoEl) totalInvestidoEl.textContent = fmt(totalContributed);
  if (totalJurosEl) totalJurosEl.textContent = fmt(interestEarned);

  if (barPrincipalEl) {
    barPrincipalEl.style.width = `${principalPct}%`;
    barPrincipalEl.title = `Aportes do seu bolso: ${principalPct.toFixed(1)}%`;
  }
  if (barJurosEl) {
    barJurosEl.style.width = `${jurosPct}%`;
    barJurosEl.title = `Juros Compostos: ${jurosPct.toFixed(1)}%`;
  }
}

function refreshMotivationQuote() {
  const quoteEl = document.getElementById('motivation-quote');
  const subEl = document.getElementById('motivation-sub');
  if (!quoteEl) return;

  const rand = MOTIVATIONAL_QUOTES[Math.floor(Math.random() * MOTIVATIONAL_QUOTES.length)];
  quoteEl.style.opacity = '0';
  setTimeout(() => {
    quoteEl.textContent = `"${rand.quote}"`;
    if (subEl) subEl.textContent = `— ${rand.author}`;
    quoteEl.style.opacity = '1';
  }, 150);
}

/* ─── Salvar Configurações de Metas ───────────────────────────── */
function handleSaveGoalsConfig(e) {
  e.preventDefault();
  const retirement = parseFloat(document.getElementById('cfg-retirement-goal')?.value) || 1000000;
  const passive = parseFloat(document.getElementById('cfg-target-passive')?.value) || 5000;
  const living = parseFloat(document.getElementById('cfg-cost-of-living')?.value) || 3500;
  const yieldRate = parseFloat(document.getElementById('cfg-estimated-yield')?.value) || 0.60;

  const g = getGoalsState();
  g.retirementTarget = retirement;
  g.targetPassiveIncome = passive;
  g.costOfLiving = living;
  g.estimatedMonthlyYield = yieldRate;

  saveEncryptedState();
  closeModal('modal-goals-config');
  renderGoalsView();
  renderHeroGoalsBadge();
  showToast('Metas de Aposentadoria salvas!', 'success');
}

/* ─── CRUD de Alvos Personalizados ────────────────────────────── */
let editingTargetId = null;

function openAddCustomTargetModal(prefill = {}) {
  editingTargetId = null;
  document.getElementById('modal-custom-target-title').textContent = '🎯 Novo Alvo Personalizado';
  document.getElementById('target-id').value = '';
  document.getElementById('target-title').value = prefill.title || '';
  document.getElementById('target-category').value = prefill.category || '🛡️';
  document.getElementById('target-amount').value = prefill.amount || '';
  document.getElementById('target-saved').value = prefill.saved || '0';
  document.getElementById('target-deadline').value = prefill.deadline || '';
  openModal('modal-custom-target');
}

function openEditCustomTargetModal(id) {
  const g = getGoalsState();
  const t = (g.customTargets || []).find(x => x.id === id);
  if (!t) return;

  editingTargetId = id;
  document.getElementById('modal-custom-target-title').textContent = '✏️ Editar Alvo';
  document.getElementById('target-id').value = id;
  document.getElementById('target-title').value = t.title || '';
  document.getElementById('target-category').value = t.category || '🎯';
  document.getElementById('target-amount').value = t.amount || '';
  document.getElementById('target-saved').value = t.saved || '0';
  document.getElementById('target-deadline').value = t.deadline || '';
  openModal('modal-custom-target');
}

function handleSaveCustomTarget(e) {
  e.preventDefault();
  const title = document.getElementById('target-title')?.value.trim();
  const category = document.getElementById('target-category')?.value || '🎯';
  const amount = parseFloat(document.getElementById('target-amount')?.value) || 0;
  const saved = parseFloat(document.getElementById('target-saved')?.value) || 0;
  const deadline = document.getElementById('target-deadline')?.value || '';

  if (!title || amount <= 0) {
    showToast('Informe o nome e um valor válido para o alvo.', 'error');
    return;
  }

  const g = getGoalsState();
  if (!Array.isArray(g.customTargets)) g.customTargets = [];

  const item = {
    id: editingTargetId || ('ct-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)),
    title,
    category,
    amount,
    saved,
    deadline
  };

  if (editingTargetId) {
    const idx = g.customTargets.findIndex(x => x.id === editingTargetId);
    if (idx !== -1) g.customTargets[idx] = item;
  } else {
    g.customTargets.push(item);
  }

  saveEncryptedState();
  closeModal('modal-custom-target');
  renderGoalsView();
  showToast(editingTargetId ? 'Alvo atualizado!' : 'Novo alvo criado com sucesso!', 'success');
}

function deleteCustomTarget(id) {
  const g = getGoalsState();
  const item = (g.customTargets || []).find(x => x.id === id);
  if (!item) return;

  _undoData = { list: 'customTargets', item };
  g.customTargets = g.customTargets.filter(x => x.id !== id);
  saveEncryptedState();
  renderGoalsView();

  showToastWithUndo(`Alvo "${item.title}" removido`, () => {
    if (_undoData && _undoData.list === 'customTargets') {
      const g2 = getGoalsState();
      g2.customTargets.push(_undoData.item);
      _undoData = null;
      saveEncryptedState();
      renderGoalsView();
      showToast('Alvo restaurado!', 'success');
    }
  });
}


function scrollWidget(id, delta) {
  const el = document.getElementById(id);
  if (el) el.scrollBy({ left: delta, behavior: 'smooth' });
}

function renderAll() {
  renderSummary();
  renderPortfolio();
  renderWatchlist();
  renderFavoritosWidget();
  renderMonthlyGoalProgress();
  renderHeroGoalsBadge();
  if (currentTab === 'goals') renderGoalsView();
  if (currentTab === 'explorer') renderExplorerTable();
}

/* ═══════════════════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {
  initLoginScreen();
  enableScrollDrag('favoritos-scroll');

  // Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
});
