const playlistEl = document.getElementById('playlist');
const filePicker = document.getElementById('filePicker');
const togglePlayBtn = document.getElementById('togglePlay');
const prevTrackBtn = document.getElementById('prevTrack');
const nextTrackBtn = document.getElementById('nextTrack');
const shuffleToggleBtn = document.getElementById('shuffleToggle');
const nowPlayingEl = document.getElementById('nowPlaying');
const timeDisplayEl = document.getElementById('timeDisplay');
const clearPlaylistBtn = document.getElementById('clearPlaylist');
const playlistPicker = document.getElementById('playlistPicker');
const pageSizeSelect = document.getElementById('pageSizeSelect');
const sortSelect = document.getElementById('sortSelect');
const minRatingSelect = document.getElementById('minRatingSelect');
const newPlaylistBtn = document.getElementById('newPlaylist');
const renamePlaylistBtn = document.getElementById('renamePlaylist');
const deletePlaylistBtn = document.getElementById('deletePlaylist');
const fadeSlider = document.getElementById('fadeSlider');
const speedSlider = document.getElementById('speedSlider');
const speedDownBtn = document.getElementById('speedDown');
const speedUpBtn = document.getElementById('speedUp');
const speedValue = document.getElementById('speedValue');
const speedResetBtn = document.getElementById('speedReset');
const fadeValue = document.getElementById('fadeValue');
const installButton = document.getElementById('installButton');
const themeToggle = document.getElementById('themeToggle');
const timeModeToggle = document.getElementById('timeModeToggle');
const loopToggle = document.getElementById('loopToggle');
const dropboxStatusEl = document.getElementById('dropboxStatus');
const dropboxProgressEl = document.getElementById('dropboxProgress');
const dropboxProgressFillEl = document.getElementById('dropboxProgressFill');
const dropboxConnectBtn = document.getElementById('dropboxConnect');
const dropboxSyncBtn = document.getElementById('dropboxSync');
const dropboxDisconnectBtn = document.getElementById('dropboxDisconnect');
const dropboxSyncSelectedBtn = document.getElementById('dropboxSyncSelected');
const preferLocalSourceToggle = document.getElementById('preferLocalSource');
const normalizationToggle = document.getElementById('normToggle');
const autoSyncToggle = document.getElementById('dropboxAutoSync');
const cloudOptionsEl = document.querySelector('.cloud-options');
const pendingNoticeEl = document.getElementById('dropboxPendingNotice');
const pendingNoticeTextEl = document.getElementById('dropboxPendingText');
const pendingSyncNowBtn = document.getElementById('dropboxPendingSyncNow');
// Declarado para evitar ReferenceError en usos con optional chaining
const dropboxRetryFailedBtn = document.getElementById('dropboxRetryFailed');
const cloudSyncCard = document.querySelector('.cloud-sync');
const waveformCanvas = document.getElementById('waveformCanvas');
const waveformMessage = document.getElementById('waveformMessage');
const waveformContainer = document.querySelector('.waveform');
const coverArtImg = document.getElementById('coverArt');
const nowRatingEl = document.getElementById('nowRating');
const nowPlayingSectionEl = document.getElementById('nowPlayingSection');
const nowPlayingRowEl = document.querySelector('.now-playing-row');
const coverLightboxEl = document.getElementById('coverLightbox');
const coverLightboxImg = document.getElementById('coverLightboxImg');
const pagerEl = document.getElementById('playlistPager');
const pagerPrevBtn = document.getElementById('pagerPrev');
const pagerNextBtn = document.getElementById('pagerNext');
const pagerInfoEl = document.getElementById('pagerInfo');
const localUsageEl = document.getElementById('localUsage');
const dropboxUsageEl = document.getElementById('dropboxUsage');
const globalSearchInput = document.getElementById('globalSearch');
const searchResultsEl = document.getElementById('searchResults');
const clearLocalCopiesBtn = document.getElementById('clearLocalCopies');
const dropboxTestConnBtn = document.getElementById('dropboxTestConn');
const selectAllForSyncBtn = document.getElementById('selectAllForSync');
const clearSelectedForSyncBtn = document.getElementById('clearSelectedForSync');
const dropboxClearPendingBtn = document.getElementById('dropboxClearPending');
const dropboxForceDeleteBtn = document.getElementById('dropboxForceDelete');

// ========== Fetch con timeout y AbortController ==========
// Conserva el fetch original
const ORIG_FETCH = (typeof window !== 'undefined' && window.fetch) ? window.fetch.bind(window) : fetch;

function fetchWithTimeout(resource, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const { signal: userSignal, ...rest } = options || {};
  let timeoutId = null;
  try {
    timeoutId = setTimeout(() => {
      try { controller.abort(new DOMException('Timeout', 'AbortError')); } catch { controller.abort(); }
    }, Math.max(1, Number(timeoutMs) || 30000));
  } catch {}
  if (userSignal) {
    if (userSignal.aborted) {
      try { controller.abort(userSignal.reason); } catch { controller.abort(); }
    } else {
      try { userSignal.addEventListener('abort', () => { try { controller.abort(userSignal.reason); } catch { controller.abort(); } }, { once: true }); } catch {}
    }
  }
  return ORIG_FETCH(resource, { ...rest, signal: controller.signal }).finally(() => { try { clearTimeout(timeoutId); } catch {} });
}

// Envuelve window.fetch con timeouts heurísticos por endpoint
try {
  if (typeof window !== 'undefined' && window && typeof window.fetch === 'function') {
    window.fetch = (resource, options = {}) => {
      const url = (typeof resource === 'string') ? resource : (resource && resource.url) ? resource.url : '';
      let timeout = 30000; // por defecto
      try {
        if (/content\.dropboxapi\.com\/2\/files\/(upload|upload_session)/.test(url)) {
          timeout = 300000; // 5 min para subidas/chunks
        } else if (/content\.dropboxapi\.com\/2\/files\/download/.test(url)) {
          timeout = 120000; // 2 min para descargas
        } else if (/api\.dropboxapi\.com\//.test(url)) {
          timeout = 45000; // 45s para endpoints de API
        }
      } catch {}
      return fetchWithTimeout(resource, options, timeout);
    };
  }
} catch {}

const STORAGE_KEYS = {
  playlist: 'edumix-playlist',
  dropboxAuth: 'edumix-dropbox-auth',
  dropboxSession: 'edumix-dropbox-session',
  theme: 'edumix-theme',
  timeMode: 'edumix-time-mode', // 'elapsed' | 'remaining'
  dropboxPending: 'edumix-dropbox-pending-deletions',
  dropboxPerListMeta: 'edumix-dropbox-perlist-meta',
  viewPerList: 'edumix-view-per-list',
};

const dropboxConfig = {
  clientId: '118rcuago5bvt6j',
  // Legacy single-file path
  playlistPath: '/playlist.json',
  // New per-list layout
  playlistsDir: '/Playlists',
  settingsPath: '/Playlists/_settings.json',
  scopes: 'files.metadata.read files.content.read files.content.write',
};

dropboxConfig.redirectUri = `${window.location.origin}${window.location.pathname}`;

// ===== Control de concurrencia y backoff para lecturas Dropbox =====
let dropboxReadAvailableAt = 0;
let dropboxReadInFlight = 0;
const DROPBOX_READ_CONCURRENCY = 2;
const remoteLinkInFlight = new Map(); // track.id -> Promise<boolean>

const state = {
  playlists: [],
  activePlaylistId: null,
  tracks: [],
  currentIndex: -1,
  isPlaying: false,
  fadeDuration: Number(fadeSlider?.value ?? 3),
  autoLoop: Boolean(loopToggle?.checked),
  shuffle: false,
  preferLocalSource: true,
  playbackRate: 1,
  viewPageSize: 0,
  viewPageIndex: 0,
  viewSort: 'none',
  viewMinRating: 0,
  normalizationEnabled: true,
  autoSync: false,
};

let selectedForSync = new Set();

// Estado de reproducción aleatoria
let shuffleQueue = [];
let shuffleHistory = [];
let searchDebounce = null;

// Tema: claro/oscuro con persistencia
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'dark') {
    root.setAttribute('data-theme', 'dark');
  } else if (theme === 'light') {
    root.setAttribute('data-theme', 'light');
  } else {
    root.removeAttribute('data-theme');
  }
}

function getSystemPrefersDark() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function setThemeToggleUI(isDark) {
  if (!themeToggle) return;
  themeToggle.setAttribute('aria-pressed', String(isDark));
  themeToggle.textContent = isDark ? '🌙' : '🌞';
  themeToggle.title = isDark ? 'Tema oscuro' : 'Tema claro';
}

function initThemeFromStorage() {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.theme);
    const theme = (saved === 'dark' || saved === 'light') ? saved : null;
    applyTheme(theme);
    const effectiveDark = theme ? theme === 'dark' : getSystemPrefersDark();
    setThemeToggleUI(effectiveDark);
  } catch {}
}

initThemeFromStorage();

themeToggle?.addEventListener('click', () => {
  const isDark = themeToggle.getAttribute('aria-pressed') === 'true';
  const next = isDark ? 'light' : 'dark';
  applyTheme(next);
  setThemeToggleUI(!isDark);
  try { localStorage.setItem(STORAGE_KEYS.theme, next); } catch {}
});

// Tiempo transcurrido / restante
function setTimeModeToggleUI(mode) {
  if (!timeModeToggle) return;
  const isRemaining = mode === 'remaining';
  timeModeToggle.setAttribute('aria-pressed', String(isRemaining));
  timeModeToggle.textContent = isRemaining ? '⏳' : '⏱️';
  timeModeToggle.title = isRemaining ? 'Mostrar tiempo transcurrido' : 'Mostrar tiempo restante';
}

function applyInitialTimeMode() {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.timeMode);
    const mode = (saved === 'remaining' || saved === 'elapsed') ? saved : 'elapsed';
    setTimeModeToggleUI(mode);
  } catch {}
}

function getSelectedTimeMode() {
  return timeModeToggle?.getAttribute('aria-pressed') === 'true' ? 'remaining' : 'elapsed';
}

function resetTimeDisplayForTrack(track) {
  if (!timeDisplayEl) return;
  const mode = getSelectedTimeMode();
  if (mode === 'remaining') {
    if (Number.isFinite(track?.duration)) {
      timeDisplayEl.textContent = `-${formatDuration(track.duration)}`;
    } else {
      timeDisplayEl.textContent = '—:—';
    }
  } else {
    timeDisplayEl.textContent = '0:00';
  }
}

function updateTimeDisplay(player) {
  if (!timeDisplayEl) return;
  const track = state.tracks[state.currentIndex];
  if (!track || player.trackId !== track.id) {
    return;
  }
  const { currentTime, duration } = player.audio;
  if (!Number.isFinite(duration) || duration <= 0) {
    timeDisplayEl.textContent = '—:—';
    return;
  }
  const mode = getSelectedTimeMode();
  if (mode === 'remaining') {
    const remaining = Math.max(0, duration - currentTime);
    timeDisplayEl.textContent = `-${formatDuration(remaining)}`;
  } else {
    const elapsed = Math.max(0, currentTime);
    timeDisplayEl.textContent = `${formatDuration(elapsed)}`;
  }
  // Actualiza Media Session con la posición actual
  updateMediaSessionPosition(player);
}

applyInitialTimeMode();
timeModeToggle?.addEventListener('click', () => {
  const current = getSelectedTimeMode();
  const next = current === 'remaining' ? 'elapsed' : 'remaining';
  setTimeModeToggleUI(next);
  try { localStorage.setItem(STORAGE_KEYS.timeMode, next); } catch {}
  // Reestablece visualización acorde al modo actual
  const track = state.tracks[state.currentIndex];
  if (track) {
    resetTimeDisplayForTrack(track);
  } else if (timeDisplayEl) {
    timeDisplayEl.textContent = '—:—';
  }
});

function invalidateShuffle() {
  shuffleQueue = [];
  shuffleHistory = [];
}

let audioContext = null;
const players = [];
let activePlayerIndex = 0;
let dragIndex = null;
let deferredPrompt = null;

const pendingUploads = new Map();
let pendingDeletions = new Set();

let dropboxAuth = loadDropboxAuth();
const dropboxState = {
  isSyncing: false,
  syncQueued: null,
  lastSync: null,
  error: null,
};
dropboxState.netStrikes = 0;
dropboxState.pausedUntil = 0;
dropboxState.progressTotal = 0;
dropboxState.progressDone = 0;
// Metadatos de playlist.json en Dropbox (control de versión)
// Metadatos del fichero único (legacy)
let dropboxPlaylistMeta = { rev: null, serverModified: null };
// Metadatos por lista en modo per-list (id -> { path, rev, serverModified })
let dropboxPerListMeta = {};
// Metadatos del fichero de ajustes en modo per-list
let dropboxSettingsMeta = { rev: null, serverModified: null };
// Ventana global para evitar saturar el límite de escrituras de Dropbox
let dropboxWriteAvailableAt = 0;

// Preferencias de vista por lista (id -> { pageSize, pageIndex, sort, minRating })
let viewPerList = {};

const waveformState = {
  trackId: null,
  peaks: null,
  duration: 0,
  progress: 0,
};
const waveformCache = new Map();
let waveformResizeFrame = null;
// Prefetch de siguiente pista remota
let lastPrefetchForTrackId = null;
let storageStatsTimer = null;
let mediaSessionSetup = false;

const CROSS_FADE_MIN = 0.2;
const TOKEN_REFRESH_MARGIN = 90 * 1000;
const TEMP_LINK_MARGIN = 60 * 1000;
const WAVEFORM_SAMPLES = 800;
const IDB_CONFIG = {
  name: 'edumix-media',
  version: 1,
  store: 'tracks',
};
// Límite conservador por registro para evitar errores de tamaño en IndexedDB
const IDB_MAX_VALUE_BYTES = 250 * 1024 * 1024; // ~250 MB
let mediaDbPromise = null;

function generateId(prefix) {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const seed = Math.random().toString(16).slice(2);
  return `${prefix || 'id'}-${Date.now()}-${seed}`;
}

function createPlaylistObject(name, tracks = []) {
  return {
    id: generateId('pl'),
    name: name || 'Lista',
    tracks,
    updatedAt: Date.now(),
  };
}

function getActivePlaylist() {
  return state.playlists.find(playlist => playlist.id === state.activePlaylistId) || null;
}

function syncTracksFromActivePlaylist() {
  const active = getActivePlaylist();
  state.tracks = active ? active.tracks : [];
  // Invalida cola/historial de aleatorio al cambiar de lista
  shuffleQueue = [];
  shuffleHistory = [];
}

function ensurePlaylistsInitialized() {
  if (!state.playlists.length) {
    state.playlists.push(createPlaylistObject('Lista 1'));
  }
  if (!state.activePlaylistId || !state.playlists.some(pl => pl.id === state.activePlaylistId)) {
    state.activePlaylistId = state.playlists[0].id;
  }
  syncTracksFromActivePlaylist();
  renderPlaylistPicker();
}

function loadActiveViewPrefs() {
  try {
    const id = state.activePlaylistId;
    if (!id) return;
    const vp = viewPerList && typeof viewPerList === 'object' ? viewPerList[id] : null;
    if (vp && typeof vp === 'object') {
      if (Number.isFinite(vp.pageSize)) state.viewPageSize = Math.max(0, Number(vp.pageSize));
      if (Number.isFinite(vp.pageIndex)) state.viewPageIndex = Math.max(0, Number(vp.pageIndex));
      if (typeof vp.sort === 'string') state.viewSort = vp.sort;
      if (Number.isFinite(vp.minRating)) state.viewMinRating = Math.max(0, Math.min(5, Number(vp.minRating)));
    }
  } catch {}
}

function renderPlaylistPicker() {
  if (!playlistPicker) {
    return;
  }
  const previous = playlistPicker.value;
  playlistPicker.innerHTML = '';
  state.playlists.forEach(playlist => {
    const option = document.createElement('option');
    option.value = playlist.id;
    option.textContent = playlist.name;
    playlistPicker.append(option);
  });
  const targetValue = state.activePlaylistId || previous || (state.playlists[0] && state.playlists[0].id) || '';
  playlistPicker.value = targetValue;
  playlistPicker.disabled = state.playlists.length <= 1;
  // Al actualizar el selector, intenta aplicar la vista específica de esa lista
  try { loadActiveViewPrefs(); } catch {}
  if (pageSizeSelect) {
    pageSizeSelect.value = String(state.viewPageSize || 0);
  }
  if (sortSelect) {
    sortSelect.value = state.viewSort || 'none';
  }
  if (minRatingSelect) {
    minRatingSelect.value = String(state.viewMinRating || 0);
  }
}

function buildShuffledIndices(excludeIndex = -1) {
  const indices = state.tracks.map((_, i) => i).filter(i => i !== excludeIndex);
  for (let i = indices.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices;
}

function ensureShuffleQueue() {
  if (!state.shuffle) return;
  const valid = shuffleQueue.every(i => i >= 0 && i < state.tracks.length);
  if (!valid || shuffleQueue.length === 0) {
    shuffleQueue = buildShuffledIndices(state.currentIndex);
  }
}

function getStartIndex() {
  if (!state.shuffle) return 0;
  if (state.tracks.length <= 1) return 0;
  const candidates = buildShuffledIndices(-1);
  return candidates[0] ?? 0;
}

function getNextIndex() {
  if (state.autoLoop && state.currentIndex !== -1) {
    return state.currentIndex;
  }
  if (!state.shuffle) {
    const next = state.currentIndex + 1;
    return next < state.tracks.length ? next : -1;
  }
  ensureShuffleQueue();
  const next = shuffleQueue.shift();
  if (typeof next === 'number') {
    if (state.currentIndex !== -1) {
      shuffleHistory.push(state.currentIndex);
    }
    return next;
  }
  // Si no hay siguiente y hay más de una pista, reconstruir excluyendo la actual
  if (state.tracks.length > 1) {
    shuffleQueue = buildShuffledIndices(state.currentIndex);
    const n = shuffleQueue.shift();
    if (typeof n === 'number') {
      if (state.currentIndex !== -1) {
        shuffleHistory.push(state.currentIndex);
      }
      return n;
    }
  }
  return -1;
}

function getPrevIndex() {
  if (!state.shuffle) {
    const prev = state.currentIndex - 1;
    return prev >= 0 ? prev : -1;
  }
  const prev = shuffleHistory.pop();
  return typeof prev === 'number' ? prev : -1;
}

function setActivePlaylist(id) {
  if (!id || state.activePlaylistId === id) {
    if (!state.activePlaylistId) {
      ensurePlaylistsInitialized();
    }
    return;
  }
  const target = state.playlists.find(playlist => playlist.id === id);
  if (!target) {
    return;
  }
  stopPlayback();
  state.activePlaylistId = id;
  syncTracksFromActivePlaylist();
  // Cargar preferencias específicas de esta lista
  loadActiveViewPrefs();
  state.currentIndex = -1;
  renderPlaylist();
  updateControls();
  updateNowPlaying();
  renderPlaylistPicker();
  persistLocalPlaylist();
  requestDropboxSync();
  scheduleStorageStatsUpdate();
}

function createPlaylist(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) {
    return;
  }
  const playlist = createPlaylistObject(trimmed, []);
  state.playlists.push(playlist);
  stopPlayback();
  state.activePlaylistId = playlist.id;
  syncTracksFromActivePlaylist();
  state.currentIndex = -1;
  playlist.updatedAt = Date.now();
  renderPlaylistPicker();
  renderPlaylist();
  updateControls();
  updateNowPlaying();
  persistLocalPlaylist();
  requestDropboxSync();
}

function renameActivePlaylist() {
  const active = getActivePlaylist();
  if (!active) return;
  const proposed = prompt('Nuevo nombre de la lista', active.name || '');
  if (proposed === null) return;
  const nextName = proposed.trim();
  if (!nextName || nextName === active.name) return;
  active.name = nextName;
  active.updatedAt = Date.now();
  renderPlaylistPicker();
  persistLocalPlaylist();
  // Forzar rename inmediato en Dropbox (aunque autoSync esté desactivado)
  if (isDropboxConnected()) {
    performDropboxSync({ loadRemote: false }).catch(console.error);
  } else {
    requestDropboxSync();
  }
}

function deleteActivePlaylist() {
  const active = getActivePlaylist();
  if (!active) return;
  const confirmed = window.confirm(`¿Eliminar la lista "${active.name}"? Se eliminarán sus pistas de esta sesión.`);
  if (!confirmed) return;
  // Preparar eliminaciones de Dropbox y limpiar blobs/IDB
  const removeRemotePaths = (active.tracks || [])
    .map(track => track.dropboxPath)
    .filter(Boolean);
  removeRemotePaths.forEach(path => pendingDeletions.add(path));
  (active.tracks || []).forEach(track => {
    if (!track.isRemote && track.url) {
      try { URL.revokeObjectURL(track.url); } catch {}
    }
    pendingUploads.delete(track.id);
    waveformCache.delete(track.id);
    deleteTrackFile(track.id).catch(console.error);
  });

  // Eliminar la playlist del estado
  state.playlists = state.playlists.filter(p => p.id !== active.id);
  // Asegurar que exista al menos una lista
  if (!state.playlists.length) {
    const fallback = createPlaylistObject('Lista 1', []);
    state.playlists.push(fallback);
  }
  // Activar la primera disponible
  state.activePlaylistId = state.playlists[0].id;
  stopPlayback();
  syncTracksFromActivePlaylist();
  state.currentIndex = -1;
  renderPlaylistPicker();
  renderPlaylist();
  updateControls();
  updateNowPlaying();
  persistLocalPlaylist();
  requestDropboxSync();
}

function getAllTracks() {
  return state.playlists.flatMap(playlist => playlist.tracks);
}

function serializeTrack(track) {
  return {
    id: track.id,
    name: track.name,
    userRenamed: !!track.userRenamed,
    fileName: track.fileName,
    duration: track.duration,
    updatedAt: track.updatedAt ?? null,
    rating: Number.isFinite(track.rating) ? track.rating : 0,
    normalizationGain: Number.isFinite(track.normalizationGain) ? track.normalizationGain : null,
    size: track.size ?? null,
    lastModified: track.lastModified ?? null,
    dropboxPath: track.dropboxPath ?? null,
    dropboxRev: track.dropboxRev ?? null,
    dropboxSize: track.dropboxSize ?? null,
    dropboxUpdatedAt: track.dropboxUpdatedAt ?? null,
    waveform: track.waveform ?? null,
  };
}

// Local storage serializer (omit heavy fields like waveform to avoid quota issues)
function serializeTrackLocal(track) {
  return {
    id: track.id,
    name: track.name,
    userRenamed: !!track.userRenamed,
    fileName: track.fileName,
    duration: track.duration,
    updatedAt: track.updatedAt ?? null,
    rating: Number.isFinite(track.rating) ? track.rating : 0,
    normalizationGain: Number.isFinite(track.normalizationGain) ? track.normalizationGain : null,
    size: track.size ?? null,
    lastModified: track.lastModified ?? null,
    dropboxPath: track.dropboxPath ?? null,
    dropboxRev: track.dropboxRev ?? null,
    dropboxSize: track.dropboxSize ?? null,
    dropboxUpdatedAt: track.dropboxUpdatedAt ?? null,
    // waveform intentionally omitted
  };
}

function deserializeTrack(entry) {
  return {
    id: entry.id,
    name: entry.name,
    userRenamed: !!entry.userRenamed,
    fileName: entry.fileName ?? entry.name,
    url: null,
    duration: entry.duration ?? null,
    updatedAt: entry.updatedAt ?? null,
    rating: Number.isFinite(entry.rating) ? entry.rating : 0,
    normalizationGain: Number.isFinite(entry.normalizationGain) ? entry.normalizationGain : null,
    size: entry.size ?? null,
    lastModified: entry.lastModified ?? null,
    dropboxPath: entry.dropboxPath ?? null,
    dropboxRev: entry.dropboxRev ?? null,
    dropboxSize: entry.dropboxSize ?? null,
    dropboxUpdatedAt: entry.dropboxUpdatedAt ?? null,
    waveform: entry.waveform ?? null,
    urlExpiresAt: 0,
    isRemote: Boolean(entry.dropboxPath),
  };
}

function openMediaDatabase() {
  if (!('indexedDB' in window)) {
    return Promise.resolve(null);
  }
  if (mediaDbPromise) {
    return mediaDbPromise;
  }
  mediaDbPromise = new Promise((resolve) => {
    // Intento 1: abrir sin especificar versión para evitar VersionError si la DB es más nueva
    const tryOpenNoVersion = () => {
      let req;
      try { req = indexedDB.open(IDB_CONFIG.name); } catch (e) { tryOpenWithVersion(IDB_CONFIG.version); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        try {
          if (!db.objectStoreNames.contains(IDB_CONFIG.store)) {
            db.createObjectStore(IDB_CONFIG.store, { keyPath: 'id' });
          }
        } catch {}
      };
      req.onsuccess = () => {
        const db = req.result;
        try {
          if (!db.objectStoreNames.contains(IDB_CONFIG.store)) {
            // Necesitamos crear el store: subir versión al menos en +1
            const targetVersion = Math.max(IDB_CONFIG.version || 1, (db.version || 1) + 1);
            try { db.close(); } catch {}
            const req2 = indexedDB.open(IDB_CONFIG.name, targetVersion);
            req2.onupgradeneeded = () => {
              const db2 = req2.result;
              try {
                if (!db2.objectStoreNames.contains(IDB_CONFIG.store)) {
                  db2.createObjectStore(IDB_CONFIG.store, { keyPath: 'id' });
                }
              } catch {}
            };
            req2.onsuccess = () => resolve(req2.result);
            req2.onerror = () => resolve(null);
          } else {
            resolve(db);
          }
        } catch {
          resolve(db);
        }
      };
      req.onerror = () => {
        tryOpenWithVersion(IDB_CONFIG.version);
      };
    };
    // Intento 2: abrir con versión solicitada (para DBs viejas o inexistentes)
    const tryOpenWithVersion = (version) => {
      let req;
      try { req = indexedDB.open(IDB_CONFIG.name, version); } catch (e) { resolve(null); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        try {
          if (!db.objectStoreNames.contains(IDB_CONFIG.store)) {
            db.createObjectStore(IDB_CONFIG.store, { keyPath: 'id' });
          }
        } catch {}
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    };
    tryOpenNoVersion();
  }).catch(error => {
    console.error('IndexedDB init error', error);
    mediaDbPromise = null;
    return null;
  });
  return mediaDbPromise;
}

async function storeTrackFile(id, file) {
  const db = await openMediaDatabase();
  if (!db) {
    return;
  }
  const size = Number(file?.size || 0);
  if (size > IDB_MAX_VALUE_BYTES) {
    console.warn('Archivo demasiado grande para IndexedDB; se omite almacenamiento local', { id, size });
    return;
  }
  const buffer = await file.arrayBuffer();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_CONFIG.store, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('No se pudo guardar el audio local'));
    const record = {
      id,
      buffer,
      type: file.type || 'audio/mpeg',
      size: file.size || buffer.byteLength,
      lastModified: file.lastModified || Date.now(),
      name: file.name || id,
    };
    tx.objectStore(IDB_CONFIG.store).put(record);
  }).catch(error => {
    console.error('Error guardando audio local', error);
  });
}

async function loadTrackFile(id) {
  const db = await openMediaDatabase();
  if (!db) {
    return null;
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_CONFIG.store, 'readonly');
    const request = tx.objectStore(IDB_CONFIG.store).get(id);
    request.onsuccess = () => {
      resolve(request.result || null);
    };
    request.onerror = () => {
      reject(request.error);
    };
  }).catch(error => {
    console.error('Error leyendo audio local', error);
    return null;
  });
}

async function deleteTrackFile(id) {
  const db = await openMediaDatabase();
  if (!db) {
    return;
  }
  await new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_CONFIG.store, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(IDB_CONFIG.store).delete(id);
  }).catch(error => {
    console.error('Error eliminando audio local', error);
  });
}

async function ensureLocalTrackUrl(track) {
  if (track.url && track.url.startsWith('blob:')) {
    return true;
  }
  const file = pendingUploads.get(track.id);
  if (file) {
    if (!track.url || track.url === 'null') {
      if (track.url) {
        try {
          URL.revokeObjectURL(track.url);
        } catch (error) {
          console.warn('No se pudo liberar la URL anterior', error);
        }
      }
      track.url = URL.createObjectURL(file);
    }
    track.isRemote = false;
    return true;
  }
  const stored = await loadTrackFile(track.id);
  if (!stored) {
    return false;
  }
  try {
    if (track.url) {
      URL.revokeObjectURL(track.url);
    }
  } catch (error) {
    console.warn('No se pudo liberar URL antigua', error);
  }
  const blob = new Blob([stored.buffer], { type: stored.type || 'audio/mpeg' });
  track.url = URL.createObjectURL(blob);
  track.size = stored.size ?? blob.size;
  track.lastModified = stored.lastModified ?? track.lastModified;
  track.fileName = track.fileName || stored.name || `${track.id}.mp3`;
  track.isRemote = false;
  track.urlExpiresAt = 0;
  return true;
}

async function restoreLocalMedia() {
  const tracks = getAllTracks();
  if (!tracks.length) {
    return;
  }
  const tasks = tracks.map(async track => {
    if (track.dropboxPath) {
      track.isRemote = true;
      return;
    }
    track.isRemote = false;
    if (track.url && track.url.startsWith('blob:')) {
      return;
    }
    const stored = await loadTrackFile(track.id);
    if (!stored) {
      return;
    }
    const blob = new Blob([stored.buffer], { type: stored.type || 'audio/mpeg' });
    if (track.url && track.url.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(track.url);
      } catch (error) {
        console.warn('No se pudo liberar URL previa', error);
      }
    }
    track.url = URL.createObjectURL(blob);
    track.size = stored.size ?? blob.size;
    track.fileName = track.fileName || stored.name || `${track.id}.mp3`;
    track.lastModified = stored.lastModified ?? track.lastModified;
    track.urlExpiresAt = 0;
  });
  await Promise.allSettled(tasks);
}

function handleWaveformMetadata(player) {
  if (!player.trackId) {
    return;
  }
  const track = state.tracks.find(item => item.id === player.trackId);
  if (!track) {
    return;
  }
  const duration = player.audio.duration;
  if (!Number.isFinite(duration) || duration <= 0) {
    return;
  }
  if (!Number.isFinite(track.duration) || Math.abs(track.duration - duration) > 0.5) {
    track.duration = duration;
    if (waveformState.trackId === track.id) {
      waveformState.duration = duration;
    }
    persistLocalPlaylist();
  }
}

function handleWaveformProgress(player) {
  if (!waveformCanvas || waveformState.trackId !== player.trackId) {
    return;
  }
  const duration = waveformState.duration || player.audio.duration;
  if (!Number.isFinite(duration) || duration <= 0) {
    return;
  }
  const progress = Math.min(1, Math.max(0, player.audio.currentTime / duration));
  if (Math.abs(progress - waveformState.progress) >= 0.003) {
    waveformState.progress = progress;
    if (waveformState.peaks && waveformState.peaks.length) {
      drawWaveform(waveformState.peaks, waveformState.progress);
    }
  }
  // Prefetch del siguiente cuando llega al 50% de la pista
  if (player.trackId && lastPrefetchForTrackId !== player.trackId && progress >= 0.5) {
    lastPrefetchForTrackId = player.trackId;
    maybePrefetchNext();
  }
}

function prepareWaveformCanvas() {
  if (!waveformCanvas) {
    return { ctx: null, width: 0, height: 0, dpr: window.devicePixelRatio || 1 };
  }
  const dpr = window.devicePixelRatio || 1;
  const displayWidth = Math.max(1, Math.floor(waveformCanvas.clientWidth || waveformCanvas.offsetWidth || 0));
  const displayHeight = Math.max(1, Math.floor(waveformCanvas.clientHeight || 0));
  if (!displayWidth || !displayHeight) {
    return { ctx: null, width: displayWidth, height: displayHeight, dpr };
  }
  const targetWidth = Math.floor(displayWidth * dpr);
  const targetHeight = Math.floor(displayHeight * dpr);
  if (waveformCanvas.width !== targetWidth || waveformCanvas.height !== targetHeight) {
    waveformCanvas.width = targetWidth;
    waveformCanvas.height = targetHeight;
  }
  const ctx = waveformCanvas.getContext('2d');
  if (!ctx) {
    return { ctx: null, width: displayWidth, height: displayHeight, dpr };
  }
  if (typeof ctx.resetTransform === 'function') {
    ctx.resetTransform();
  } else {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  ctx.scale(dpr, dpr);
  return { ctx, width: displayWidth, height: displayHeight, dpr };
}

function drawWaveform(peaks, progress = 0) {
  const data = prepareWaveformCanvas();
  const { ctx, width, height } = data;
  if (!ctx || !width || !height) {
    return;
  }
  ctx.clearRect(0, 0, width, height);
  if (!peaks || !peaks.length) {
    waveformContainer?.classList.remove('has-data');
    return;
  }
  waveformContainer?.classList.add('has-data');
  const mid = height / 2;
  const ratio = peaks.length / width;
  const strokeColor = 'rgba(74, 144, 226, 0.65)';
  const baseFill = 'rgba(74, 144, 226, 0.25)';
  const activeFill = 'rgba(74, 144, 226, 0.6)';

  const drawShape = (fillColor, withStroke) => {
    ctx.beginPath();
    for (let x = 0; x < width; x += 1) {
      const peakIndex = Math.min(peaks.length - 1, Math.floor(x * ratio));
      const peak = peaks[peakIndex] || [0, 0];
      const y = mid - (peak[1] ?? 0) * mid;
      if (x === 0) {
        ctx.moveTo(0, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    for (let x = width - 1; x >= 0; x -= 1) {
      const peakIndex = Math.min(peaks.length - 1, Math.floor(x * ratio));
      const peak = peaks[peakIndex] || [0, 0];
      const y = mid - (peak[0] ?? 0) * mid;
      ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();
    if (withStroke) {
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = Math.max(1, height / 160);
      ctx.stroke();
    }
  };

  drawShape(baseFill, true);
  if (progress > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, Math.max(0, Math.min(width * progress, width)), height);
    ctx.clip();
    drawShape(activeFill, false);
    ctx.restore();
  }
}

function handleWaveformClick(ev) {
  try {
    if (!waveformCanvas) return;
    if (state.currentIndex === -1) return;
    const p = players[activePlayerIndex];
    if (!p || !p.audio) return;
    const duration = Number.isFinite(p.audio.duration) ? p.audio.duration : 0;
    if (!duration) return;
    const rect = waveformCanvas.getBoundingClientRect();
    const clientX = (ev && typeof ev.clientX === 'number') ? ev.clientX : (ev.touches && ev.touches[0] ? ev.touches[0].clientX : null);
    if (clientX == null) return;
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
    const ratio = rect.width ? (x / rect.width) : 0;
    const target = Math.max(0, Math.min(duration - 0.05, ratio * duration));
    p.audio.currentTime = target;
    waveformState.progress = Math.max(0, Math.min(1, ratio));
    if (waveformState.peaks && waveformState.peaks.length) {
      drawWaveform(waveformState.peaks, waveformState.progress);
    }
    updateTimeDisplay(p);
    updateMediaSessionPosition(p);
  } catch (e) {
    console.warn('seek via waveform failed', e);
  }
}

function peekNextIndex() {
  if (state.autoLoop && state.currentIndex !== -1) {
    return state.currentIndex;
  }
  if (!state.shuffle) {
    const next = state.currentIndex + 1;
    return next < state.tracks.length ? next : -1;
  }
  // Aleatorio: miramos sin consumir la cola
  ensureShuffleQueue();
  if (shuffleQueue && shuffleQueue.length) {
    return shuffleQueue[0];
  }
  // Si la cola está vacía, simulamos sin consumir
  const simulated = buildShuffledIndices(state.currentIndex);
  return simulated[0] ?? -1;
}

function maybePrefetchNext() {
  try {
    const nextIdx = peekNextIndex();
    if (nextIdx === -1) return;
    const next = state.tracks[nextIdx];
    if (!next || !next.dropboxPath) return;
    if (next.url && next.url.startsWith('blob:')) return;
    if (next._prefetching || next._prefetched) return;
    next._prefetching = true;
    ensureTrackRemoteLink(next)
      .then(ok => { next._prefetched = !!ok; })
      .catch(() => { /* noop */ })
      .finally(() => { next._prefetching = false; });
  } catch (e) {
    // evitar que errores rompan el timeupdate
  }
}

function setWaveformTrack(track) {
  if (!waveformCanvas || !waveformContainer) {
    return;
  }
  if (!track) {
    waveformState.trackId = null;
    waveformState.peaks = null;
    waveformState.duration = 0;
    waveformState.progress = 0;
    waveformContainer.classList.remove('is-loading');
    waveformContainer.classList.remove('has-data');
    if (waveformMessage) {
      waveformMessage.textContent = 'Selecciona una pista para visualizar su forma de onda.';
    }
    drawWaveform(null, 0);
    return;
  }
  waveformState.trackId = track.id;
  waveformState.duration = track.duration ?? waveformState.duration ?? 0;
  waveformState.progress = 0;
  if (track.waveform?.peaks?.length) {
    waveformState.peaks = track.waveform.peaks;
    waveformState.duration = track.waveform.duration ?? waveformState.duration;
    waveformContainer.classList.remove('is-loading');
    drawWaveform(waveformState.peaks, waveformState.progress);
  } else {
    waveformState.peaks = null;
    // Ya no se difiere la descarga de forma de onda por política de reproducción
    waveformContainer.classList.add('is-loading');
    if (waveformMessage) {
      waveformMessage.textContent = 'Generando forma de onda…';
    }
    drawWaveform(null, 0);
    ensureWaveform(track)
      .then(result => {
        if (!result || waveformState.trackId !== track.id) {
          return;
        }
        waveformState.peaks = result.peaks;
        waveformState.duration = result.duration ?? waveformState.duration;
        waveformContainer.classList.remove('is-loading');
        drawWaveform(waveformState.peaks, waveformState.progress);
      })
      .catch(error => {
        console.error('Error generando forma de onda', error);
        if (waveformState.trackId === track.id) {
          waveformContainer.classList.remove('is-loading');
          waveformContainer.classList.remove('has-data');
          if (waveformMessage) {
            waveformMessage.textContent = 'No se pudo generar la forma de onda.';
          }
        }
      });
  }
}

function scheduleWaveformResize() {
  if (!waveformCanvas) {
    return;
  }
  if (waveformResizeFrame) {
    cancelAnimationFrame(waveformResizeFrame);
  }
  waveformResizeFrame = requestAnimationFrame(() => {
    waveformResizeFrame = null;
    if (waveformState.peaks && waveformState.peaks.length) {
      drawWaveform(waveformState.peaks, waveformState.progress);
    } else {
      drawWaveform(null, 0);
    }
  });
}

async function ensureWaveform(track) {
  if (!track) {
    return null;
  }
  if (track.waveform?.peaks?.length) {
    return track.waveform;
  }
  if (waveformCache.has(track.id)) {
    return waveformCache.get(track.id);
  }
  const promise = (async () => {
    let arrayBuffer = null;
    const file = pendingUploads.get(track.id);
    if (file) {
      arrayBuffer = await file.arrayBuffer();
    } else {
      const stored = await loadTrackFile(track.id);
      if (stored) {
        arrayBuffer = stored.buffer;
      } else if (track.isRemote || track.dropboxPath) {
        const ready = await ensureTrackRemoteLink(track);
        if (!ready) {
          return null;
        }
        const response = await fetch(track.url, { mode: 'cors' });
        if (!response.ok) {
          throw new Error('No se pudo descargar la pista para la forma de onda');
        }
        arrayBuffer = await response.arrayBuffer();
      } else if (track.url && track.url.startsWith('blob:')) {
        try {
          const response = await fetch(track.url);
          if (response.ok) {
            arrayBuffer = await response.arrayBuffer();
          }
        } catch (error) {
          console.warn('No se pudo leer el blob local para la forma de onda', error);
        }
      }
    }
    if (!arrayBuffer) {
      return null;
    }
    const waveform = await computeWaveformFromArrayBuffer(arrayBuffer);
    track.waveform = waveform;
    // Calcular ganancia de normalización basada en picos
    if (Array.isArray(waveform.peaks) && waveform.peaks.length) {
      track.normalizationGain = computeNormalizationFromPeaks(waveform.peaks);
    }
    if ((!Number.isFinite(track.duration) || track.duration === null) && Number.isFinite(waveform.duration)) {
      track.duration = waveform.duration;
    }
    persistLocalPlaylist();
    requestDropboxSync();
    return waveform;
  })()
    .catch(error => {
      console.error('Error generando forma de onda', error);
      waveformCache.delete(track.id);
      return null;
    });
  waveformCache.set(track.id, promise);
  return promise;
}

async function computeWaveformFromArrayBuffer(arrayBuffer) {
  const buffer = await new Promise((resolve, reject) => {
    const copy = arrayBuffer.slice(0);
    getAudioContext().decodeAudioData(copy, resolve, reject);
  });
  const peaks = extractPeaks(buffer, WAVEFORM_SAMPLES);
  return {
    peaks,
    duration: buffer.duration,
  };
}

function extractPeaks(buffer, buckets) {
  const channelCount = buffer.numberOfChannels;
  const channelData = [];
  for (let channel = 0; channel < channelCount; channel += 1) {
    channelData.push(buffer.getChannelData(channel));
  }
  const totalSamples = buffer.length;
  const bucketSize = Math.max(1, Math.floor(totalSamples / buckets));
  const peaks = [];
  for (let bucketIndex = 0; bucketIndex < buckets; bucketIndex += 1) {
    const start = bucketIndex * bucketSize;
    if (start >= totalSamples) {
      break;
    }
    const end = Math.min(start + bucketSize, totalSamples);
    let min = Infinity;
    let max = -Infinity;
    for (let channel = 0; channel < channelData.length; channel += 1) {
      const data = channelData[channel];
      for (let i = start; i < end; i += 1) {
        const sample = data[i];
        if (sample < min) {
          min = sample;
        }
        if (sample > max) {
          max = sample;
        }
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      peaks.push([0, 0]);
    } else {
      peaks.push([Number(min.toFixed(3)), Number(max.toFixed(3))]);
    }
  }
  return peaks;
}


function createPlayer() {
  const audio = new Audio();
  audio.preload = 'auto';
  audio.crossOrigin = 'anonymous';
  // Velocidad y tono
  try {
    audio.playbackRate = Number(state.playbackRate) || 1;
    if ('preservesPitch' in audio) audio.preservesPitch = true;
    if ('mozPreservesPitch' in audio) audio.mozPreservesPitch = true;
    if ('webkitPreservesPitch' in audio) audio.webkitPreservesPitch = true;
  } catch {}
  const ctx = getAudioContext();
  const source = ctx.createMediaElementSource(audio);
  const gain = ctx.createGain();
  gain.gain.value = 0;
  const compressor = ctx.createDynamicsCompressor();
  try {
    compressor.threshold.value = -6;
    compressor.knee.value = 4;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.01;
    compressor.release.value = 0.25;
  } catch {}
  source.connect(gain);
  gain.connect(compressor);
  compressor.connect(ctx.destination);
  const player = { audio, gain, compressor, stopTimeout: null, advanceHandler: null, trackId: null };
  audio.addEventListener('timeupdate', () => { handleWaveformProgress(player); updateTimeDisplay(player); });
  audio.addEventListener('loadedmetadata', () => handleWaveformMetadata(player));
  return player;
}

function ensurePlayers() {
  if (players.length >= 2) return;
  players.push(createPlayer(), createPlayer());
}

function cancelAutoAdvance(player) {
  if (player.advanceHandler) {
    player.audio.removeEventListener('timeupdate', player.advanceHandler);
    player.advanceHandler = null;
  }
}

function scheduleAutoAdvance(player, index) {
  cancelAutoAdvance(player);
  const handler = () => {
    if (state.currentIndex !== index || !state.isPlaying) {
      cancelAutoAdvance(player);
      return;
    }
    const { audio } = player;
    if (!Number.isFinite(audio.duration) || audio.duration === Infinity) {
      return;
    }
    if (audio.currentTime < 0.2) {
      return;
    }
    const baseFade = Math.max(Number.isFinite(state.fadeDuration) ? state.fadeDuration : CROSS_FADE_MIN, CROSS_FADE_MIN);
    const maxWindow = Math.max(audio.duration * 0.6, CROSS_FADE_MIN);
    const fadeWindow = Math.min(baseFade, maxWindow);
    const remaining = audio.duration - audio.currentTime;
    if (remaining <= fadeWindow + 0.05) {
      cancelAutoAdvance(player);
      if (state.autoLoop && state.tracks[index]) {
        playTrack(index, { fadeDurationOverride: fadeWindow }).catch(console.error);
      } else {
        const nextIndex = getNextIndex();
        if (nextIndex !== -1) {
          playTrack(nextIndex, { fadeDurationOverride: fadeWindow }).catch(console.error);
        } else {
          stopPlayback();
        }
      }
    }
  };
  player.advanceHandler = handler;
  player.audio.addEventListener('timeupdate', handler);
}

function getAudioContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioContext;
}

async function ensureContextRunning() {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }
}

window.addEventListener('resize', scheduleWaveformResize);

filePicker?.addEventListener('change', event => {
  const files = Array.from(event.target.files || []);
  if (!files.length) {
    return;
  }
  addTracks(files);
  filePicker.value = '';
  scheduleStorageStatsUpdate();
});

clearPlaylistBtn?.addEventListener('click', () => {
  const count = state.tracks.length;
  const noun = count === 1 ? 'pista' : 'pistas';
  const confirmed = window.confirm(`¿Limpiar la lista actual? Se eliminarán ${count} ${noun} de esta sesión.`);
  if (!confirmed) {
    return;
  }
  const removeRemotePaths = state.tracks
    .map(track => track.dropboxPath)
    .filter(Boolean);
  removeRemotePaths.forEach(path => pendingDeletions.add(path));
  pendingUploads.clear();
  waveformCache.clear();
  state.tracks.forEach(track => {
    if (!track.isRemote && track.url) {
      URL.revokeObjectURL(track.url);
    }
    if (track.coverUrl) {
      try { URL.revokeObjectURL(track.coverUrl); } catch {}
      track.coverUrl = null;
    }
    deleteTrackFile(track.id).catch(console.error);
  });
  state.tracks.splice(0, state.tracks.length);
  stopPlayback();
  invalidateShuffle();
  renderPlaylist();
  updateControls();
  persistLocalPlaylist();
  requestDropboxSync();
  scheduleStorageStatsUpdate();
});

playlistPicker?.addEventListener('change', event => {
  const nextId = event.target.value;
  setActivePlaylist(nextId);
});

newPlaylistBtn?.addEventListener('click', () => {
  const suggestion = `Lista ${state.playlists.length + 1}`;
  const name = prompt('Nombre de la nueva lista', suggestion);
  if (name === null) {
    return;
  }
  const trimmed = name.trim();
  if (!trimmed) {
    return;
  }
  createPlaylist(trimmed);
});

renamePlaylistBtn?.addEventListener('click', () => {
  renameActivePlaylist();
});

deletePlaylistBtn?.addEventListener('click', () => {
  deleteActivePlaylist();
});

shuffleToggleBtn?.addEventListener('click', () => {
  state.shuffle = !state.shuffle;
  if (state.shuffle) {
    shuffleQueue = buildShuffledIndices(state.currentIndex);
    shuffleHistory = [];
  } else {
    shuffleQueue = [];
    shuffleHistory = [];
  }
  updateControls();
  persistLocalPlaylist();
});

fadeSlider?.addEventListener('input', () => {
  state.fadeDuration = Number(fadeSlider.value);
  fadeValue.textContent = `${state.fadeDuration.toFixed(1).replace(/\.0$/, '')} s`;
  persistLocalPlaylist();
});

speedSlider?.addEventListener('input', () => {
  const rate = Number(speedSlider.value) || 1;
  state.playbackRate = rate;
  // Aplicar al vuelo a ambos reproductores
  players.forEach(p => {
    try { p.audio.playbackRate = rate; } catch {}
  });
  persistLocalPlaylist();
  // No es necesario sincronizar inmediatamente; se guarda en settings en la próxima sync
  updateSpeedUI();
});

speedSlider?.addEventListener('change', () => {
  updateSpeedUI();
});

speedResetBtn?.addEventListener('click', (e) => {
  e.preventDefault();
  state.playbackRate = 1;
  updateSpeedUI();
  persistLocalPlaylist();
});

// Botones +/- para ajustar velocidad
speedDownBtn?.addEventListener('click', (e) => {
  e.preventDefault();
  nudgePlaybackRate(-0.01);
});
speedUpBtn?.addEventListener('click', (e) => {
  e.preventDefault();
  nudgePlaybackRate(0.01);
});

loopToggle?.addEventListener('change', () => {
  state.autoLoop = loopToggle.checked;
  updateControls();
  persistLocalPlaylist();
});

pageSizeSelect?.addEventListener('change', () => {
  const val = Number(pageSizeSelect.value) || 0;
  state.viewPageSize = Math.max(0, val);
  state.viewPageIndex = 0;
  const id = state.activePlaylistId;
  if (id) {
    viewPerList[id] = { ...(viewPerList[id] || {}), pageSize: state.viewPageSize, pageIndex: state.viewPageIndex, sort: state.viewSort, minRating: state.viewMinRating };
  }
  renderPlaylist();
  persistLocalPlaylist();
});

sortSelect?.addEventListener('change', () => {
  const val = String(sortSelect.value || 'none');
  state.viewSort = val;
  state.viewPageIndex = 0;
  const id = state.activePlaylistId;
  if (id) {
    viewPerList[id] = { ...(viewPerList[id] || {}), sort: state.viewSort, pageIndex: state.viewPageIndex, pageSize: state.viewPageSize, minRating: state.viewMinRating };
  }
  renderPlaylist();
  persistLocalPlaylist();
});

minRatingSelect?.addEventListener('change', () => {
  const val = Number(minRatingSelect.value) || 0;
  state.viewMinRating = Math.max(0, Math.min(5, val));
  state.viewPageIndex = 0;
  const id = state.activePlaylistId;
  if (id) {
    viewPerList[id] = { ...(viewPerList[id] || {}), minRating: state.viewMinRating, pageIndex: state.viewPageIndex, sort: state.viewSort, pageSize: state.viewPageSize };
  }
  renderPlaylist();
  persistLocalPlaylist();
});

// Búsqueda global
globalSearchInput?.addEventListener('input', () => {
  if (searchDebounce) {
    clearTimeout(searchDebounce);
  }
  searchDebounce = setTimeout(() => {
    performGlobalSearch(globalSearchInput.value);
  }, 120);
});

globalSearchInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    globalSearchInput.value = '';
    clearSearchResults();
  } else if (e.key === 'Enter') {
    const first = searchResultsEl?.querySelector('li.search-result');
    if (first) first.click();
  }
});

// Navegar, revelar y/o reproducir desde resultados de búsqueda
function revealTrackInView(index) {
  try {
    const order = buildViewOrder();
    const size = Math.max(0, Number(state.viewPageSize) || 0);
    let pos = order.indexOf(index);
    if (pos === -1) {
      // Si está filtrada por valoración, restablecer filtro para poder mostrarla
      const prevMin = state.viewMinRating;
      const prevSort = state.viewSort;
      state.viewMinRating = 0;
      state.viewSort = 'none';
      const fallback = buildViewOrder();
      pos = fallback.indexOf(index);
      // Mantener los nuevos filtros para que el usuario la vea
      if (minRatingSelect) minRatingSelect.value = String(state.viewMinRating || 0);
      if (sortSelect) sortSelect.value = state.viewSort || 'none';
    }
    if (pos === -1) return;
    if (size) {
      state.viewPageIndex = Math.floor(pos / size);
    } else {
      state.viewPageIndex = 0;
    }
    renderPlaylist();
    // Resaltar y centrar el elemento
    const item = playlistEl?.querySelector(`.track[data-index="${index}"]`);
    if (item && typeof item.scrollIntoView === 'function') {
      item.classList.add('is-highlighted');
      item.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => item.classList.remove('is-highlighted'), 1600);
    }
  } catch (err) {
    console.warn('No se pudo revelar la pista', err);
  }
}

function goToTrackFromSearch(playlistId, index, { play = false, reveal = false } = {}) {
  if (!playlistId || Number.isNaN(index)) return;
  const willChangePlaylist = state.activePlaylistId !== playlistId;
  setActivePlaylist(playlistId);
  // Asegurar que el DOM se actualiza antes de acciones dependientes del render
  setTimeout(() => {
    if (reveal) {
      revealTrackInView(index);
    }
    if (play) {
      playTrack(index).catch(console.error);
    }
    if (play || reveal) {
      clearSearchResults();
    }
  }, willChangePlaylist ? 0 : 0);
}

searchResultsEl?.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  const li = e.target.closest('li.search-result');
  if (!li) return;
  const playlistId = li.dataset.playlistId;
  const index = Number(li.dataset.index);
  if (btn) {
    const action = btn.dataset.action;
    if (action === 'play') {
      e.preventDefault();
      e.stopPropagation();
      goToTrackFromSearch(playlistId, index, { play: true, reveal: false });
      return;
    }
    if (action === 'reveal') {
      e.preventDefault();
      e.stopPropagation();
      goToTrackFromSearch(playlistId, index, { play: false, reveal: true });
      return;
    }
  }
  // Click en toda la fila: reproducir como antes
  goToTrackFromSearch(playlistId, index, { play: true, reveal: false });
});

playlistEl?.addEventListener('click', event => {
  const button = event.target.closest('button[data-action]');
  if (!button) {
    return;
  }
  const index = Number(button.dataset.index);
  if (Number.isNaN(index)) {
    return;
  }
  switch (button.dataset.action) {
    case 'play':
      playTrack(index).catch(console.error);
      break;
    case 'rename':
      renameTrack(index);
      break;
    case 'remove':
      removeTrack(index);
      break;
    case 'rate':
      setTrackRating(index, Number(button.dataset.value) || 0);
      break;
  }
});

playlistEl?.addEventListener('dragstart', event => {
  const item = event.target.closest('.track');
  if (!item) {
    return;
  }
  dragIndex = Number(item.dataset.index);
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', String(dragIndex));
  item.classList.add('dragging');
});

playlistEl?.addEventListener('dragover', event => {
  event.preventDefault();
  const item = event.target.closest('.track');
  if (!item || item.classList.contains('dragging')) {
    return;
  }
  Array.from(playlistEl.children).forEach(child => child.classList.remove('drag-over'));
  item.classList.add('drag-over');
  event.dataTransfer.dropEffect = 'move';
});

playlistEl?.addEventListener('dragleave', event => {
  const item = event.target.closest('.track');
  if (item) {
    item.classList.remove('drag-over');
  }
});

playlistEl?.addEventListener('drop', event => {
  event.preventDefault();
  const targetItem = event.target.closest('.track');
  if (!targetItem || dragIndex === null) {
    return;
  }
  targetItem.classList.remove('drag-over');
  const targetIndex = Number(targetItem.dataset.index);
  reorderTracks(dragIndex, targetIndex);
  dragIndex = null;
});

playlistEl?.addEventListener('dragend', () => {
  Array.from(playlistEl.children).forEach(child => {
    child.classList.remove('dragging');
    child.classList.remove('drag-over');
  });
  dragIndex = null;
});

togglePlayBtn?.addEventListener('click', () => {
  if (!state.tracks.length) {
    return;
  }
  ensurePlayers();
  if (state.currentIndex === -1) {
    const start = getStartIndex();
    playTrack(start).catch(console.error);
    return;
  }
  const currentPlayer = players[activePlayerIndex];
  if (state.isPlaying) {
    currentPlayer.audio.pause();
    state.isPlaying = false;
    cancelAutoAdvance(currentPlayer);
  } else {
    ensureContextRunning()
      .then(() => currentPlayer.audio.play())
      .then(() => {
        state.isPlaying = true;
        if (state.currentIndex !== -1) {
          scheduleAutoAdvance(currentPlayer, state.currentIndex);
        }
      })
      .catch(console.error);
  }
  updateControls();
  updateMediaSessionPlaybackState();
});

prevTrackBtn?.addEventListener('click', () => {
  const prev = getPrevIndex();
  if (prev !== -1) {
    playTrack(prev).catch(console.error);
  }
});

nextTrackBtn?.addEventListener('click', () => {
  const next = getNextIndex();
  if (next !== -1) {
    playTrack(next).catch(console.error);
  }
});

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  deferredPrompt = event;
  installButton.hidden = false;
});

installButton?.addEventListener('click', async () => {
  if (!deferredPrompt) {
    return;
  }
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  installButton.hidden = true;
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').then(reg => {
      try { console.debug('[SW] registered', reg); } catch {}
      // Fuerza comprobación de actualizaciones en cada carga
      try { reg.update(); } catch {}

      const activateUpdate = () => {
        if (!navigator.serviceWorker.controller) return;
        try { console.debug('[SW] auto-activate update'); } catch {}
        try {
          reg.waiting?.postMessage({ type: 'SKIP_WAITING' });
          reg.waiting?.skipWaiting?.();
        } catch {}
        const reload = () => window.location.reload();
        let reloaded = false;
        const onControllerChange = () => {
          try { console.debug('[SW] controllerchange → reload'); } catch {}
          if (!reloaded) { reloaded = true; reload(); }
        };
        navigator.serviceWorker.addEventListener('controllerchange', onControllerChange, { once: true });
        setTimeout(reload, 800);
      };

      reg.addEventListener('updatefound', () => {
        const installing = reg.installing;
        try { console.debug('[SW] updatefound', installing); } catch {}
        installing?.addEventListener('statechange', () => {
          try { console.debug('[SW] installing state:', installing.state); } catch {}
          if (installing.state === 'installed') {
            activateUpdate();
          }
        });
      });

      // Si ya hay un worker en espera, actívalo de inmediato
      if (reg.waiting) {
        activateUpdate();
      }
    }).catch(err => {
      try { console.debug('[SW] register failed', err); } catch {}
      console.error(err);
    });
  });
}

// Captura básica de errores para evitar pantallas en blanco silenciosas
try {
  const showFatalError = (msg) => {
    try {
      const el = document.createElement('div');
      el.style.position = 'fixed';
      el.style.inset = '0 auto auto 0';
      el.style.maxWidth = '100%';
      el.style.zIndex = '99999';
      el.style.background = 'rgba(232, 93, 117, 0.95)';
      el.style.color = '#fff';
      el.style.padding = '8px 12px';
      el.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
      el.style.fontSize = '14px';
      el.style.boxShadow = '0 6px 16px rgba(0,0,0,0.25)';
      el.textContent = `Error en la app: ${msg}`;
      document.body && document.body.appendChild(el);
    } catch {}
  };

  window.addEventListener('error', (e) => {
    // Evita inundar si es un recurso bloqueado de red; muestra solo errores JS
    if (e && e.message) {
      showFatalError(e.message);
    }
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e && (e.reason?.message || String(e.reason || ''));
    if (reason) showFatalError(reason);
  });
} catch {}

dropboxConnectBtn?.addEventListener('click', () => {
  beginDropboxAuth().catch(error => {
    console.error('Error iniciando Dropbox', error);
    showDropboxError('No se pudo iniciar la autenticación.');
  });
});

dropboxSyncBtn?.addEventListener('click', () => {
  performDropboxSync({ loadRemote: true }).catch(console.error);
});

dropboxSyncSelectedBtn?.addEventListener('click', () => {
  const ids = Array.from(selectedForSync);
  if (!ids.length) return;
  performDropboxSync({ loadRemote: true, onlyTrackIds: ids }).catch(console.error);
});

dropboxDisconnectBtn?.addEventListener('click', () => {
  disconnectDropbox();
});

// Opción "subir al reproducir" eliminada: no hay listener

// Botón rápido en el aviso de pendientes (si existe)
try {
  const btn = document.getElementById('dropboxPendingSyncNow');
  btn?.addEventListener('click', () => {
    if (dropboxState.isSyncing) return;
    performDropboxSync({ loadRemote: true }).catch(console.error);
  });
} catch {}

// Limpiar pendientes ya inexistentes en Dropbox
dropboxClearPendingBtn?.addEventListener('click', async () => {
  if (dropboxState.isSyncing) return;
  try {
    const token = await ensureDropboxToken();
    if (!token) { showDropboxError('Conéctate a Dropbox para limpiar pendientes.'); return; }
    const arr = Array.from(pendingDeletions || []);
    if (!arr.length) return;
    const CHUNK = 50;
    for (let i = 0; i < arr.length; i += CHUNK) {
      const slice = arr.slice(i, i + CHUNK);
      await Promise.all(slice.map(async (path) => {
        try {
          const resp = await fetch('https://api.dropboxapi.com/2/files/get_metadata', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ path, include_deleted: true }),
          });
          if (resp.ok) {
            const meta = await resp.json();
            const tag = meta['.tag'] || '';
            if (tag === 'deleted') {
              pendingDeletions.delete(String(path).toLowerCase());
            }
          } else {
            const txt = await resp.text().catch(() => '');
            if (/not_found/i.test(txt)) {
              pendingDeletions.delete(String(path).toLowerCase());
            }
          }
        } catch {}
      }));
      await sleep(150);
    }
    persistLocalPlaylist();
    updateDropboxUI();
  } catch (e) {
    console.warn('clear pending error', e);
  }
});

// Forzar borrado inmediato de pendientes (delete_v2 para cada ruta)
dropboxForceDeleteBtn?.addEventListener('click', async () => {
  if (dropboxState.isSyncing) return;
  try {
    const token = await ensureDropboxToken();
    if (!token) { showDropboxError('Conéctate a Dropbox para borrar pendientes.'); return; }
    await forceDeleteRemainder(token);
  } catch (e) {
    console.warn('force delete error', e);
  }
});

// Probar conexión con Dropbox: distingue red bloqueada vs. OK
dropboxTestConnBtn?.addEventListener('click', async () => {
  const markOk = (msg) => {
    if (dropboxStatusEl) dropboxStatusEl.textContent = msg || 'Conexión con Dropbox: OK';
    cloudSyncCard?.classList.remove('is-error');
  };
  try {
    // 1) check/app — no requiere token
    const res = await fetch('https://api.dropboxapi.com/2/check/app', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (res.ok) { markOk('Conexión con Dropbox: OK'); return; }
    // 400/401/403/404 siguen indicando que la ruta de red es accesible
    if (res.status >= 400 && res.status < 500) {
      markOk(`Conexión con Dropbox: OK (HTTP ${res.status})`);
      const t = await res.text().catch(() => '');
      console.debug('check/app response', res.status, t);
      return;
    }
    // Intento 2) check/user
    const res2 = await fetch('https://api.dropboxapi.com/2/check/user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (res2.ok || (res2.status >= 400 && res2.status < 500)) {
      markOk(`Conexión con Dropbox: OK (HTTP ${res2.status})`);
      const t = await res2.text().catch(() => '');
      console.debug('check/user response', res2.status, t);
      return;
    }
    const t = await res2.text().catch(() => '');
    showDropboxError('Dropbox responde pero con error.');
    console.debug('check/user response', res2.status, t);
  } catch (e) {
    showDropboxError('Bloqueo de red/extension hacia Dropbox.');
    console.debug('Conectividad Dropbox fallida', e);
  }
});

// Botón rápido en el aviso de pendientes
pendingSyncNowBtn?.addEventListener('click', () => {
  if (dropboxState.isSyncing) return;
  performDropboxSync({ loadRemote: true }).catch(console.error);
});

// Opción "descargar solo al reproducir" eliminada: sin listener

preferLocalSourceToggle?.addEventListener('change', () => {
  state.preferLocalSource = !!preferLocalSourceToggle.checked;
  persistLocalPlaylist();
});

clearLocalCopiesBtn?.addEventListener('click', async () => {
  const count = getAllTracks().length;
  const ok = window.confirm(`¿Borrar copias locales de ${count} pista${count!==1?'s':''}? No se elimina la lista.`);
  if (!ok) return;
  const tracks = getAllTracks();
  for (const track of tracks) {
    try {
      await deleteTrackFile(track.id);
      if (track.url && track.url.startsWith('blob:')) {
        try { URL.revokeObjectURL(track.url); } catch {}
      }
      track.url = null;
      track.isRemote = !!track.dropboxPath;
      track.urlExpiresAt = 0;
    } catch {}
  }
  waveformCache.clear();
  persistLocalPlaylist();
  renderPlaylist();
  scheduleStorageStatsUpdate();
});

selectAllForSyncBtn?.addEventListener('click', () => {
  const ids = (state.tracks || []).map(t => t.id);
  ids.forEach(id => selectedForSync.add(id));
  persistLocalPlaylist();
  renderPlaylist();
  updateDropboxUI();
});

clearSelectedForSyncBtn?.addEventListener('click', () => {
  const ids = (state.tracks || []).map(t => t.id);
  ids.forEach(id => selectedForSync.delete(id));
  persistLocalPlaylist();
  renderPlaylist();
  updateDropboxUI();
});

pagerPrevBtn?.addEventListener('click', () => {
  if (state.viewPageSize <= 0) return;
  state.viewPageIndex = Math.max(0, (state.viewPageIndex || 0) - 1);
  renderPlaylist();
  persistLocalPlaylist();
});

normalizationToggle?.addEventListener('change', () => {
  state.normalizationEnabled = !!normalizationToggle.checked;
  updateNormalizationLive();
  persistLocalPlaylist();
  // Se guarda en Dropbox junto al resto de ajustes en la próxima sync
});

autoSyncToggle?.addEventListener('change', () => {
  state.autoSync = !!autoSyncToggle.checked;
  persistLocalPlaylist();
  // No disparamos sync; se respetará la preferencia a partir de ahora y se guardará en settings en la próxima sync
});

pagerNextBtn?.addEventListener('click', () => {
  if (state.viewPageSize <= 0) return;
  const size = state.viewPageSize;
  const total = state.tracks.length;
  const pages = Math.max(1, Math.ceil(total / size));
  state.viewPageIndex = Math.min(pages - 1, (state.viewPageIndex || 0) + 1);
  renderPlaylist();
  persistLocalPlaylist();
});

dropboxRetryFailedBtn?.addEventListener('click', () => {
  if (dropboxState.isSyncing) return;
  const failed = getAllTracks().filter(t => !t.dropboxPath && t._sync === 'error');
  if (!failed.length) return;
  failed.forEach(t => { t._sync = 'queued'; });
  renderPlaylist();
  performDropboxSync({ loadRemote: false, onlyTrackIds: failed.map(t => t.id) }).catch(console.error);
});

function addTracks(files) {
  const audioFiles = files
    .filter(file => file.type.startsWith('audio/'))
    .sort((a, b) => {
      const pathA = (a.webkitRelativePath && a.webkitRelativePath.length ? a.webkitRelativePath : a.name) || '';
      const pathB = (b.webkitRelativePath && b.webkitRelativePath.length ? b.webkitRelativePath : b.name) || '';
      return pathA.localeCompare(pathB, undefined, { numeric: true, sensitivity: 'base' });
    });
  const newTracks = audioFiles
    .map(file => {
      const url = URL.createObjectURL(file);
      const relativePath = (file.webkitRelativePath && file.webkitRelativePath.length ? file.webkitRelativePath : file.name) || file.name;
      const normalizedPath = relativePath.replace(/^[\\/]+/, '').replace(/\\/g, '/');
      const displayName = normalizedPath.replace(/\.[^/.]+$/, '');
      const track = {
        id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
        name: displayName,
        fileName: file.name,
        url,
        duration: null,
        size: file.size,
        lastModified: file.lastModified,
        updatedAt: Date.now(),
        rating: 0,
        dropboxPath: null,
        dropboxRev: null,
        dropboxSize: null,
        dropboxUpdatedAt: null,
        waveform: null,
        urlExpiresAt: 0,
        isRemote: false,
      };
      pendingUploads.set(track.id, file);
      if (Number(file.size || 0) > IDB_MAX_VALUE_BYTES) {
        track._localTooLarge = true;
      } else {
        storeTrackFile(track.id, file).catch(console.error);
      }
      readDuration(track);
      return track;
    });
  if (!newTracks.length) {
    return;
  }
  state.tracks.push(...newTracks);
  newTracks.forEach(track => {
    ensureWaveform(track).catch(console.error);
    ensureCoverArt(track)
      .then(changed => { if (changed) updateTrackThumbnails(track); })
      .catch(() => {});
  });
  invalidateShuffle();
  renderPlaylist();
  updateControls();
  persistLocalPlaylist();
  requestDropboxSync();
}

function readDuration(track) {
  const probe = document.createElement('audio');
  probe.src = track.url;
  probe.preload = 'metadata';
  probe.addEventListener('loadedmetadata', () => {
    track.duration = probe.duration;
    if (waveformState.trackId === track.id) {
      waveformState.duration = track.duration;
    }
    renderPlaylist();
    persistLocalPlaylist();
  }, { once: true });
}

function removeTrack(index) {
  const track = state.tracks[index];
  if (!track) {
    return;
  }
  const displayName = track.name || track.fileName || 'esta pista';
  const confirmed = window.confirm(`¿Eliminar "${displayName}" de la lista?`);
  if (!confirmed) {
    return;
  }
  if (!track.isRemote && track.url) {
    URL.revokeObjectURL(track.url);
  }
  pendingUploads.delete(track.id);
  waveformCache.delete(track.id);
  if (track.coverUrl) {
    try { URL.revokeObjectURL(track.coverUrl); } catch {}
    track.coverUrl = null;
  }
  deleteTrackFile(track.id).catch(console.error);
  if (track.dropboxPath) {
    pendingDeletions.add(track.dropboxPath);
  }
  state.tracks.splice(index, 1);
  invalidateShuffle();
  if (state.currentIndex === index) {
    if (state.tracks.length) {
      const fallback = Math.min(index, state.tracks.length - 1);
      state.currentIndex = -1;
      playTrack(fallback, { fade: false }).catch(() => {
        stopPlayback();
      });
    } else {
      stopPlayback();
    }
  } else if (state.currentIndex > index) {
    state.currentIndex -= 1;
  }
  if (!state.tracks.length) {
    setWaveformTrack(null);
  }
  renderPlaylist();
  updateControls();
  persistLocalPlaylist();
  requestDropboxSync();
  scheduleStorageStatsUpdate();
}

function renameTrack(index) {
  const track = state.tracks[index];
  if (!track) {
    return;
  }
  const proposed = prompt('Nuevo nombre de la pista', track.name || track.fileName || '');
  if (proposed === null) {
    return;
  }
  const nextName = proposed.trim();
  if (!nextName || nextName === track.name) {
    return;
  }
  track.name = nextName;
  // Marca para no sobreescribir con títulos ID3 automáticamente
  track.userRenamed = true;
  track.updatedAt = Date.now();
  const active = getActivePlaylist();
  if (active) active.updatedAt = Date.now();
  renderPlaylist();
  updateNowPlaying();
  persistLocalPlaylist();
  requestDropboxSync();
}

function setTrackRating(index, value) {
  const track = state.tracks[index];
  if (!track) return;
  const next = Math.max(0, Math.min(5, Math.floor(value)));
  if (track.rating === next) return;
  track.rating = next;
  track.updatedAt = Date.now();
  renderPlaylist();
  persistLocalPlaylist();
  requestDropboxSync();
}

function reorderTracks(from, to) {
  if (from === to || from < 0 || to < 0 || from >= state.tracks.length || to >= state.tracks.length) {
    return;
  }
  const [moved] = state.tracks.splice(from, 1);
  state.tracks.splice(to, 0, moved);
  const active = getActivePlaylist();
  if (active) active.updatedAt = Date.now();
  invalidateShuffle();
  if (state.currentIndex === from) {
    state.currentIndex = to;
  } else if (state.currentIndex > from && state.currentIndex <= to) {
    state.currentIndex -= 1;
  } else if (state.currentIndex < from && state.currentIndex >= to) {
    state.currentIndex += 1;
  }
  renderPlaylist();
  updateControls();
  persistLocalPlaylist();
  requestDropboxSync();
}

async function ensureTrackRemoteLink(track) {
  if (!track.dropboxPath) {
    return false;
  }
  const now = Date.now();
  if (track.url && track.url.startsWith('blob:')) {
    return true;
  }
  // Evitar reintentos inmediatos si hay cooldown por error previo
  if (track._remoteRetryAt && now < track._remoteRetryAt) {
    return false;
  }
  // Reutiliza petición en curso por pista
  if (remoteLinkInFlight.has(track.id)) {
    try { return await remoteLinkInFlight.get(track.id); } finally {}
  }
  // Respetar ventana global de lectura y concurrencia
  if (now < dropboxReadAvailableAt || dropboxReadInFlight >= DROPBOX_READ_CONCURRENCY) {
    return false;
  }
  dropboxReadInFlight += 1;
  const done = (result) => { dropboxReadInFlight = Math.max(0, dropboxReadInFlight - 1); return result; };
  const run = (async () => {
  const token = await ensureDropboxToken();
  if (!token) {
    showDropboxError('Debes volver a conectar tu Dropbox.');
    return false;
  }
  try {
    const response = await fetch('https://api.dropboxapi.com/2/files/get_temporary_link', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: track.dropboxPath }),
    });
    if (!response.ok) {
      let details = '';
      try {
        details = await response.text();
      } catch (readError) {
        details = String(readError);
      }
      const summary = (() => {
        try {
          const parsed = JSON.parse(details);
          return parsed?.error_summary || details;
        } catch {
          return details;
        }
      })();
      const errorInfo = new Error(summary || 'No se pudo obtener enlace temporal');
      errorInfo.responseStatus = response.status;
      // Backoff básico ante 429/503 o señales de rate limit
      try {
        const retrySec = parseDropboxRetryInfo(response.status, response.headers, details);
        if (retrySec > 0) {
          dropboxReadAvailableAt = Date.now() + retrySec * 1000;
          track._remoteRetryAt = Date.now() + Math.min(60000, retrySec * 1200);
        }
      } catch {}
      throw errorInfo;
    }
    const data = await response.json();
    const download = await fetch(data.link);
    if (!download.ok) {
      throw new Error('No se pudo descargar el archivo de Dropbox');
    }
    const blob = await download.blob();
    const fileName = track.fileName || data.metadata?.name || `${track.id}.mp3`;
    const fileType = blob.type || download.headers.get('Content-Type') || 'audio/mpeg';
    const fileLike = typeof File === 'function' ? new File([blob], fileName, { type: fileType, lastModified: Date.now() }) : blob;
    await storeTrackFile(track.id, fileLike).catch(console.error);
    if (track.url && track.url.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(track.url);
      } catch (revokeError) {
        console.warn('No se pudo liberar URL local previa', revokeError);
      }
    }
    track.url = URL.createObjectURL(blob);
    track.size = blob.size;
    track.fileName = fileName;
    track.lastModified = Date.now();
    track.isRemote = true;
    track.urlExpiresAt = 0;
    return true;
  } catch (error) {
    console.error('Error obteniendo enlace temporal', error);
    if (typeof error?.message === 'string' && error.message.includes('not_found')) {
      showDropboxError('No se encontró el archivo en Dropbox, intenta sincronizar de nuevo.');
    } else {
      showDropboxError('No se pudo obtener el audio desde Dropbox.');
    }
    return false;
  } finally {
    remoteLinkInFlight.delete(track.id);
  }
  })();
  remoteLinkInFlight.set(track.id, run);
  try { return await run; } finally { done(); }
}

async function playTrack(index, options = {}) {
  const track = state.tracks[index];
  if (!track) {
    return;
  }
  lastPrefetchForTrackId = null;
  // Marca para subir a Dropbox solo si se reproduce, si procede
  // Política "subir al reproducir" eliminada: solo sincronización manual
  // Marca como reproducida para permitir descargas/forma de onda bajo política "solo al reproducir"
  track._hasPlayed = true;
  const { fade = true, fadeDurationOverride } = options;
  setWaveformTrack(track);

  await ensureContextRunning();

  // Selección de fuente según preferencia
  let ready = false;
  if (state.preferLocalSource) {
    ready = await ensureLocalTrackUrl(track);
    if (!ready && track.dropboxPath) {
      ready = await ensureTrackRemoteLink(track);
    }
  } else {
    if (track.dropboxPath) {
      ready = await ensureTrackRemoteLink(track);
      if (!ready) {
        ready = await ensureLocalTrackUrl(track);
      }
    } else {
      ready = await ensureLocalTrackUrl(track);
    }
  }
  if (!ready) {
    if (waveformContainer) {
      waveformContainer.classList.remove('is-loading');
      waveformContainer.classList.remove('has-data');
    }
    if (waveformMessage) {
      waveformMessage.textContent = 'Audio no disponible. Vuelve a importarlo o sincronízalo con Dropbox.';
    }
    return;
  }

  if (!track.url) {
    console.warn('La pista no tiene una URL reproducible');
    if (!track.dropboxPath) {
      if (waveformMessage) {
        waveformMessage.textContent = 'Audio local no disponible. Vuelve a importarlo.';
      }
    } else {
      // No bloquear: intenta forzar lectura local si existe
      const fallback = await ensureLocalTrackUrl(track);
      if (!fallback) {
        showDropboxError('No se pudo obtener el audio desde Dropbox.');
      }
    }
    return;
  }

  await ensureContextRunning();

  const hasCurrent = state.currentIndex !== -1 && state.isPlaying;
  const useFade = fade && hasCurrent;
  const previousPlayerIndex = activePlayerIndex;
  ensurePlayers();
  const nextPlayerIndex = useFade ? 1 - activePlayerIndex : activePlayerIndex;
  const nextPlayer = players[nextPlayerIndex];
  const previousPlayer = players[previousPlayerIndex];

  if (previousPlayer) {
    previousPlayer.audio.onended = null;
    cancelAutoAdvance(previousPlayer);
  }
  cancelAutoAdvance(nextPlayer);
  window.clearTimeout(nextPlayer.stopTimeout);
  nextPlayer.stopTimeout = null;

  if (nextPlayer.audio.src !== track.url) {
    nextPlayer.audio.src = track.url;
    try {
      nextPlayer.audio.load();
    } catch (loadError) {
      console.warn('No se pudo preparar el audio', loadError);
    }
  }
  // Aplicar velocidad actual
  try { nextPlayer.audio.playbackRate = Number(state.playbackRate) || 1; } catch {}
  nextPlayer.audio.currentTime = 0;
  nextPlayer.trackId = track.id;
  // Intentar extraer carátula si no la tenemos aún
  if (!track.coverUrl) {
    ensureCoverArt(track).catch(() => {});
  } else {
    updateCoverArtDisplay(track);
  }

  let playError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    playError = null;
    try {
      await nextPlayer.audio.play();
      break;
    } catch (error) {
      playError = error;
      if (attempt === 0) {
        await ensureContextRunning();
        await new Promise(resolve => setTimeout(resolve, 40));
        continue;
      }
    }
  }
  if (playError) {
    nextPlayer.trackId = null;
    console.error('No se pudo reproducir la pista', playError);
    return;
  }

  if (waveformState.trackId === track.id && Number.isFinite(track.duration)) {
    waveformState.duration = track.duration;
    waveformState.progress = 0;
    if (waveformState.peaks && waveformState.peaks.length) {
      drawWaveform(waveformState.peaks, waveformState.progress);
    }
  }

  const now = getAudioContext().currentTime;
  const fallbackFade = Number.isFinite(state.fadeDuration) ? state.fadeDuration : CROSS_FADE_MIN;
  const resolvedFade = Number.isFinite(fadeDurationOverride) ? fadeDurationOverride : fallbackFade;
  const fadeDuration = useFade ? Math.max(resolvedFade, CROSS_FADE_MIN) : CROSS_FADE_MIN;
  const baseGain = state.normalizationEnabled && Number.isFinite(track.normalizationGain) && track.normalizationGain > 0 ? track.normalizationGain : 1;
  nextPlayer.gain.gain.cancelScheduledValues(now);
  nextPlayer.gain.gain.setValueAtTime(useFade ? 0 : baseGain, now);
  nextPlayer.gain.gain.linearRampToValueAtTime(baseGain, now + (useFade ? fadeDuration : 0.05));

  if (useFade) {
    previousPlayer.gain.gain.cancelScheduledValues(now);
    const currentValue = previousPlayer.gain.gain.value;
    previousPlayer.gain.gain.setValueAtTime(currentValue, now);
    previousPlayer.gain.gain.linearRampToValueAtTime(0, now + fadeDuration);
    window.clearTimeout(previousPlayer.stopTimeout);
    const fadedTrackId = previousPlayer.trackId;
    previousPlayer.stopTimeout = window.setTimeout(() => {
      if (previousPlayer.trackId !== fadedTrackId) {
        return;
      }
      previousPlayer.audio.pause();
      previousPlayer.audio.currentTime = 0;
    previousPlayer.gain.gain.setValueAtTime(0, getAudioContext().currentTime);
      previousPlayer.trackId = null;
    }, fadeDuration * 1000 + 120);
  } else if (previousPlayerIndex !== nextPlayerIndex) {
    previousPlayer.audio.pause();
    previousPlayer.audio.currentTime = 0;
    previousPlayer.gain.gain.setValueAtTime(0, now);
    previousPlayer.trackId = null;
  }

  activePlayerIndex = nextPlayerIndex;
  state.currentIndex = index;
  state.isPlaying = true;
  if (state.shuffle) {
    // Modo sin repetición: elimina la pista actual de la cola restante
    shuffleQueue = (shuffleQueue || []).filter(i => i !== index);
  }
  updateNowPlaying();
  renderPlaylist();
  updateControls();
  updateMediaSessionMetadata(track);
  updateMediaSessionPlaybackState();
  scheduleAutoAdvance(nextPlayer, index);

  nextPlayer.audio.onended = () => {
    if (state.currentIndex !== index) {
      return;
    }
  if (state.autoLoop && state.tracks[index]) {
    playTrack(index, { fade: false }).catch(console.error);
    return;
  }
  const nextIndex = getNextIndex();
  if (nextIndex !== -1) {
    playTrack(nextIndex, { fade: false }).catch(console.error);
  } else {
    stopPlayback();
  }
  };
}

function stopPlayback() {
  if (players.length) {
    const now = audioContext ? getAudioContext().currentTime : 0;
    players.forEach(player => {
      cancelAutoAdvance(player);
      player.audio.onended = null;
      player.audio.pause();
      player.audio.currentTime = 0;
      if (audioContext) {
        player.gain.gain.setValueAtTime(0, now);
      }
      window.clearTimeout(player.stopTimeout);
      player.trackId = null;
    });
  }
  state.currentIndex = -1;
  state.isPlaying = false;
  updateNowPlaying();
  updateCoverArtDisplay(null);
  renderPlaylist();
  updateControls();
  setWaveformTrack(null);
  updateMediaSessionPlaybackState();
}

function updateNowPlaying() {
  const track = state.tracks[state.currentIndex];
  if (!track) {
    nowPlayingEl.textContent = 'Ninguna pista seleccionada';
    updateCoverArtDisplay(null);
    updateNowRatingUI();
    if (timeDisplayEl) timeDisplayEl.textContent = '—:—';
    updateMediaSessionMetadata(null);
    return;
  }
  nowPlayingEl.textContent = getCleanTrackName(track);
  if (track.coverUrl) {
    updateCoverArtDisplay(track);
  }
  updateNowRatingUI();
  resetTimeDisplayForTrack(track);
  updateMediaSessionMetadata(track);
}

function syncLoopToggle() {
  if (!loopToggle) {
    return;
  }
  const shouldDisable = !state.tracks.length;
  loopToggle.disabled = shouldDisable;
  if (shouldDisable && state.autoLoop) {
    state.autoLoop = false;
  }
  loopToggle.checked = state.autoLoop;
  const wrapper = loopToggle.closest('.loop-control');
  if (wrapper) {
    wrapper.classList.toggle('is-disabled', shouldDisable);
  }
}

function updateControls() {
  togglePlayBtn.disabled = !state.tracks.length;
  togglePlayBtn.textContent = state.isPlaying ? 'Pausar' : 'Reproducir';
  if (state.shuffle) {
    prevTrackBtn.disabled = shuffleHistory.length === 0;
    nextTrackBtn.disabled = state.tracks.length <= 1;
  } else {
    prevTrackBtn.disabled = state.currentIndex <= 0;
    nextTrackBtn.disabled = state.currentIndex === -1 || state.currentIndex >= state.tracks.length - 1;
  }
  clearPlaylistBtn.disabled = !state.tracks.length;
  if (deletePlaylistBtn) {
    deletePlaylistBtn.disabled = state.playlists.length <= 1;
  }
  if (renamePlaylistBtn) {
    renamePlaylistBtn.disabled = !state.playlists.length;
  }
  if (shuffleToggleBtn) {
    shuffleToggleBtn.disabled = state.tracks.length <= 1;
    shuffleToggleBtn.classList.toggle('is-active', !!state.shuffle);
    shuffleToggleBtn.setAttribute('aria-pressed', state.shuffle ? 'true' : 'false');
    shuffleToggleBtn.title = state.shuffle ? 'Aleatorio activado' : 'Reproducción aleatoria';
  }
  syncLoopToggle();
  updateDropboxUI();
  updatePagerUI();
}

function buildViewOrder() {
  const indices = state.tracks.map((_, i) => i);
  const minR = Math.max(0, Math.min(5, Number(state.viewMinRating) || 0));
  const filtered = indices.filter(i => (Number(state.tracks[i].rating) || 0) >= minR);
  const sort = state.viewSort || 'none';
  if (sort === 'rating-desc' || sort === 'rating-asc') {
    filtered.sort((a, b) => {
      const ra = Number(state.tracks[a].rating) || 0;
      const rb = Number(state.tracks[b].rating) || 0;
      const primary = sort === 'rating-desc' ? (rb - ra) : (ra - rb);
      if (primary !== 0) return primary;
      const na = getCleanTrackName(state.tracks[a]).toLowerCase();
      const nb = getCleanTrackName(state.tracks[b]).toLowerCase();
      const byName = na.localeCompare(nb, undefined, { numeric: true, sensitivity: 'base' });
      if (byName !== 0) return byName;
      return a - b;
    });
  } else if (sort === 'name-asc' || sort === 'name-desc') {
    filtered.sort((a, b) => {
      const na = getCleanTrackName(state.tracks[a]).toLowerCase();
      const nb = getCleanTrackName(state.tracks[b]).toLowerCase();
      const cmp = na.localeCompare(nb, undefined, { numeric: true, sensitivity: 'base' });
      const primary = sort === 'name-asc' ? cmp : -cmp;
      if (primary !== 0) return primary;
      // A igualdad de nombre, mayor valoración primero
      const ra = Number(state.tracks[a].rating) || 0;
      const rb = Number(state.tracks[b].rating) || 0;
      if (rb !== ra) return rb - ra;
      return a - b;
    });
  }
  return filtered;
}

function renderPlaylist() {
  if (!playlistEl) {
    return;
  }
  playlistEl.innerHTML = '';
  const existingIds = new Set(state.tracks.map(t => t.id));
  selectedForSync = new Set(Array.from(selectedForSync).filter(id => existingIds.has(id)));
  const order = buildViewOrder();
  const total = order.length;
  const size = Math.max(0, Number(state.viewPageSize) || 0);
  const pages = size ? Math.max(1, Math.ceil(total / size)) : 1;
  if (size) {
    state.viewPageIndex = Math.min(Math.max(0, state.viewPageIndex || 0), pages - 1);
  } else {
    state.viewPageIndex = 0;
  }
  const start = size ? state.viewPageIndex * size : 0;
  const end = size ? Math.min(total, start + size) : total;

  for (let pos = start; pos < end; pos += 1) {
    const index = order[pos];
    const track = state.tracks[index];
    const item = document.createElement('li');
    item.className = 'track';
    item.draggable = true;
    item.dataset.index = String(index);
    item.dataset.trackId = track.id;
    if (index === state.currentIndex) {
      item.classList.add('is-playing');
    }
    if (track.dropboxPath) {
      item.classList.add('is-remote');
    }

    const handle = document.createElement('span');
    handle.className = 'track-handle';
    handle.textContent = '☰';
    handle.title = 'Arrastra para reordenar';

    const thumb = document.createElement('img');
    thumb.className = 'track-thumb';
    thumb.alt = 'Carátula';
    thumb.src = track.coverUrl || getPlaceholderCover(48);
    thumb.hidden = false;

  const title = document.createElement('div');
  title.className = 'track-title';
  const name = document.createElement('strong');
  name.textContent = getCleanTrackName(track);
  const meta = document.createElement('span');
  // Meta: no mostrar duración ni carpeta; dejar vacío y usar solo para flags
  meta.textContent = '';
    if (track._sync) {
      const status = document.createElement('span');
      status.className = 'badge';
      const label = track._sync === 'queued' ? 'En cola…' : (track._sync === 'uploading' ? 'Subiendo…' : (track._sync === 'error' ? 'Error' : ''));
      if (label) {
        status.textContent = label;
        status.style.marginLeft = '0.5rem';
        meta.append(' ', status);
      }
    }
    // Indicadores de estado (Dropbox, marcado para subir al reproducir, descarga diferida)
    const flags = document.createElement('span');
    flags.className = 'track-flags';
    if (track.dropboxPath) {
      const flag = document.createElement('span');
      flag.className = 'track-flag';
      flag.textContent = '☁︎';
      flag.title = 'Guardado en Dropbox';
      flags.append(flag);
    }
    // Indicador de subida al reproducir eliminado
    // Indicador de descarga diferida eliminado
    if (flags.childElementCount > 0) {
      flags.style.marginLeft = '0.5rem';
      meta.append(' ', flags);
    }
    const rating = document.createElement('div');
    rating.className = 'track-rating';
    const currentRating = Number.isFinite(track.rating) ? track.rating : 0;
    for (let r = 1; r <= 5; r += 1) {
      const star = document.createElement('button');
      star.className = 'star-button';
      star.type = 'button';
      star.textContent = r <= currentRating ? '★' : '☆';
      star.setAttribute('aria-label', `Valorar ${r} estrella${r>1?'s':''}`);
      star.setAttribute('aria-pressed', r <= currentRating ? 'true' : 'false');
      star.dataset.action = 'rate';
      star.dataset.value = String(r);
      star.dataset.index = String(index);
      rating.append(star);
    }
    title.append(name, meta, rating);

    const actions = document.createElement('div');
    actions.className = 'track-actions';
    // Botones de acción (Play, Renombrar, Eliminar) + Selección para sync
    const playButton = document.createElement('button');
    playButton.className = 'ghost icon-button';
    const isPlayingTrack = index === state.currentIndex && state.isPlaying;
    playButton.textContent = isPlayingTrack ? '♪' : '▶';
    playButton.title = isPlayingTrack ? 'Reproduciendo' : 'Reproducir';
    playButton.setAttribute('aria-label', playButton.title);
    playButton.dataset.action = 'play';
    playButton.dataset.index = String(index);

    const renameButton = document.createElement('button');
    renameButton.className = 'ghost icon-button';
    renameButton.textContent = '✎';
    renameButton.title = 'Renombrar pista';
    renameButton.setAttribute('aria-label', 'Renombrar pista');
    renameButton.dataset.action = 'rename';
    renameButton.dataset.index = String(index);

    const removeButton = document.createElement('button');
    removeButton.className = 'ghost icon-button';
    removeButton.textContent = '🗑';
    removeButton.title = 'Eliminar pista';
    removeButton.setAttribute('aria-label', 'Eliminar pista');
    removeButton.dataset.action = 'remove';
    removeButton.dataset.index = String(index);

    // Checkbox de selección junto a las acciones
    const selector = document.createElement('input');
    selector.type = 'checkbox';
    selector.className = 'track-select';
    selector.title = 'Seleccionar para sincronizar';
    selector.checked = selectedForSync.has(track.id);
    selector.addEventListener('change', () => {
      if (selector.checked) {
        selectedForSync.add(track.id);
      } else {
        selectedForSync.delete(track.id);
      }
      persistLocalPlaylist();
      updateDropboxUI();
    });

    actions.append(playButton, renameButton, removeButton, selector);
    item.append(handle, thumb, title, actions);
    playlistEl.append(item);

    // Intento de generar miniatura si no existe aún (usa local o remoto según políticas)
    if (!track.coverUrl) {
      ensureCoverArt(track)
        .then(changed => { if (changed) updateTrackThumbnails(track); })
        .catch(() => {});
    }
  }

  updatePagerUI();
}

function clearSearchResults() {
  if (searchResultsEl) {
    searchResultsEl.innerHTML = '';
  }
}

function performGlobalSearch(query) {
  if (!searchResultsEl) return;
  const q = (query || '').trim().toLowerCase();
  searchResultsEl.innerHTML = '';
  if (!q) return;
  const results = [];
  for (const playlist of state.playlists) {
    const tracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];
    for (let i = 0; i < tracks.length; i += 1) {
      const t = tracks[i];
      const name = (t.name || t.fileName || '').toLowerCase();
      if (!name) continue;
      if (name.includes(q)) {
        results.push({ playlistId: playlist.id, playlistName: playlist.name, index: i, track: t });
        if (results.length >= 100) break;
      }
    }
    if (results.length >= 100) break;
  }
  for (const r of results) {
    const li = document.createElement('li');
    li.className = 'search-result';
    li.dataset.playlistId = r.playlistId;
    li.dataset.index = String(r.index);

    const info = document.createElement('div');
    info.className = 'result-info';
    const title = document.createElement('strong');
    title.textContent = getCleanTrackName(r.track) || 'Pista';
    const meta = document.createElement('span');
    meta.className = 'result-meta';
    const posText = `#${r.index + 1}`;
    const durationText = Number.isFinite(r.track.duration) ? ` • ${formatDuration(r.track.duration)}` : '';
    meta.textContent = `${r.playlistName} • ${posText}${durationText}`;
    info.append(title, meta);

    const actions = document.createElement('div');
    actions.className = 'result-actions';
    const playBtn = document.createElement('button');
    playBtn.className = 'ghost icon-button small';
    playBtn.textContent = '▶';
    playBtn.title = 'Reproducir';
    playBtn.setAttribute('aria-label', 'Reproducir');
    playBtn.dataset.action = 'play';
    const revealBtn = document.createElement('button');
    revealBtn.className = 'ghost icon-button small';
    revealBtn.textContent = '🧭';
    revealBtn.title = 'Ver en la lista';
    revealBtn.setAttribute('aria-label', 'Ver en la lista');
    revealBtn.dataset.action = 'reveal';
    actions.append(playBtn, revealBtn);

    li.append(info, actions);
    searchResultsEl.append(li);
  }
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) {
    return '';
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60)
    .toString()
    .padStart(2, '0');
  return `${mins}:${secs}`;
}

// Normaliza el título mostrado: quita carpetas, extensión y reemplaza '_' por espacios
function getCleanTrackName(track) {
  if (!track) return '';
  // Si el usuario renombró la pista, respetar su nombre por encima de fileName/ID3
  if (track.userRenamed && track.name) {
    let s = String(track.name);
    s = repairMojibake(s);
    s = applySpanishHeuristics(s);
    s = s.split(/[/\\]/).pop();
    s = s.replace(/\.(mp3|m4a|aac|flac|wav|ogg|opus|oga|aiff|alac)$/i, '');
    s = s.replace(/_/g, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    return s;
  }
  const raw = pickBestRawName(track);
  if (!raw) return '';
  let s = repairMojibake(raw);
  s = applySpanishHeuristics(s);
  // quitar ruta si la hubiera
  s = s.split(/[/\\]/).pop();
  // quitar extensión común de audio
  s = s.replace(/\.(mp3|m4a|aac|flac|wav|ogg|opus|oga|aiff|alac)$/i, '');
  // reemplazar guiones bajos por espacios
  s = s.replace(/_/g, ' ');
  // colapsar espacios múltiples y trim
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function isNameMojibake(str) {
  return /[ÂÃ�]/.test(String(str || ''));
}

function nameQualityScore(str) {
  if (!str) return -Infinity;
  const s = String(str);
  let score = 0;
  const rep = (s.match(/�/g) || []).length;
  const moj = (s.match(/[ÂÃ]/g) || []).length;
  score -= rep * 100;
  score -= moj * 10;
  if (/[ñáéíóúüÑÁÉÍÓÚÜ]/.test(s)) score += 2;
  // prefer strings without path separators
  if (/[\/]/.test(s)) score -= 1;
  return score;
}

function pickBestRawName(track) {
  const candidates = [];
  // provided name
  if (track.name) candidates.push(String(track.name));
  // file name
  if (track.fileName) candidates.push(String(track.fileName));
  // dropbox path basename
  if (track.dropboxPath) {
    const base = String(track.dropboxPath).split('/').pop();
    if (base) candidates.push(base);
  }
  if (!candidates.length) return '';
  // choose highest score after tentative repair
  let best = candidates[0];
  let bestScore = nameQualityScore(repairMojibake(best));
  for (let i = 1; i < candidates.length; i += 1) {
    const cand = candidates[i];
    const score = nameQualityScore(repairMojibake(cand));
    if (score > bestScore) {
      best = cand;
      bestScore = score;
    }
  }
  return best;
}

// Intenta reparar mojibake común (UTF-8 interpretado como Latin-1)
function repairMojibake(str) {
  try {
    if (!str) return str;
    const hasArtifacts = /[ÂÃ�]/.test(str);
    if (!hasArtifacts) return str;
    const fixed = decodeURIComponent(escape(str));
    // Elegir si reduce caracteres problemáticos
    const score = s => (s.match(/[ÂÃ�]/g) || []).length;
    return score(fixed) <= score(str) ? fixed : str;
  } catch {
    return str;
  }
}

// Heurísticas en español para recuperar acentos/ñ cuando hay '�'
function applySpanishHeuristics(str) {
  if (!str) return str;
  let s = String(str);
  // i�n -> ión (y mayúsculas)
  s = s.replace(/i�n/g, 'ión');
  s = s.replace(/I�N/g, 'IÓN');
  // a�n -> aún; e�n -> eón
  s = s.replace(/a�n/g, 'aún');
  s = s.replace(/A�N/g, 'AÚN');
  s = s.replace(/e�n/g, 'eón');
  s = s.replace(/E�N/g, 'EÓN');
  // '�' entre vocales => ñ (Señor, año, niño, mañana, baño, cañón, etc.)
  s = s.replace(/([AEIOUÁÉÍÓÚaeiouáéíóú])�([AEIOUÁÉÍÓÚaeiouáéíóú])/g, (m, a, b) => {
    const isUpper = a === a.toUpperCase() && b === b.toUpperCase();
    return a + (isUpper ? 'Ñ' : 'ñ') + b;
  });
  // Inicio de palabra: "�" + vocal -> Ñ + vocal (DJ �aco -> DJ Ñaco)
  s = s.replace(/(^|[\s\-\(\[])+�([aeiouáéíóú])/g, (m, pre, v) => (pre || '') + 'Ñ' + v);
  s = s.replace(/(^|[\s\-\(\[])+�([AEIOUÁÉÍÓÚ])/g, (m, pre, v) => (pre || '') + 'Ñ' + v);
  // Final de palabra: estimar vocal acentuada a partir de la última vocal previa (Decid� -> Decidí)
  s = s.replace(/([A-Za-zÁÉÍÓÚáéíóú]+)�\b/g, (m, word) => {
    const lastVowel = (word.match(/[AaEeIiOoUuÁÉÍÓÚáéíóú](?!.*[AaEeIiOoUuÁÉÍÓÚáéíóú])/))?.[0] || '';
    const accented = accentLike(lastVowel || 'i');
    return word + accented;
  });
  return s;
}

function accentLike(ch) {
  const map = {
    'a': 'á', 'e': 'é', 'i': 'í', 'o': 'ó', 'u': 'ú',
    'A': 'Á', 'E': 'É', 'I': 'Í', 'O': 'Ó', 'U': 'Ú',
    'á': 'á', 'é': 'é', 'í': 'í', 'ó': 'ó', 'ú': 'ú',
    'Á': 'Á', 'É': 'É', 'Í': 'Í', 'Ó': 'Ó', 'Ú': 'Ú',
  };
  return map[ch] || 'í';
}

function persistLocalPlaylist() {
  const data = {
    playlists: state.playlists.map(playlist => ({
      id: playlist.id,
      name: playlist.name,
      updatedAt: playlist.updatedAt ?? null,
      tracks: playlist.tracks.map(serializeTrackLocal),
    })),
    activePlaylistId: state.activePlaylistId,
    fadeDuration: state.fadeDuration,
    autoLoop: state.autoLoop,
    shuffle: state.shuffle,
    preferLocalSource: state.preferLocalSource,
    playbackRate: state.playbackRate,
    normalizationEnabled: state.normalizationEnabled,
    autoSync: state.autoSync,
    playlistRev: dropboxPlaylistMeta.rev || null,
    playlistServerModified: dropboxPlaylistMeta.serverModified || null,
    perListMeta: dropboxPerListMeta,
    settingsMeta: dropboxSettingsMeta,
    view: { pageSize: state.viewPageSize, pageIndex: state.viewPageIndex, sort: state.viewSort, minRating: state.viewMinRating },
    pendingDeletions: Array.from(pendingDeletions),
    selectedForSyncIds: Array.from(selectedForSync),
    updatedAt: Date.now(),
  };
  try {
    localStorage.setItem(STORAGE_KEYS.playlist, JSON.stringify(data));
    // Guardar en sidecar también para resiliencia entre versiones
    persistDropboxSidecarState();
  } catch (error) {
    console.warn('No se pudo guardar localmente la lista', error);
  }
  // Persistir preferencias de vista por lista en su propia clave
  try {
    const activeId = state.activePlaylistId;
    if (activeId) {
      viewPerList[activeId] = {
        pageSize: state.viewPageSize,
        pageIndex: state.viewPageIndex,
        sort: state.viewSort || 'none',
        minRating: state.viewMinRating || 0,
      };
    }
    localStorage.setItem(STORAGE_KEYS.viewPerList, JSON.stringify(viewPerList));
  } catch {}
}

function loadLocalPlaylist() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.playlist);
    if (!raw) {
      ensurePlaylistsInitialized();
      return;
    }
    const data = JSON.parse(raw);
    if (Array.isArray(data?.selectedForSyncIds)) {
      selectedForSync = new Set(data.selectedForSyncIds);
    } else {
      selectedForSync = new Set();
    }
    if (Array.isArray(data.pendingDeletions)) {
      pendingDeletions = new Set(data.pendingDeletions);
    }
    if (Number.isFinite(data?.fadeDuration)) {
      state.fadeDuration = data.fadeDuration;
      if (fadeSlider) {
        fadeSlider.value = String(data.fadeDuration);
      }
      fadeValue.textContent = `${state.fadeDuration.toFixed(1).replace(/\.0$/, '')} s`;
    }
    if (typeof data?.autoLoop === 'boolean') {
      state.autoLoop = data.autoLoop;
      if (loopToggle) {
        loopToggle.checked = state.autoLoop;
      }
    }
    if (typeof data?.shuffle === 'boolean') {
      state.shuffle = data.shuffle;
    }
    // uploadOnPlayOnly eliminado: ignorar valor previo si existe
    // downloadOnPlayOnly eliminado: ignorar valor previo si existe
    if (typeof data?.preferLocalSource === 'boolean') {
      state.preferLocalSource = data.preferLocalSource;
      if (preferLocalSourceToggle) {
        preferLocalSourceToggle.checked = state.preferLocalSource;
      }
    } else if (preferLocalSourceToggle) {
      preferLocalSourceToggle.checked = true;
    }
    if (Array.isArray(data?.playlists)) {
      state.playlists = data.playlists.map(playlist => ({
        id: playlist.id || generateId('pl'),
        name: playlist.name || 'Lista',
        updatedAt: playlist.updatedAt ?? null,
        tracks: Array.isArray(playlist.tracks) ? playlist.tracks.map(deserializeTrack) : [],
      }));
      if (data.activePlaylistId && state.playlists.some(pl => pl.id === data.activePlaylistId)) {
        state.activePlaylistId = data.activePlaylistId;
      }
    } else if (Array.isArray(data?.tracks)) {
      const fallback = createPlaylistObject('Lista 1', data.tracks.map(deserializeTrack));
      state.playlists = [fallback];
      state.activePlaylistId = fallback.id;
    }
    ensurePlaylistsInitialized();
    if (data?.playlistRev || data?.playlistServerModified) {
      dropboxPlaylistMeta.rev = data.playlistRev || null;
      dropboxPlaylistMeta.serverModified = data.playlistServerModified || null;
    }
    if (data?.perListMeta && typeof data.perListMeta === 'object') {
      dropboxPerListMeta = data.perListMeta;
    }
    if (data?.settingsMeta && typeof data.settingsMeta === 'object') {
      dropboxSettingsMeta = data.settingsMeta;
    }
    if (data?.view) {
      if (Number.isFinite(data.view.pageSize)) state.viewPageSize = Number(data.view.pageSize);
      if (Number.isFinite(data.view.pageIndex)) state.viewPageIndex = Number(data.view.pageIndex);
      if (pageSizeSelect) pageSizeSelect.value = String(state.viewPageSize || 0);
      if (typeof data.view.sort === 'string') state.viewSort = data.view.sort;
      if (sortSelect) sortSelect.value = state.viewSort || 'none';
      if (Number.isFinite(data.view.minRating)) state.viewMinRating = Number(data.view.minRating) || 0;
      if (minRatingSelect) minRatingSelect.value = String(state.viewMinRating || 0);
    } else if (pageSizeSelect) {
      pageSizeSelect.value = '0';
    }
    if (Number.isFinite(data?.playbackRate)) {
      state.playbackRate = Number(data.playbackRate) || 1;
    }
    if (typeof data?.normalizationEnabled === 'boolean') {
      state.normalizationEnabled = data.normalizationEnabled;
      if (normalizationToggle) normalizationToggle.checked = state.normalizationEnabled;
    } else if (normalizationToggle) {
      normalizationToggle.checked = true;
    }
    if (typeof data?.autoSync === 'boolean') {
      state.autoSync = !!data.autoSync;
      if (autoSyncToggle) autoSyncToggle.checked = state.autoSync;
    } else if (autoSyncToggle) {
      autoSyncToggle.checked = false;
    }
    updateSpeedUI();

    // Migración/merge desde sidecar: prioridad a sidecar si existe
    try {
      const sidecarPendingRaw = localStorage.getItem(STORAGE_KEYS.dropboxPending);
      if (sidecarPendingRaw) {
        const arr = JSON.parse(sidecarPendingRaw);
        if (Array.isArray(arr)) {
          const merged = new Set([
            ...Array.from(pendingDeletions || []),
            ...arr.map(p => String(p).toLowerCase()),
          ]);
          pendingDeletions = merged;
        }
      }
    } catch {}
    try {
      const sidecarMetaRaw = localStorage.getItem(STORAGE_KEYS.dropboxPerListMeta);
      if (sidecarMetaRaw) {
        const meta = JSON.parse(sidecarMetaRaw);
        if (meta && typeof meta === 'object') {
          dropboxPerListMeta = { ...(dropboxPerListMeta || {}), ...meta };
        }
      }
    } catch {}
    try {
      const vRaw = localStorage.getItem(STORAGE_KEYS.viewPerList);
      if (vRaw) {
        const obj = JSON.parse(vRaw);
        if (obj && typeof obj === 'object') {
          viewPerList = obj;
        }
      }
    } catch {}
    // Normaliza y guarda inmediatamente la forma consolidada
    persistDropboxSidecarState();
    // Aplicar preferencias por lista si existen para la activa
    try { loadActiveViewPrefs(); } catch {}
  } catch (error) {
    console.warn('No se pudo leer la lista local', error);
    ensurePlaylistsInitialized();
  }
}

function persistDropboxSidecarState() {
  try {
    if (pendingDeletions && typeof pendingDeletions.forEach === 'function') {
      const arr = Array.from(pendingDeletions).map(p => String(p).toLowerCase());
      localStorage.setItem(STORAGE_KEYS.dropboxPending, JSON.stringify(arr));
    }
  } catch {}
  try {
    if (dropboxPerListMeta && typeof dropboxPerListMeta === 'object') {
      localStorage.setItem(STORAGE_KEYS.dropboxPerListMeta, JSON.stringify(dropboxPerListMeta));
    }
  } catch {}
}

function loadDropboxAuth() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.dropboxAuth);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw);
  } catch (error) {
    console.warn('No se pudo cargar la sesión de Dropbox', error);
    return null;
  }
}

function saveDropboxAuth(auth) {
  dropboxAuth = auth;
  if (!auth) {
    localStorage.removeItem(STORAGE_KEYS.dropboxAuth);
    return;
  }
  localStorage.setItem(STORAGE_KEYS.dropboxAuth, JSON.stringify(auth));
}

function isDropboxConnected() {
  return Boolean(dropboxAuth?.accessToken && dropboxAuth?.refreshToken);
}

function updateDropboxUI() {
  if (!dropboxStatusEl || !cloudSyncCard) {
    return;
  }
  if (!isDropboxConnected()) {
    dropboxStatusEl.textContent = 'Sin conectar';
    dropboxStatusEl.classList.remove('is-error');
    dropboxSyncBtn.hidden = true;
    if (dropboxSyncSelectedBtn) {
      dropboxSyncSelectedBtn.hidden = true;
    }
    dropboxDisconnectBtn.hidden = true;
    if (dropboxRetryFailedBtn) {
      dropboxRetryFailedBtn.hidden = true;
    }
    dropboxConnectBtn.hidden = false;
    cloudSyncCard.classList.remove('is-syncing', 'is-error');
    if (cloudOptionsEl) cloudOptionsEl.hidden = true;
    if (pendingNoticeEl) pendingNoticeEl.hidden = true;
    return;
  }
  if (dropboxState.error) {
    dropboxStatusEl.textContent = 'Error de sincronización';
    dropboxStatusEl.classList.add('is-error');
    cloudSyncCard.classList.add('is-error');
  } else {
    if (dropboxState.isSyncing && dropboxState.progressTotal > 0) {
      dropboxStatusEl.textContent = `Sincronizando… ${Math.min(dropboxState.progressDone, dropboxState.progressTotal)}/${dropboxState.progressTotal}`;
    } else {
      dropboxStatusEl.textContent = dropboxState.isSyncing ? 'Sincronizando…' : 'Conectado';
    }
    dropboxStatusEl.classList.remove('is-error');
    cloudSyncCard.classList.remove('is-error');
  }
  cloudSyncCard.classList.toggle('is-syncing', dropboxState.isSyncing);
  // Barra de progreso visual
  if (dropboxProgressEl && dropboxProgressFillEl) {
    if (dropboxState.isSyncing && dropboxState.progressTotal > 0) {
      const total = Math.max(1, Number(dropboxState.progressTotal) || 0);
      const done = Math.max(0, Math.min(total, Number(dropboxState.progressDone) || 0));
      const pct = Math.round((done / total) * 100);
      dropboxProgressFillEl.style.width = pct + '%';
      dropboxProgressEl.hidden = false;
      dropboxProgressEl.setAttribute('aria-hidden', 'false');
    } else {
      dropboxProgressFillEl.style.width = '0%';
      dropboxProgressEl.hidden = true;
      dropboxProgressEl.setAttribute('aria-hidden', 'true');
    }
  }
  dropboxConnectBtn.hidden = true;
  dropboxSyncBtn.hidden = false;
  dropboxDisconnectBtn.hidden = false;
  dropboxSyncBtn.disabled = dropboxState.isSyncing;
  dropboxDisconnectBtn.disabled = dropboxState.isSyncing;
  if (dropboxTestConnBtn) { dropboxTestConnBtn.hidden = false; dropboxTestConnBtn.disabled = dropboxState.isSyncing; }
  if (cloudOptionsEl) cloudOptionsEl.hidden = false;
  if (autoSyncToggle) autoSyncToggle.checked = !!state.autoSync;
  if (dropboxSyncSelectedBtn) {
    dropboxSyncSelectedBtn.hidden = false;
    const validIds = new Set(state.tracks.map(t => t.id));
    const count = Array.from(selectedForSync).filter(id => validIds.has(id)).length;
    dropboxSyncSelectedBtn.disabled = dropboxState.isSyncing || count === 0;
  }
  if (dropboxRetryFailedBtn) {
    const hasFailed = hasFailedUploads();
    dropboxRetryFailedBtn.hidden = !hasFailed;
    dropboxRetryFailedBtn.disabled = dropboxState.isSyncing || !hasFailed;
  }
  if (dropboxClearPendingBtn) {
    const hasPend = (pendingDeletions && pendingDeletions.size > 0);
    dropboxClearPendingBtn.hidden = false;
    dropboxClearPendingBtn.disabled = dropboxState.isSyncing || !hasPend;
  }
  if (typeof dropboxForceDeleteBtn !== 'undefined' && dropboxForceDeleteBtn) {
    const hasPend = (pendingDeletions && pendingDeletions.size > 0);
    dropboxForceDeleteBtn.hidden = false;
    dropboxForceDeleteBtn.disabled = dropboxState.isSyncing || !hasPend;
  }

  // Aviso de cambios pendientes en modo manual
  if (pendingNoticeEl) {
    const pending = getPendingDropboxChanges();
    if (!dropboxState.isSyncing && !state.autoSync && (pending.uploads > 0 || pending.deletes > 0 || pending.listsChanged > 0)) {
      const parts = [];
      if (pending.uploads > 0) parts.push(`${pending.uploads} subida${pending.uploads !== 1 ? 's' : ''}`);
      if (pending.deletes > 0) parts.push(`${pending.deletes} eliminación${pending.deletes !== 1 ? 'es' : ''}`);
      if (pending.listsChanged > 0) parts.push(`${pending.listsChanged} lista${pending.listsChanged !== 1 ? 's' : ''} modificada${pending.listsChanged !== 1 ? 's' : ''}`);
      if (pendingNoticeTextEl) {
        pendingNoticeTextEl.textContent = `Cambios pendientes: ${parts.join(', ')}.`;
      } else {
        pendingNoticeEl.textContent = `Cambios pendientes: ${parts.join(', ')}.`;
      }
      if (pendingSyncNowBtn) pendingSyncNowBtn.disabled = false;
      pendingNoticeEl.hidden = false;
    } else {
      if (pendingSyncNowBtn) pendingSyncNowBtn.disabled = true;
      pendingNoticeEl.hidden = true;
    }
  }
}

function getPendingDropboxChanges() {
  const uploads = pendingUploads ? pendingUploads.size : 0;
  const deletes = pendingDeletions ? pendingDeletions.size : 0;
  const since = Number(dropboxState?.lastSync) || 0;
  let listsChanged = 0;
  try {
    listsChanged = state.playlists.filter(pl => Number(pl.updatedAt || 0) > since).length;
  } catch { listsChanged = 0; }
  return { uploads, deletes, listsChanged };
}

function showDropboxError(message) {
  if (dropboxStatusEl) {
    dropboxStatusEl.textContent = message;
    dropboxStatusEl.classList.add('is-error');
  }
  if (cloudSyncCard) {
    cloudSyncCard.classList.add('is-error');
  }
}

function hasFailedUploads() {
  return getAllTracks().some(t => !t.dropboxPath && t._sync === 'error');
}

async function beginDropboxAuth() {
  const codeVerifier = await generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const stateToken = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  const sessionPayload = { codeVerifier, state: stateToken, redirectUri: dropboxConfig.redirectUri };
  sessionStorage.setItem(STORAGE_KEYS.dropboxSession, JSON.stringify(sessionPayload));
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: dropboxConfig.clientId,
    redirect_uri: dropboxConfig.redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    token_access_type: 'offline',
    scope: dropboxConfig.scopes,
    state: stateToken,
  });
  window.location.href = `https://www.dropbox.com/oauth2/authorize?${params.toString()}`;
}

async function handleDropboxRedirect() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const stateParam = params.get('state');
  if (!code) {
    return;
  }
  const sessionRaw = sessionStorage.getItem(STORAGE_KEYS.dropboxSession);
  sessionStorage.removeItem(STORAGE_KEYS.dropboxSession);
  if (!sessionRaw) {
    console.warn('No session found for Dropbox redirect');
    return;
  }
  const session = JSON.parse(sessionRaw);
  if (session.state !== stateParam) {
    console.warn('Dropbox state mismatch');
    return;
  }
  try {
    const response = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        code,
        grant_type: 'authorization_code',
        client_id: dropboxConfig.clientId,
        redirect_uri: session.redirectUri,
        code_verifier: session.codeVerifier,
      }),
    });
    if (!response.ok) {
      throw new Error('Token exchange failed');
    }
    const data = await response.json();
    const expiresAt = Date.now() + (Number(data.expires_in) * 1000 - TOKEN_REFRESH_MARGIN);
    saveDropboxAuth({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt,
      accountId: data.account_id,
    });
    dropboxState.error = null;
    updateDropboxUI();
    await performDropboxSync({ loadRemote: true });
  } catch (error) {
    console.error('Error completando autenticación Dropbox', error);
    showDropboxError('Fallo al conectar con Dropbox.');
  } finally {
    params.delete('code');
    params.delete('state');
    params.delete('scope');
    params.delete('token_type');
    const newUrl = `${window.location.pathname}${params.toString() ? `?${params}` : ''}${window.location.hash ?? ''}`;
    window.history.replaceState({}, document.title, newUrl);
  }
}

async function ensureDropboxToken() {
  if (!isDropboxConnected()) {
    return null;
  }
  const now = Date.now();
  if (dropboxAuth.accessToken && dropboxAuth.expiresAt && now < dropboxAuth.expiresAt) {
    return dropboxAuth.accessToken;
  }
  try {
    const response = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: dropboxAuth.refreshToken,
        client_id: dropboxConfig.clientId,
      }),
    });
    if (!response.ok) {
      throw new Error('Refresh token failed');
    }
    const data = await response.json();
    dropboxAuth.accessToken = data.access_token;
    dropboxAuth.expiresAt = Date.now() + (Number(data.expires_in) * 1000 - TOKEN_REFRESH_MARGIN);
    saveDropboxAuth(dropboxAuth);
    dropboxState.error = null;
    return dropboxAuth.accessToken;
  } catch (error) {
    console.error('Error renovando token Dropbox', error);
    disconnectDropbox();
    showDropboxError('Sesión expirada, vuelve a conectar Dropbox.');
    return null;
  }
}

async function performDropboxSync(options = {}) {
  if (!isDropboxConnected()) {
    return;
  }
  // Guardas tempranas
  if (!navigator.onLine) {
    showDropboxError('Sin conexión. Conéctate a Internet.');
    return;
  }
  const nowTs = Date.now();
  if (Number(dropboxState.pausedUntil || 0) > nowTs) {
    const secs = Math.ceil((dropboxState.pausedUntil - nowTs) / 1000);
    showDropboxError(`Red inestable. Reintenta en ${secs}s.`);
    return;
  }
  const effective = {
    loadRemote: Boolean(options.loadRemote),
    onlyTrackIds: Array.isArray(options.onlyTrackIds) ? options.onlyTrackIds.slice() : null,
  };
  if (dropboxState.isSyncing) {
    const queuedIds = new Set([...(dropboxState.syncQueued?.onlyTrackIds || []), ...(effective.onlyTrackIds || [])]);
    dropboxState.syncQueued = {
      loadRemote: effective.loadRemote || Boolean(dropboxState?.syncQueued?.loadRemote),
      onlyTrackIds: Array.from(queuedIds),
    };
    return;
  }
  dropboxState.isSyncing = true;
  dropboxState.error = null;
  // preparar progreso
  // Si es selección manual (onlyTrackIds), el subconjunto puede abarcar todas las listas.
  // Si no, "Sincronizar ahora" debe afectar solo a la lista activa.
  const scopeTracks = effective.onlyTrackIds ? getAllTracks() : (getActivePlaylist()?.tracks || state.tracks || []);
  const baseCandidates = scopeTracks.filter(track => !track.dropboxPath);
  const isManualSubset = !!effective.onlyTrackIds;
  let candidates = isManualSubset ? baseCandidates.filter(t => effective.onlyTrackIds.includes(t.id)) : baseCandidates;
  dropboxState.progressTotal = candidates.length;
  dropboxState.progressDone = 0;
  // marcar en cola
  candidates.forEach(t => { t._sync = 'queued'; });
  renderPlaylist();
  updateDropboxUI();
  try {
    const token = await ensureDropboxToken();
    if (!token) {
      return;
    }
    const perListAvailable = await isPerListModeAvailable(token);
    if (effective.loadRemote) {
      if (perListAvailable) {
        await pullDropboxPlaylistsPerList(token);
        await pullDropboxSettings(token).catch(() => {});
      } else {
        await pullDropboxPlaylist(token);
      }
    }
    await uploadPendingTracks(token, candidates);
    await processPendingDeletions(token);
    // Si aún quedan pendientes tras el batch, intenta borrarlos uno a uno (delete_v2)
    if (pendingDeletions && pendingDeletions.size > 0) {
      await forceDeleteRemainder(token).catch(() => {});
    }
    if (perListAvailable) {
      await saveDropboxPlaylistsPerList(token);
      await saveDropboxSettings(token).catch(() => {});
    } else {
      await saveDropboxPlaylist(token);
    }
    dropboxState.lastSync = Date.now();
    dropboxState.netStrikes = 0;
  } catch (error) {
    console.error('Dropbox sync error', error);
    dropboxState.error = error;
    showDropboxError('No se pudo sincronizar con Dropbox.');
    // Circuit breaker ante errores de red repetidos
    if (isNetworkError(error)) {
      dropboxState.netStrikes = (Number(dropboxState.netStrikes) || 0) + 1;
      if (dropboxState.netStrikes >= 3) {
        dropboxState.pausedUntil = Date.now() + 30000; // 30s
      }
    } else {
      dropboxState.netStrikes = 0;
    }
  } finally {
    dropboxState.isSyncing = false;
    dropboxState.progressTotal = 0;
    dropboxState.progressDone = 0;
    getAllTracks().forEach(t => { if (t._sync && t._sync !== 'error') delete t._sync; });
    updateDropboxUI();
    const queued = dropboxState.syncQueued;
    dropboxState.syncQueued = null;
    if (queued) {
      performDropboxSync(queued).catch(console.error);
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isNetworkError(err) {
  if (!err) return false;
  if (typeof err === 'string' && /NetworkError/i.test(err)) return true;
  const name = err.name || '';
  const msg = err.message || '';
  if (/NetworkError/i.test(name) || /NetworkError/i.test(msg)) return true;
  if (name === 'AbortError') return true; // timeout abort
  return err instanceof TypeError; // fetch falló antes de llegar
}

// Borrado individual de pendientes (delete_v2) para rutas que no lograron eliminarse en batch
async function forceDeleteRemainder(token) {
  const arr = Array.from(pendingDeletions || []);
  if (!arr.length) return;
  const CHUNK = 80;
  for (let i = 0; i < arr.length; i += CHUNK) {
    const slice = arr.slice(i, i + CHUNK);
    for (const path of slice) {
      let attempt = 0;
      const maxRetries = 5;
      while (attempt <= maxRetries) {
        try {
          await awaitDropboxWriteWindow();
          try { console.debug('[DELETE_V2] intentando', path, 'intento', attempt + 1); } catch {}
          const resp = await fetch('https://api.dropboxapi.com/2/files/delete_v2', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ path }),
          });
          if (resp.ok) {
            try { console.debug('[DELETE_V2] eliminado', path); } catch {}
            pendingDeletions.delete(String(path).toLowerCase());
            break;
          }
          const txt = await resp.text().catch(() => '');
          try { console.warn('[DELETE_V2] fallo', path, 'status', resp.status, (txt||'').slice(0,200)); } catch {}
          if (resp.status === 401 && attempt < maxRetries) {
            const fresh = await ensureDropboxToken(true);
            if (fresh) { attempt += 1; continue; }
          }
          if (resp.status === 409 && /not_found|path_lookup/i.test(txt)) {
            try { console.debug('[DELETE_V2] no encontrado, se limpia de pendientes', path); } catch {}
            pendingDeletions.delete(String(path).toLowerCase());
            break;
          }
          const retrySeconds = parseDropboxRetryInfo(resp.status, resp.headers, txt);
          if (retrySeconds && attempt < maxRetries) {
            dropboxWriteAvailableAt = Date.now() + retrySeconds * 1000;
            await sleep(retrySeconds * 1000 + Math.random() * 250);
            attempt += 1;
            continue;
          }
          break;
        } catch (e) {
          try { console.warn('[DELETE_V2] error de red', path, 'intento', attempt + 1, e); } catch {}
          if (attempt >= maxRetries) break;
          await sleep(Math.min(16000, 1000 * Math.pow(2, attempt)) + Math.random() * 300);
          attempt += 1;
        }
      }
    }
    persistLocalPlaylist();
    updateDropboxUI();
    await sleep(150);
  }
}

async function awaitDropboxWriteWindow(minDelayMs = 0) {
  const now = Date.now();
  const waitMs = Math.max(0, dropboxWriteAvailableAt - now, minDelayMs);
  if (waitMs > 0) {
    await sleep(waitMs + Math.random() * 120);
  }
}

function parseDropboxRetryInfo(status, headers, bodyText) {
  let retrySeconds = 0;
  const headerRetry = headers.get && headers.get('Retry-After');
  if (headerRetry) {
    const n = Number(headerRetry);
    if (Number.isFinite(n) && n > 0) retrySeconds = Math.max(retrySeconds, n);
  }
  if (bodyText) {
    try {
      const json = JSON.parse(bodyText);
      const fromBody = Number(json?.error?.retry_after);
      if (Number.isFinite(fromBody) && fromBody > 0) retrySeconds = Math.max(retrySeconds, fromBody);
      const summary = String(json?.error_summary || '');
      if (!retrySeconds && (status === 429 || summary.includes('too_many_write_operations'))) {
        retrySeconds = 1; // fallback mínimo sugerido por el error sample
      }
    } catch {
      // ignore parse errors
    }
  }
  if (!retrySeconds && (status === 429 || status === 503)) {
    retrySeconds = 1;
  }
  return retrySeconds;
}

async function uploadOneTrackWithRetry(token, track) {
  // Preparar archivo a subir
  let file = pendingUploads.get(track.id);
  let uploadName = track.fileName || `${track.id}.mp3`;
  if (!file) {
    const stored = await loadTrackFile(track.id);
    if (stored) {
      const blob = new Blob([stored.buffer], { type: stored.type || 'audio/mpeg' });
      uploadName = track.fileName || stored.name || uploadName;
      if (typeof File === 'function') {
        file = new File([blob], uploadName, {
          type: stored.type || blob.type || 'audio/mpeg',
          lastModified: stored.lastModified || track.lastModified || Date.now(),
        });
      } else {
        file = blob;
      }
    }
  } else if (typeof file.name === 'string') {
    uploadName = file.name;
  }
  if (!file) {
    return;
  }
  const safeName = (uploadName || track.fileName || track.id).replace(/[^a-zA-Z0-9._-]+/g, '_');
  const remotePath = `/tracks/${track.id}-${safeName}`;

  const maxRetries = 6;
  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      await awaitDropboxWriteWindow();
      const CHUNK_THRESHOLD = 8 * 1024 * 1024; // 8 MB
      const useSession = (file.size || 0) > CHUNK_THRESHOLD;
      let metadata = null;
      if (!useSession) {
        const response = await fetch('https://content.dropboxapi.com/2/files/upload', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/octet-stream',
            'Dropbox-API-Arg': JSON.stringify({
              path: remotePath,
              mode: 'overwrite',
              mute: false,
              autorename: false,
            }),
          },
          body: file,
        });

        if (!response.ok) {
          const textResponse = await response.text();
          const retrySeconds = parseDropboxRetryInfo(response.status, response.headers, textResponse);
          if (retrySeconds && attempt < maxRetries) {
            dropboxWriteAvailableAt = Date.now() + retrySeconds * 1000;
            const jitter = Math.random() * 250;
            await sleep(retrySeconds * 1000 + jitter);
            attempt += 1;
            continue;
          }
          throw new Error(textResponse || 'Upload failed');
        }

        metadata = await response.json();
      } else {
        // Resumable upload via upload_session
        const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB
        const total = file.size || 0;
        let offset = 0;
        const firstChunk = file.slice(0, Math.min(CHUNK_SIZE, total));
        let resp = await fetch('https://content.dropboxapi.com/2/files/upload_session/start', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/octet-stream',
            'Dropbox-API-Arg': JSON.stringify({ close: false }),
          },
          body: firstChunk,
        });
        if (!resp.ok) {
          const text = await resp.text();
          const retrySeconds = parseDropboxRetryInfo(resp.status, resp.headers, text);
          if (retrySeconds && attempt < maxRetries) {
            dropboxWriteAvailableAt = Date.now() + retrySeconds * 1000;
            await sleep(retrySeconds * 1000 + Math.random() * 300);
            attempt += 1;
            continue;
          }
          throw new Error(text || 'upload_session/start failed');
        }
        const startInfo = await resp.json();
        const sessionId = startInfo.session_id;
        offset = firstChunk.size;
        while (offset + CHUNK_SIZE < total) {
          const chunk = file.slice(offset, offset + CHUNK_SIZE);
          resp = await fetch('https://content.dropboxapi.com/2/files/upload_session/append_v2', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/octet-stream',
              'Dropbox-API-Arg': JSON.stringify({
                cursor: { session_id: sessionId, offset },
                close: false,
              }),
            },
            body: chunk,
          });
          if (!resp.ok) {
            const text = await resp.text();
            const retrySeconds = parseDropboxRetryInfo(resp.status, resp.headers, text);
            if (retrySeconds && attempt < maxRetries) {
              dropboxWriteAvailableAt = Date.now() + retrySeconds * 1000;
              await sleep(retrySeconds * 1000 + Math.random() * 300);
              attempt += 1;
              // reiniciar todo el intento para simplificar
              continue;
            }
            throw new Error(text || 'upload_session/append_v2 failed');
          }
          offset += chunk.size;
        }
        const lastChunk = file.slice(offset, total);
        resp = await fetch('https://content.dropboxapi.com/2/files/upload_session/finish', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/octet-stream',
            'Dropbox-API-Arg': JSON.stringify({
              cursor: { session_id: sessionId, offset },
              commit: { path: remotePath, mode: 'overwrite', autorename: false, mute: false },
            }),
          },
          body: lastChunk,
        });
        if (!resp.ok) {
          const text = await resp.text();
          const retrySeconds = parseDropboxRetryInfo(resp.status, resp.headers, text);
          if (retrySeconds && attempt < maxRetries) {
            dropboxWriteAvailableAt = Date.now() + retrySeconds * 1000;
            await sleep(retrySeconds * 1000 + Math.random() * 300);
            attempt += 1;
            continue;
          }
          throw new Error(text || 'upload_session/finish failed');
        }
        metadata = await resp.json();
      }

      track.dropboxPath = metadata.path_lower ?? metadata.path_display ?? remotePath;
      track.dropboxRev = metadata.rev;
      track.dropboxSize = metadata.size;
      track.dropboxUpdatedAt = Date.now();
      track.isRemote = true;
      track.urlExpiresAt = 0;
      pendingUploads.delete(track.id);
      persistLocalPlaylist();
      return;
    } catch (error) {
      if (attempt >= maxRetries) {
        console.error(`No se pudo subir ${track.fileName}`, error);
        track._sync = 'error';
        showDropboxError(`Error subiendo ${track.fileName}.`);
        return;
      }
      // Exponential backoff con jitter para errores transitorios sin retry explícito
      const backoffMs = Math.min(16000, 1000 * Math.pow(2, attempt)) + Math.random() * 300;
      await sleep(backoffMs);
      attempt += 1;
    }
  }
}

async function uploadPendingTracks(token, list) {
  let candidates = Array.isArray(list) ? list : getAllTracks().filter(track => !track.dropboxPath);
  if (!candidates.length) return;

  const CONCURRENCY = 1;
  let index = 0;
  const worker = async () => {
    while (true) {
      const i = index;
      index += 1;
      const track = candidates[i];
      if (!track) break;
      track._sync = 'uploading';
      renderPlaylist();
      await uploadOneTrackWithRetry(token, track);
      if (track.dropboxPath) {
        dropboxState.progressDone += 1;
        track._sync = 'done';
      } else {
        track._sync = track._sync || null;
      }
      updateDropboxUI();
      renderPlaylist();
    }
  };
  const workers = Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, () => worker());
  await Promise.all(workers);
  scheduleStorageStatsUpdate();
}

async function saveDropboxPlaylist(token) {
  const payload = {
    version: 2,
    updatedAt: Date.now(),
    activePlaylistId: state.activePlaylistId,
    fadeDuration: state.fadeDuration,
    autoLoop: state.autoLoop,
    shuffle: state.shuffle,
    playbackRate: state.playbackRate,
    normalizationEnabled: state.normalizationEnabled,
    playlists: state.playlists.map(playlist => ({
      id: playlist.id,
      name: playlist.name,
      updatedAt: playlist.updatedAt ?? null,
      tracks: playlist.tracks.map(serializeTrack),
    })),
  };
  const body = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const maxRetries = 5;
  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      await awaitDropboxWriteWindow();
      const modeArg = dropboxPlaylistMeta?.rev ? { ".tag": "update", update: dropboxPlaylistMeta.rev } : 'overwrite';
      const response = await fetch('https://content.dropboxapi.com/2/files/upload', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
          'Dropbox-API-Arg': JSON.stringify({
            path: dropboxConfig.playlistPath,
            mode: modeArg,
            autorename: false,
            mute: true,
          }),
        },
        body,
      });
      if (!response.ok) {
        const text = await response.text();
        if (response.status === 409 && dropboxPlaylistMeta?.rev) {
          // Conflicto de versión: resolver
          const remote = await pullDropboxPlaylistRaw(token).catch(() => null);
          const wantMerge = window.confirm('Conflicto de cambios en la nube. ¿Combinar cambios locales y remotos?\nAceptar: combinar.\nCancelar: elegir versión.');
          if (wantMerge && remote) {
            const merged = mergePlaylistDocuments(payload, remote.doc);
            // Reintenta guardando el merge contra la última rev
            dropboxPlaylistMeta.rev = remote.meta.rev || null;
            return await saveDropboxPlaylistWithPayload(token, merged, dropboxPlaylistMeta.rev);
          } else if (remote) {
            const useCloud = window.confirm('¿Usar la versión de la nube y descartar cambios locales?');
            if (useCloud) {
              applyRemoteDocumentToState(remote.doc);
              persistLocalPlaylist();
              return; // no guardar local por ahora
            } else {
              // Forzar sobrescritura
              dropboxPlaylistMeta.rev = null;
              attempt += 1;
              continue;
            }
          }
        }
        const retrySeconds = parseDropboxRetryInfo(response.status, response.headers, text);
        if (retrySeconds && attempt < maxRetries) {
          dropboxWriteAvailableAt = Date.now() + retrySeconds * 1000;
          await sleep(retrySeconds * 1000 + Math.random() * 250);
          attempt += 1;
          continue;
        }
        throw new Error(text || 'Upload failed');
      }
      const meta = await response.json();
      dropboxPlaylistMeta.rev = meta.rev || dropboxPlaylistMeta.rev || null;
      dropboxPlaylistMeta.serverModified = meta.server_modified || dropboxPlaylistMeta.serverModified || null;
      persistLocalPlaylist();
      return; // success
    } catch (error) {
      if (attempt >= maxRetries) {
        console.error('Error guardando playlist en Dropbox', error);
        throw error;
      }
      await sleep(Math.min(16000, 1000 * Math.pow(2, attempt)) + Math.random() * 300);
      attempt += 1;
    }
  }
}

// Guardar con un payload ya preparado (usado tras un merge)
async function saveDropboxPlaylistWithPayload(token, payload, rev) {
  const body = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const response = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({
        path: dropboxConfig.playlistPath,
        mode: rev ? { ".tag": "update", update: rev } : 'overwrite',
        autorename: false,
        mute: true,
      }),
    },
    body,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || 'Upload failed');
  }
  const meta = await response.json();
  dropboxPlaylistMeta.rev = meta.rev || null;
  dropboxPlaylistMeta.serverModified = meta.server_modified || null;
  persistLocalPlaylist();
}

async function pullDropboxPlaylist(token) {
  try {
    const response = await fetch('https://content.dropboxapi.com/2/files/download', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Dropbox-API-Arg': JSON.stringify({ path: dropboxConfig.playlistPath }),
      },
    });
    if (response.status === 409) {
      // No playlist stored yet
      return;
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || 'Unable to download playlist');
    }
    // Capturar metadata de cabecera para control de versión
    const metaHeader = response.headers.get('dropbox-api-result');
    if (metaHeader) {
      try {
        const m = JSON.parse(metaHeader);
        dropboxPlaylistMeta.rev = m?.rev || dropboxPlaylistMeta.rev || null;
        dropboxPlaylistMeta.serverModified = m?.server_modified || dropboxPlaylistMeta.serverModified || null;
      } catch {}
    }
    const json = await response.json();
    if (Array.isArray(json?.playlists)) {
      const localTrackMap = new Map();
      const localPlaylistMeta = new Map();
      state.playlists.forEach(playlist => {
        localPlaylistMeta.set(playlist.id, { name: playlist.name });
        playlist.tracks.forEach(track => {
          localTrackMap.set(track.id, { track, playlistId: playlist.id });
        });
      });

      const nextPlaylists = [];
      json.playlists.forEach(remotePlaylist => {
        const playlistId = remotePlaylist.id || generateId('pl');
        const playlist = {
          id: playlistId,
          name: remotePlaylist.name || 'Lista',
          tracks: [],
        };
        localPlaylistMeta.delete(playlistId);
        if (Array.isArray(remotePlaylist.tracks)) {
          remotePlaylist.tracks.forEach(entry => {
            if (!entry?.id) {
              return;
            }
            const existingInfo = localTrackMap.get(entry.id);
            let track;
            if (existingInfo) {
              track = existingInfo.track;
              localTrackMap.delete(entry.id);
              if (typeof entry.name === 'string' && entry.name.length) {
                track.name = entry.name;
              }
              if (typeof entry.userRenamed === 'boolean') {
                track.userRenamed = track.userRenamed || entry.userRenamed;
              }
              track.fileName = entry.fileName ?? track.fileName ?? track.name;
              if (Number.isFinite(entry.duration)) {
                track.duration = entry.duration;
              }
              if (Number.isFinite(entry.normalizationGain)) {
                track.normalizationGain = entry.normalizationGain;
              }
              if (Number.isFinite(entry.rating)) {
                track.rating = entry.rating;
              }
            } else {
              track = deserializeTrack(entry);
          }
            if (entry.dropboxPath) {
              track.dropboxPath = entry.dropboxPath;
              track.dropboxRev = entry.dropboxRev ?? track.dropboxRev ?? null;
              track.dropboxSize = entry.dropboxSize ?? track.dropboxSize ?? null;
              track.dropboxUpdatedAt = entry.dropboxUpdatedAt ?? track.dropboxUpdatedAt ?? null;
              track.isRemote = true;
            } else {
              track.dropboxPath = null;
              track.dropboxRev = null;
              track.dropboxSize = null;
              track.dropboxUpdatedAt = null;
              if (!pendingUploads.has(track.id)) {
                track.isRemote = false;
              }
            }
            track.url = null;
            track.urlExpiresAt = 0;
            if (entry.waveform?.peaks?.length) {
              track.waveform = entry.waveform;
            }
            playlist.tracks.push(track);
          });
        }
        nextPlaylists.push(playlist);
      });

      localTrackMap.forEach(({ track, playlistId }) => {
        let playlist = nextPlaylists.find(item => item.id === playlistId);
        if (!playlist) {
          const meta = localPlaylistMeta.get(playlistId);
          const fallbackId = playlistId || generateId('pl');
          playlist = {
            id: fallbackId,
            name: meta?.name || 'Lista local',
            tracks: [],
          };
          nextPlaylists.push(playlist);
        }
        playlist.tracks.push(track);
      });

      localPlaylistMeta.forEach((meta, playlistId) => {
        if (playlistId && !nextPlaylists.some(item => item.id === playlistId)) {
          nextPlaylists.push({
            id: playlistId,
            name: meta?.name || 'Lista local',
            tracks: [],
          });
        }
      });

      state.playlists = nextPlaylists;
      if (json.activePlaylistId && state.playlists.some(pl => pl.id === json.activePlaylistId)) {
        state.activePlaylistId = json.activePlaylistId;
      }
      if (Number.isFinite(json.fadeDuration)) {
        state.fadeDuration = json.fadeDuration;
        if (fadeSlider) {
          fadeSlider.value = String(json.fadeDuration);
        }
      }
      if (typeof json.autoLoop === 'boolean') {
        state.autoLoop = json.autoLoop;
        if (loopToggle) {
          loopToggle.checked = state.autoLoop;
        }
      }
      if (typeof json.shuffle === 'boolean') {
        state.shuffle = json.shuffle;
      }
      if (Number.isFinite(json.playbackRate)) {
        state.playbackRate = Number(json.playbackRate) || 1;
        updateSpeedUI();
      }
      if (typeof json.normalizationEnabled === 'boolean') {
        state.normalizationEnabled = json.normalizationEnabled;
        if (normalizationToggle) normalizationToggle.checked = state.normalizationEnabled;
      }
      // uploadOnPlayOnly eliminado; ignorar si viene en documentos antiguos
      // downloadOnPlayOnly eliminado; ignorar si viene en documentos antiguos
      ensurePlaylistsInitialized();
      fadeValue.textContent = `${state.fadeDuration.toFixed(1).replace(/\.0$/, '')} s`;
      persistLocalPlaylist();
      renderPlaylist();
      updateControls();
      return;
    }

    if (!Array.isArray(json?.tracks)) {
      return;
    }

    const remoteMap = new Map();
    json.tracks.forEach(entry => {
      if (!entry?.id || !entry?.dropboxPath) {
        return;
      }
      remoteMap.set(entry.id, entry);
    });
    const allLocalTracks = getAllTracks();
    const mergedTracks = [];
    json.tracks.forEach(entry => {
      const existing = allLocalTracks.find(track => track.id === entry.id);
      if (existing) {
        existing.dropboxPath = entry.dropboxPath;
        existing.dropboxRev = entry.dropboxRev ?? existing.dropboxRev;
        existing.dropboxSize = entry.dropboxSize ?? existing.dropboxSize;
        existing.dropboxUpdatedAt = entry.dropboxUpdatedAt ?? existing.dropboxUpdatedAt;
        existing.isRemote = true;
        existing.urlExpiresAt = 0;
        existing.url = null;
        if (!existing.duration && entry.duration) {
          existing.duration = entry.duration;
        }
        if (Number.isFinite(entry.normalizationGain)) {
          existing.normalizationGain = entry.normalizationGain;
        }
        if (Number.isFinite(entry.rating)) {
          existing.rating = entry.rating;
        }
        if (entry.waveform?.peaks?.length) {
          existing.waveform = entry.waveform;
        }
        mergedTracks.push(existing);
      } else {
        mergedTracks.push(deserializeTrack(entry));
      }
    });
    const unsynced = allLocalTracks.filter(track => !remoteMap.has(track.id));
    const combined = [...mergedTracks, ...unsynced];
    state.playlists = [createPlaylistObject('Lista Dropbox', combined)];
    state.activePlaylistId = state.playlists[0].id;
    ensurePlaylistsInitialized();
    persistLocalPlaylist();
    renderPlaylist();
    updateControls();
  } catch (error) {
    console.error('Error cargando playlist de Dropbox', error);
    throw error;
  }
}

// Variante raw para obtener doc + meta sin tocar el estado
async function pullDropboxPlaylistRaw(token) {
  const response = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Dropbox-API-Arg': JSON.stringify({ path: dropboxConfig.playlistPath }),
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || 'Unable to download playlist');
  }
  const metaHeader = response.headers.get('dropbox-api-result');
  const meta = { rev: null, server_modified: null };
  if (metaHeader) {
    try {
      const m = JSON.parse(metaHeader);
      meta.rev = m?.rev || null;
      meta.server_modified = m?.server_modified || null;
    } catch {}
  }
  const doc = await response.json();
  return { doc, meta };
}

function applyRemoteDocumentToState(json) {
  if (Array.isArray(json?.playlists)) {
    const localTrackMap = new Map();
    const localPlaylistMeta = new Map();
    state.playlists.forEach(playlist => {
      localPlaylistMeta.set(playlist.id, { name: playlist.name, updatedAt: playlist.updatedAt });
      playlist.tracks.forEach(track => {
        localTrackMap.set(track.id, { track, playlistId: playlist.id });
      });
    });
    const nextPlaylists = [];
    json.playlists.forEach(remotePlaylist => {
      const playlistId = remotePlaylist.id || generateId('pl');
      const playlist = {
        id: playlistId,
        name: remotePlaylist.name || 'Lista',
        updatedAt: remotePlaylist.updatedAt ?? Date.now(),
        tracks: [],
      };
      localPlaylistMeta.delete(playlistId);
      if (Array.isArray(remotePlaylist.tracks)) {
        remotePlaylist.tracks.forEach(entry => {
          if (!entry?.id) return;
          const existingInfo = localTrackMap.get(entry.id);
          let track = existingInfo ? existingInfo.track : deserializeTrack(entry);
          track.name = entry.name || track.name;
          track.fileName = entry.fileName ?? track.fileName ?? track.name;
          if (Number.isFinite(entry.duration)) track.duration = entry.duration;
          if (entry.dropboxPath) {
            track.dropboxPath = entry.dropboxPath;
            track.dropboxRev = entry.dropboxRev ?? track.dropboxRev ?? null;
            track.dropboxSize = entry.dropboxSize ?? track.dropboxSize ?? null;
            track.dropboxUpdatedAt = entry.dropboxUpdatedAt ?? track.dropboxUpdatedAt ?? null;
            track.isRemote = true;
          }
          track.url = null;
          track.urlExpiresAt = 0;
          if (entry.waveform?.peaks?.length) track.waveform = entry.waveform;
          track.updatedAt = entry.updatedAt ?? track.updatedAt ?? null;
          playlist.tracks.push(track);
        });
      }
      nextPlaylists.push(playlist);
    });
    state.playlists = nextPlaylists;
    if (json.activePlaylistId && state.playlists.some(pl => pl.id === json.activePlaylistId)) {
      state.activePlaylistId = json.activePlaylistId;
    }
    if (Number.isFinite(json.fadeDuration)) {
      state.fadeDuration = json.fadeDuration;
      if (fadeSlider) fadeSlider.value = String(json.fadeDuration);
    }
    if (typeof json.autoLoop === 'boolean') {
      state.autoLoop = json.autoLoop;
      if (loopToggle) loopToggle.checked = state.autoLoop;
    }
    if (typeof json.shuffle === 'boolean') state.shuffle = json.shuffle;
    // uploadOnPlayOnly eliminado; ignorar
    // downloadOnPlayOnly eliminado; ignorar
    ensurePlaylistsInitialized();
    fadeValue.textContent = `${state.fadeDuration.toFixed(1).replace(/\.0$/, '')} s`;
    persistLocalPlaylist();
    renderPlaylist();
    updateControls();
  }
}

function mergePlaylistDocuments(localDoc, remoteDoc) {
  const result = {
    version: 2,
    updatedAt: Date.now(),
    activePlaylistId: localDoc.activePlaylistId || remoteDoc.activePlaylistId || null,
    fadeDuration: localDoc.fadeDuration ?? remoteDoc.fadeDuration ?? 3,
    autoLoop: typeof localDoc.autoLoop === 'boolean' ? localDoc.autoLoop : (remoteDoc.autoLoop ?? false),
    shuffle: typeof localDoc.shuffle === 'boolean' ? localDoc.shuffle : (remoteDoc.shuffle ?? false),
    playlists: [],
  };
  const mapRemote = new Map((remoteDoc.playlists || []).map(p => [p.id, p]));
  const mapLocal = new Map((localDoc.playlists || []).map(p => [p.id, p]));
  const ids = new Set([...mapRemote.keys(), ...mapLocal.keys()]);
  ids.forEach(id => {
    const L = mapLocal.get(id);
    const R = mapRemote.get(id);
    if (!L && R) {
      result.playlists.push(R);
    } else if (L && !R) {
      result.playlists.push(L);
    } else if (L && R) {
      const chosenName = (L.updatedAt ?? 0) >= (R.updatedAt ?? 0) ? L.name : R.name;
      const merged = { id, name: chosenName, updatedAt: Math.max(L.updatedAt ?? 0, R.updatedAt ?? 0), tracks: [] };
      const rTracks = new Map((R.tracks || []).map(t => [t.id, t]));
      const lTracks = new Map((L.tracks || []).map(t => [t.id, t]));
      const tids = new Set([...rTracks.keys(), ...lTracks.keys()]);
      tids.forEach(tid => {
        const lt = lTracks.get(tid);
        const rt = rTracks.get(tid);
        if (lt && !rt) merged.tracks.push(lt);
        else if (!lt && rt) merged.tracks.push(rt);
        else if (lt && rt) {
          const pickLocal = (lt.updatedAt ?? 0) >= (rt.updatedAt ?? 0);
          const base = pickLocal ? lt : rt;
          const other = pickLocal ? rt : lt;
          // Combinar algunos campos si faltan
          const combined = {
            ...other,
            ...base,
          };
          merged.tracks.push(combined);
        }
      });
      result.playlists.push(merged);
    }
  });
  return result;
}

async function processPendingDeletions(token) {
  if (!pendingDeletions.size) {
    return;
  }
  // Normalizar a minúsculas y evitar borrar JSON de listas activas (paths deseados actuales)
  try {
    // Normaliza todo el set a minúsculas para evitar duplicados por casing
    pendingDeletions = new Set(Array.from(pendingDeletions).map(p => String(p).toLowerCase()));
    const desiredSet = new Set((state.playlists || []).map(pl => String(getPlaylistPath(pl)).toLowerCase()));
    Array.from(pendingDeletions).forEach(p => {
      if (desiredSet.has(p)) {
        try { console.debug('[DELETE] omitir activo', p); } catch {}
        pendingDeletions.delete(p);
      }
    });
  } catch {}
  const deletions = Array.from(pendingDeletions);
  const CHUNK = 900; // margen bajo límite
  for (let start = 0; start < deletions.length; start += CHUNK) {
    const slice = deletions.slice(start, start + CHUNK).map(path => ({ path }));
    let attempt = 0;
    const maxRetries = 5;
    while (attempt <= maxRetries) {
      try {
        await awaitDropboxWriteWindow();
        const response = await fetch('https://api.dropboxapi.com/2/files/delete_batch', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ entries: slice }),
        });
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          const retrySeconds = parseDropboxRetryInfo(response.status, response.headers, text);
          if (retrySeconds && attempt < maxRetries) {
            dropboxWriteAvailableAt = Date.now() + retrySeconds * 1000;
            await sleep(retrySeconds * 1000 + Math.random() * 250);
            attempt += 1;
            continue;
          }
          throw new Error('delete_batch failed');
        }
        const resJson = await response.json();
        let asyncJobId = resJson?.async_job_id || null;
        if (!asyncJobId && Array.isArray(resJson?.entries)) {
          // respuesta síncrona poco común; procesa entradas
          resJson.entries.forEach(e => {
            if (e['.tag'] === 'success' && e?.metadata?.path_lower) {
              pendingDeletions.delete(e.metadata.path_lower);
            } else if (e['.tag'] === 'failure') {
              try { console.warn('[DELETE_BATCH] fallo entrada', e); } catch {}
            }
          });
          break;
        }
        // poll hasta completar
        while (asyncJobId) {
          await sleep(600);
          const check = await fetch('https://api.dropboxapi.com/2/files/delete_batch/check', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ async_job_id: asyncJobId }),
          });
          if (!check.ok) {
            const text = await check.text().catch(() => '');
            const retrySeconds2 = parseDropboxRetryInfo(check.status, check.headers, text);
            if (retrySeconds2 && attempt < maxRetries) {
              dropboxWriteAvailableAt = Date.now() + retrySeconds2 * 1000;
              await sleep(retrySeconds2 * 1000 + Math.random() * 250);
              attempt += 1;
              continue;
            }
            try { console.warn('[DELETE_BATCH/CHECK] no-OK', check.status, (text||'').slice(0,200)); } catch {}
            throw new Error('delete_batch/check failed');
          }
          const status = await check.json();
          if (status['.tag'] === 'in_progress') {
            continue;
          }
          if (status['.tag'] === 'complete' && Array.isArray(status.entries)) {
            status.entries.forEach(e => {
              if (e['.tag'] === 'success' && e?.metadata?.path_lower) {
                pendingDeletions.delete(e.metadata.path_lower);
              } else if (e['.tag'] === 'failure' && e?.failure?.['.tag'] === 'path_lookup') {
                // no existe; dejar de marcarlo
                const p = e?.failure?.path_lookup?.['.tag'] === 'not_found' ? e?.failure?.path_lookup?.path : null;
                if (p) pendingDeletions.delete(p);
              } else if (e['.tag'] === 'failure') {
                try { console.warn('[DELETE_BATCH] entrada failure', e); } catch {}
              }
            });
          }
          asyncJobId = null;
        }
        break;
      } catch (error) {
        if (attempt >= maxRetries) {
          console.error('No se pudo eliminar archivos en lote en Dropbox', error);
          break;
        }
        await sleep(Math.min(16000, 1000 * Math.pow(2, attempt)) + Math.random() * 300);
        attempt += 1;
      }
    }
  }
  persistLocalPlaylist();
  scheduleStorageStatsUpdate();
}

function disconnectDropbox() {
  try {
    const token = dropboxAuth?.accessToken;
    if (token) {
      fetch('https://api.dropboxapi.com/2/auth/token/revoke', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    }
  } catch {}
  saveDropboxAuth(null);
  dropboxState.error = null;
  dropboxState.isSyncing = false;
  dropboxState.syncQueued = null;
  updateDropboxUI();
}

function requestDropboxSync(options = {}) {
  if (!isDropboxConnected()) {
    return;
  }
  if (!state.autoSync) {
    // Sin auto-sync: solo sincroniza cuando el usuario pulsa los botones explícitos
    return;
  }
  performDropboxSync(options).catch(console.error);
}

async function generateCodeVerifier() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

async function generateCodeChallenge(codeVerifier) {
  const data = new TextEncoder().encode(codeVerifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(buffer) {
  return btoa(String.fromCharCode(...buffer))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function sanitizeFileName(name) {
  const base = (name || 'Lista').toString().trim().slice(0, 100).replace(/\.[a-z0-9]+$/i, '');
  const safe = base.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'Lista';
  return `${safe}.json`;
}

function getPlaylistPath(playlist) {
  const file = sanitizeFileName(playlist.name || 'Lista');
  return `${dropboxConfig.playlistsDir}/${file}`;
}

// ========== Cover art (ID3 APIC) ==========
function getPlaceholderCover(size = 72) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}' viewBox='0 0 ${size} ${size}'>\n<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#dbeafe'/><stop offset='1' stop-color='#bfdbfe'/></linearGradient></defs>\n<rect width='100%' height='100%' rx='${Math.max(4, Math.floor(size*0.1))}' fill='url(#g)'/>\n<text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' font-size='${Math.floor(size*0.55)}' fill='#4a90e2' font-family='Segoe UI, Roboto, Helvetica, Arial, sans-serif'>♪</text>\n</svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}
function readSynchsafeInt(bytes, offset) {
  return (
    (bytes[offset] & 0x7f) << 21 |
    (bytes[offset + 1] & 0x7f) << 14 |
    (bytes[offset + 2] & 0x7f) << 7 |
    (bytes[offset + 3] & 0x7f)
  );
}

function readUInt32BE(bytes, offset) {
  return (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | (bytes[offset + 3]);
}

function readUntilNull(bytes, offset, encodingByte) {
  // encoding 0/3: ISO-8859-1/UTF-8 null-terminated with 0x00
  // encoding 1/2: UTF-16 with BOM/BE, null as 0x00 0x00 (we skip properly by searching for double zero)
  if (encodingByte === 1 || encodingByte === 2) {
    for (let i = offset; i + 1 < bytes.length; i += 2) {
      if (bytes[i] === 0 && bytes[i + 1] === 0) {
        return { end: i + 2 };
      }
    }
    return { end: bytes.length };
  }
  for (let i = offset; i < bytes.length; i += 1) {
    if (bytes[i] === 0) return { end: i + 1 };
  }
  return { end: bytes.length };
}

function extractCoverArtFromArrayBuffer(arrayBuffer) {
  try {
    const bytes = new Uint8Array(arrayBuffer);
    if (bytes.length < 10) return null;
    // ID3v2 at start
    if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) {
      // Try ID3v2.2 'PIC' or skip
      return null;
    }
    const ver = bytes[3]; // 3 for v2.3, 4 for v2.4
    const flags = bytes[5];
    const tagSize = readSynchsafeInt(bytes, 6) + 10;
    let offset = 10;
    if (flags & 0x40) {
      // Extended header present
      if (ver === 4) {
        const extSize = readSynchsafeInt(bytes, offset);
        offset += 4 + extSize;
      } else {
        const extSize = readUInt32BE(bytes, offset);
        offset += 4 + extSize;
      }
    }
    while (offset + 10 <= bytes.length && offset < tagSize) {
      const frameId = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
      let frameSize = ver === 4 ? readSynchsafeInt(bytes, offset + 4) : readUInt32BE(bytes, offset + 4);
      const frameFlags = (bytes[offset + 8] << 8) | bytes[offset + 9];
      offset += 10;
      if (!frameId.trim() || frameSize <= 0) break;
      if (offset + frameSize > bytes.length) break;
      if (frameId === 'APIC') {
        const enc = bytes[offset];
        let i = offset + 1;
        // MIME type null-terminated
        const mimeEnd = readUntilNull(bytes, i, 0).end; // MIME is ISO-8859-1
        const mime = new TextDecoder('iso-8859-1', { fatal: false }).decode(bytes.slice(i, mimeEnd - 1)) || 'image/jpeg';
        i = mimeEnd;
        // Picture type
        const picType = bytes[i];
        i += 1;
        // Description (encoding dependent)
        const descEnd = readUntilNull(bytes, i, enc).end;
        i = descEnd;
        // The rest is image data
        const imgBytes = bytes.slice(i, offset + frameSize);
        const blob = new Blob([imgBytes], { type: mime || 'image/jpeg' });
        return { mimeType: blob.type, blob };
      }
      offset += frameSize;
    }
  } catch (e) {
    // ignore parsing errors
  }
  return null;
}

// ========== ID3 text (TIT2/TPE1/TALB) ==========
function decodeId3Text(bytes, offset, size) {
  if (size <= 1) return '';
  const enc = bytes[offset];
  const body = bytes.slice(offset + 1, offset + size);
  let label = 'iso-8859-1';
  if (enc === 1) label = 'utf-16';
  else if (enc === 2) label = 'utf-16be';
  else if (enc === 3) label = 'utf-8';
  let text = '';
  try { text = new TextDecoder(label, { fatal: false }).decode(body); } catch {}
  return (text || '').replace(/\u0000+/g, '').trim();
}

function extractId3TextFrames(arrayBuffer) {
  try {
    const bytes = new Uint8Array(arrayBuffer);
    if (bytes.length < 10) return null;
    if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return null;
    const ver = bytes[3];
    const flags = bytes[5];
    const tagSize = readSynchsafeInt(bytes, 6) + 10;
    let offset = 10;
    if (flags & 0x40) {
      if (ver === 4) {
        const extSize = readSynchsafeInt(bytes, offset);
        offset += 4 + extSize;
      } else {
        const extSize = readUInt32BE(bytes, offset);
        offset += 4 + extSize;
      }
    }
    const out = { title: '', artist: '', album: '' };
    while (offset + 10 <= bytes.length && offset < tagSize) {
      const frameId = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
      let frameSize = ver === 4 ? readSynchsafeInt(bytes, offset + 4) : readUInt32BE(bytes, offset + 4);
      offset += 10;
      if (!frameId.trim() || frameSize <= 0) break;
      if (offset + frameSize > bytes.length) break;
      if (frameId === 'TIT2' || frameId === 'TPE1' || frameId === 'TALB') {
        const val = decodeId3Text(bytes, offset, frameSize);
        if (frameId === 'TIT2' && val) out.title = val;
        if (frameId === 'TPE1' && val) out.artist = val;
        if (frameId === 'TALB' && val) out.album = val;
      }
      offset += frameSize;
    }
    return out;
  } catch {
    return null;
  }
}

async function ensureCoverArt(track) {
  try {
    // Si ya hay carátula pero el título parece roto, seguimos para intentar extraer el título ID3.
    if (!track) return false;
    const needTitleFix = isNameMojibake(track.name || '');
    if (track.coverUrl && !needTitleFix) return false;
    let buffer = null;
    const file = pendingUploads.get(track.id);
    if (file) {
      buffer = await file.arrayBuffer();
    } else {
      const stored = await loadTrackFile(track.id);
      if (stored?.buffer) {
        buffer = stored.buffer;
      } else if ((track.isRemote || track.dropboxPath)) {
        // Evitar tormenta de peticiones si hay backoff o concurrencia llena
        const now = Date.now();
        if ((now < dropboxReadAvailableAt) || dropboxReadInFlight >= DROPBOX_READ_CONCURRENCY) {
          return false;
        }
        if (remoteLinkInFlight.has(track.id)) {
          return false;
        }
        const ready = await ensureTrackRemoteLink(track);
        if (!ready) return false;
        // Prefer leer de IDB para no volver a descargar
        const again = await loadTrackFile(track.id);
        if (again?.buffer) buffer = again.buffer;
        if (!buffer && track.url) {
          const resp = await fetch(track.url);
          if (resp.ok) buffer = await resp.arrayBuffer();
        }
      } else if (track.url && track.url.startsWith('blob:')) {
        try { const resp = await fetch(track.url); if (resp.ok) buffer = await resp.arrayBuffer(); } catch {}
      }
    }
    if (!buffer) return false;
    // Extraer título del ID3 si existe y actualizar nombre visible
    const tags = extractId3TextFrames(buffer);
    if (tags && tags.title && !track.userRenamed) {
      const clean = applySpanishHeuristics(repairMojibake(tags.title)).trim();
      if (clean && clean !== track.name) {
        track.name = clean;
        track.updatedAt = Date.now();
        renderPlaylist();
        updateNowPlaying();
        persistLocalPlaylist();
      }
    }

    const art = extractCoverArtFromArrayBuffer(buffer);
    if (!art || !art.blob) return false;
    if (track.coverUrl) { try { URL.revokeObjectURL(track.coverUrl); } catch {} }
    track.coverUrl = URL.createObjectURL(art.blob);
    updateCoverArtDisplay(track);
    updateTrackThumbnails(track);
    return true;
  } catch {
    return false;
  }
}

function updateCoverArtDisplay(track) {
  if (!coverArtImg) return;
  if (!track || !track.coverUrl) {
    coverArtImg.src = getPlaceholderCover(72);
    coverArtImg.hidden = false;
    nowPlayingSectionEl?.classList.remove('has-cover');
    nowPlayingRowEl?.classList.remove('has-cover');
    return;
  }
  coverArtImg.src = track.coverUrl;
  coverArtImg.hidden = false;
  nowPlayingSectionEl?.classList.add('has-cover');
  nowPlayingRowEl?.classList.add('has-cover');
}

// ========= Normalización de volumen =========
const NORMALIZATION_TARGET_PEAK = 0.9; // objetivo relativo [0..1]
const NORMALIZATION_MAX_GAIN = 3.16; // ~ +10 dB

function computeNormalizationFromPeaks(peaks) {
  if (!Array.isArray(peaks) || !peaks.length) return 1;
  let maxAbs = 0;
  for (let i = 0; i < peaks.length; i += 1) {
    const p = peaks[i];
    const hi = Math.max(Math.abs(p[0] || 0), Math.abs(p[1] || 0));
    if (hi > maxAbs) maxAbs = hi;
  }
  if (!Number.isFinite(maxAbs) || maxAbs <= 0) return 1;
  const gain = NORMALIZATION_TARGET_PEAK / maxAbs;
  return Math.min(Math.max(gain, 0.25), NORMALIZATION_MAX_GAIN);
}

function updateNowRatingUI() {
  if (!nowRatingEl) return;
  const track = state.tracks[state.currentIndex];
  if (!track) {
    nowRatingEl.hidden = true;
    return;
  }
  nowRatingEl.hidden = false;
  const rating = Number(track.rating) || 0;
  const buttons = nowRatingEl.querySelectorAll('button.star-button');
  buttons.forEach((btn, idx) => {
    const val = idx + 1;
    btn.textContent = val <= rating ? '★' : '☆';
    btn.setAttribute('aria-pressed', val <= rating ? 'true' : 'false');
    btn.disabled = false;
  });
}

function openCoverLightbox(src) {
  if (!coverLightboxEl || !coverLightboxImg) return;
  coverLightboxImg.src = src || coverArtImg?.src || '';
  coverLightboxEl.hidden = false;
}

function closeCoverLightbox() {
  if (!coverLightboxEl) return;
  coverLightboxEl.hidden = true;
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log10(n) / 3));
  const v = n / Math.pow(1000, i);
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

function scheduleStorageStatsUpdate(delay = 200) {
  if (storageStatsTimer) clearTimeout(storageStatsTimer);
  storageStatsTimer = setTimeout(() => {
    storageStatsTimer = null;
    computeAndRenderStorageStats().catch(console.error);
  }, delay);
}

async function computeAndRenderStorageStats() {
  try {
    const seen = new Set();
    let cloudBytes = 0;
    getAllTracks().forEach(t => {
      if (t.dropboxPath && !seen.has(t.dropboxPath)) {
        seen.add(t.dropboxPath);
        if (Number.isFinite(t.dropboxSize)) cloudBytes += t.dropboxSize;
      }
    });
    if (dropboxUsageEl) dropboxUsageEl.textContent = `${formatBytes(cloudBytes)} (${seen.size} pistas)`;

    let localBytes = 0;
    const db = await openMediaDatabase();
    if (db) {
      localBytes = await new Promise(resolve => {
        const tx = db.transaction(IDB_CONFIG.store, 'readonly');
        const req = tx.objectStore(IDB_CONFIG.store).getAll();
        req.onsuccess = () => {
          const arr = Array.isArray(req.result) ? req.result : [];
          const sum = arr.reduce((acc, r) => acc + (r?.size || (r?.buffer?.byteLength || 0)), 0);
          resolve(sum);
        };
        req.onerror = () => resolve(0);
      });
    }
    if (localUsageEl) localUsageEl.textContent = `${formatBytes(localBytes)}`;
  } catch (e) {
    console.warn('storage stats error', e);
  }
}

function updateTrackThumbnails(track) {
  if (!track || !track.coverUrl || !playlistEl) return;
  const nodes = playlistEl.querySelectorAll(`li.track[data-track-id="${track.id}"] img.track-thumb`);
  nodes.forEach(img => {
    img.src = track.coverUrl || getPlaceholderCover(48);
    img.hidden = false;
  });
}

function updatePagerUI() {
  if (!pagerEl || !pagerPrevBtn || !pagerNextBtn || !pagerInfoEl) return;
  const total = buildViewOrder().length;
  const size = Math.max(0, Number(state.viewPageSize) || 0);
  if (!size || total <= size) {
    pagerEl.hidden = true;
    return;
  }
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(Math.max(0, state.viewPageIndex || 0), pages - 1);
  const start = page * size + 1;
  const end = Math.min(total, (page + 1) * size);
  pagerInfoEl.textContent = `Mostrando ${start}–${end} de ${total}`;
  pagerPrevBtn.disabled = page <= 0;
  pagerNextBtn.disabled = page >= pages - 1;
  pagerEl.hidden = false;
}

// === Media Session API integration (lock screen / notifications) ===
function hasMediaSession() {
  return typeof navigator !== 'undefined' && 'mediaSession' in navigator;
}

function setupMediaSession() {
  if (!hasMediaSession() || mediaSessionSetup) return;
  mediaSessionSetup = true;
  const ms = navigator.mediaSession;
  try { ms.setActionHandler('play', () => handleMediaPlay()); } catch {}
  try { ms.setActionHandler('pause', () => handleMediaPause()); } catch {}
  try { ms.setActionHandler('stop', () => stopPlayback()); } catch {}
  try { ms.setActionHandler('previoustrack', () => { const i = getPrevIndex(); if (i !== -1) playTrack(i).catch(console.error); }); } catch {}
  try { ms.setActionHandler('nexttrack', () => { const i = getNextIndex(); if (i !== -1) playTrack(i).catch(console.error); }); } catch {}
  try { ms.setActionHandler('seekbackward', (details) => seekRelative(-(details?.seekOffset || 10))); } catch {}
  try { ms.setActionHandler('seekforward', (details) => seekRelative(+(details?.seekOffset || 10))); } catch {}
  try { ms.setActionHandler('seekto', (details) => seekTo(details?.seekTime)); } catch {}
}

function handleMediaPlay() {
  if (state.currentIndex === -1) {
    const start = getNextIndex();
    if (start !== -1) {
      playTrack(start).catch(console.error);
    }
    return;
  }
  const p = players[activePlayerIndex];
  if (!p) return;
  ensureContextRunning()
    .then(() => p.audio.play())
    .then(() => {
      state.isPlaying = true;
      scheduleAutoAdvance(p, state.currentIndex);
      updateControls();
      updateMediaSessionPlaybackState();
    })
    .catch(console.error);
}

function handleMediaPause() {
  const p = players[activePlayerIndex];
  if (!p) return;
  p.audio.pause();
  state.isPlaying = false;
  cancelAutoAdvance(p);
  updateControls();
  updateMediaSessionPlaybackState();
}

function seekRelative(seconds) {
  const p = players[activePlayerIndex];
  if (!p) return;
  if (!Number.isFinite(p.audio.currentTime)) return;
  const dur = Number.isFinite(p.audio.duration) ? p.audio.duration : 0;
  const next = Math.max(0, Math.min(dur || Infinity, (p.audio.currentTime || 0) + (Number(seconds) || 0)));
  p.audio.currentTime = next;
  updateMediaSessionPosition(p);
}

function seekTo(position) {
  const p = players[activePlayerIndex];
  if (!p || !Number.isFinite(position)) return;
  const dur = Number.isFinite(p.audio.duration) ? p.audio.duration : 0;
  const pos = Math.max(0, Math.min(dur || Infinity, Number(position)));
  p.audio.currentTime = pos;
  updateMediaSessionPosition(p);
}

function updateMediaSessionMetadata(track) {
  if (!hasMediaSession()) return;
  const t = track || state.tracks[state.currentIndex] || null;
  if (!t) {
    try { navigator.mediaSession.metadata = null; } catch {}
    return;
  }
  const artwork = [];
  if (t.coverUrl) artwork.push({ src: t.coverUrl, sizes: '512x512', type: 'image/png' });
  artwork.push({ src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' });
  artwork.push({ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' });
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: getCleanTrackName(t) || 'Pista',
      artist: '',
      album: 'EduMix',
      artwork,
    });
  } catch {}
}

function updateMediaSessionPlaybackState() {
  if (!hasMediaSession()) return;
  try {
    if (state.currentIndex === -1) {
      navigator.mediaSession.playbackState = 'none';
    } else {
      navigator.mediaSession.playbackState = state.isPlaying ? 'playing' : 'paused';
    }
  } catch {}
}

function updateMediaSessionPosition(player) {
  if (!hasMediaSession() || typeof navigator.mediaSession.setPositionState !== 'function') return;
  const p = player || players[activePlayerIndex];
  if (!p || !p.audio) return;
  const duration = Number.isFinite(p.audio.duration) ? p.audio.duration : 0;
  if (!duration) return;
  try {
    navigator.mediaSession.setPositionState({
      duration,
      playbackRate: Number(state.playbackRate) || 1,
      position: Math.max(0, Number(p.audio.currentTime) || 0),
    });
  } catch {}
}

function updateSpeedUI() {
  const rate = Number(state.playbackRate) || 1;
  if (speedSlider && String(speedSlider.value) !== String(rate)) {
    speedSlider.value = String(rate);
  }
  if (speedValue) {
    const txt = rate.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1') + '×';
    speedValue.textContent = txt;
  }
  // aplicar a players activos por si no estaban sincronizados
  players.forEach(p => { try { p.audio.playbackRate = rate; } catch {} });
}

function setPlaybackRate(rate) {
  const clamped = Math.max(0.5, Math.min(1.5, Math.round((Number(rate) || 1) * 100) / 100));
  if (state.playbackRate === clamped) return;
  state.playbackRate = clamped;
  updateSpeedUI();
  persistLocalPlaylist();
}

function nudgePlaybackRate(delta) {
  setPlaybackRate((Number(state.playbackRate) || 1) + (Number(delta) || 0));
}

function updateNormalizationLive() {
  if (!state.normalizationEnabled) {
    // subir a 1× de forma suave
    if (state.currentIndex >= 0 && players.length) {
      const p = players[activePlayerIndex];
      const now = getAudioContext().currentTime;
      try {
        p.gain.gain.cancelScheduledValues(now);
        p.gain.gain.linearRampToValueAtTime(1, now + 0.1);
      } catch {}
    }
    return;
  }
  const track = state.tracks[state.currentIndex];
  if (!track) return;
  const baseGain = Number.isFinite(track.normalizationGain) && track.normalizationGain > 0 ? track.normalizationGain : 1;
  if (players.length) {
    const p = players[activePlayerIndex];
    const now = getAudioContext().currentTime;
    try {
      p.gain.gain.cancelScheduledValues(now);
      p.gain.gain.linearRampToValueAtTime(baseGain, now + 0.12);
    } catch {}
  }
}

async function initialize() {
  loadLocalPlaylist();
  await restoreLocalMedia();
  const allTracks = getAllTracks();
  await Promise.allSettled(allTracks.filter(track => !track.dropboxPath).map(track => ensureLocalTrackUrl(track)));
  renderPlaylist();
  updateControls();
  setupMediaSession();
  updateMediaSessionMetadata();
  updateMediaSessionPlaybackState();
  scheduleWaveformResize();
  // Click para buscar en la forma de onda
  waveformCanvas?.addEventListener('click', (e) => {
    e.preventDefault();
    handleWaveformClick(e);
  });
  fadeValue.textContent = `${state.fadeDuration.toFixed(1).replace(/\.0$/, '')} s`;
  if (isDropboxConnected()) {
    performDropboxSync({ loadRemote: true }).catch(console.error);
  }
  scheduleStorageStatsUpdate(0);
  updateSpeedUI();
  // Lightbox handlers
  // Reparar nombres con mojibake usando ID3 si es posible
  try {
    const broken = allTracks.filter(t => isNameMojibake(t.name || ''));
    if (broken.length) {
      broken.forEach(t => { ensureCoverArt(t).catch(() => {}); });
    }
  } catch {}
  
  // Lightbox handlers
  coverArtImg?.addEventListener('click', () => {
    if (!coverArtImg.src) return;
    openCoverLightbox(coverArtImg.src);
  });
  coverLightboxEl?.addEventListener('click', () => closeCoverLightbox());
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeCoverLightbox();
    // Atajos de valoración rápida: teclas 1..5
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      if (/^[1-5]$/.test(e.key) && state.currentIndex >= 0) {
        const tag = (e.target && e.target.tagName) ? String(e.target.tagName).toLowerCase() : '';
        if (tag !== 'input' && tag !== 'textarea' && tag !== 'select' && !(e.target && e.target.isContentEditable)) {
          setTrackRating(state.currentIndex, Number(e.key));
          updateNowRatingUI();
        }
      }
      // Atajos de velocidad: +/- y R para reset
      const tag = (e.target && e.target.tagName) ? String(e.target.tagName).toLowerCase() : '';
      const isTyping = tag === 'input' || tag === 'textarea' || tag === 'select' || (e.target && e.target.isContentEditable);
      if (!isTyping) {
        // reset a 1×
        if (e.key === 'r' || e.key === 'R') {
          e.preventDefault();
          setPlaybackRate(1);
          return;
        }
        // subir velocidad
        if (e.key === '+' || (e.key === '=' && e.shiftKey) || e.key === 'Add') {
          e.preventDefault();
          nudgePlaybackRate(0.01);
          return;
        }
        // bajar velocidad
        if (e.key === '-' || e.key === '_' || e.key === 'Subtract') {
          e.preventDefault();
          nudgePlaybackRate(-0.01);
          return;
        }
      }
    }
  });
  // Click en estrellas de "Reproducción"
  nowRatingEl?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button.star-button');
    if (!btn) return;
    const val = Number(btn.dataset.value) || 0;
    if (state.currentIndex >= 0) {
      setTrackRating(state.currentIndex, val);
      updateNowRatingUI();
    }
  });
}

handleDropboxRedirect().catch(console.error).finally(() => {
  initialize().catch(console.error);
});

// ============ Per-list Dropbox support ============
async function isPerListModeAvailable(token) {
  try {
    const response = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ path: dropboxConfig.playlistsDir, recursive: false, limit: 2 }),
    });
    if (response.status === 409) {
      return false;
    }
    if (!response.ok) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function ensurePlaylistsFolder(token) {
  try {
    const response = await fetch('https://api.dropboxapi.com/2/files/create_folder_v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ path: dropboxConfig.playlistsDir, autorename: false }),
    });
    if (response.ok) return true;
    if (response.status === 409) return true; // ya existe
  } catch {}
  return false;
}

async function pullDropboxPlaylistsPerList(token) {
  try {
    const response = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ path: dropboxConfig.playlistsDir, recursive: false }),
    });
    if (response.status === 409) {
      // No existe la carpeta
      return;
    }
    if (!response.ok) {
      const txt = await response.text().catch(() => '');
      throw new Error(txt || 'list_folder failed');
    }
    const listing = await response.json();
    const entries = Array.isArray(listing?.entries) ? listing.entries : [];
    const jsonFiles = entries.filter(e => e['.tag'] === 'file' && typeof e?.path_lower === 'string' && e.name.toLowerCase().endsWith('.json') && e.name !== '_settings.json');
    const downloaded = [];
    for (const file of jsonFiles) {
      const path = file.path_lower || file.path_display;
      const resp = await fetch('https://content.dropboxapi.com/2/files/download', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Dropbox-API-Arg': JSON.stringify({ path }) },
      });
      if (!resp.ok) continue;
      const metaHeader = resp.headers.get('dropbox-api-result');
      let meta = {};
      try { meta = JSON.parse(metaHeader || '{}'); } catch {}
      const doc = await resp.json().catch(() => null);
      if (doc && doc.id) {
        downloaded.push({ path, meta, doc });
      }
    }
    if (!downloaded.length) return;
    const mapLocalTracks = new Map();
    const mapLocalPlaylistMeta = new Map();
    state.playlists.forEach(pl => {
      mapLocalPlaylistMeta.set(pl.id, { name: pl.name, updatedAt: pl.updatedAt });
      pl.tracks.forEach(t => mapLocalTracks.set(t.id, { track: t, playlistId: pl.id }));
    });
    const nextPlaylists = [];
    downloaded.forEach(({ path, meta, doc }) => {
      const id = doc.id || generateId('pl');
      const playlist = { id, name: doc.name || 'Lista', updatedAt: doc.updatedAt ?? Date.now(), tracks: [] };
      dropboxPerListMeta[id] = { path, rev: meta?.rev || null, serverModified: meta?.server_modified || null };
      if (Array.isArray(doc.tracks)) {
        doc.tracks.forEach(entry => {
          if (!entry?.id) return;
          const existing = mapLocalTracks.get(entry.id)?.track;
          const track = existing ? existing : deserializeTrack(entry);
          if (typeof entry.name === 'string' && entry.name.length) {
            track.name = entry.name;
          }
          if (typeof entry.userRenamed === 'boolean') {
            track.userRenamed = track.userRenamed || entry.userRenamed;
          }
          track.fileName = entry.fileName ?? track.fileName ?? track.name;
          if (Number.isFinite(entry.duration)) track.duration = entry.duration;
          if (Number.isFinite(entry.normalizationGain)) track.normalizationGain = entry.normalizationGain;
          if (Number.isFinite(entry.rating)) track.rating = entry.rating;
          if (entry.dropboxPath) {
            track.dropboxPath = entry.dropboxPath;
            track.dropboxRev = entry.dropboxRev ?? track.dropboxRev ?? null;
            track.dropboxSize = entry.dropboxSize ?? track.dropboxSize ?? null;
            track.dropboxUpdatedAt = entry.dropboxUpdatedAt ?? track.dropboxUpdatedAt ?? null;
            track.isRemote = true;
          }
          track.url = null;
          track.urlExpiresAt = 0;
          if (entry.waveform?.peaks?.length) track.waveform = entry.waveform;
          track.updatedAt = entry.updatedAt ?? track.updatedAt ?? null;
          playlist.tracks.push(track);
        });
      }
      nextPlaylists.push(playlist);
    });
    // Incorporar listas locales que no están en remoto
    mapLocalPlaylistMeta.forEach((meta, pid) => {
      if (!nextPlaylists.some(p => p.id === pid)) {
        const pl = state.playlists.find(p => p.id === pid);
        if (pl) nextPlaylists.push(pl);
      }
    });
    state.playlists = nextPlaylists;
    ensurePlaylistsInitialized();
    persistLocalPlaylist();
    renderPlaylistPicker();
    renderPlaylist();
    updateControls();
  } catch (e) {
    console.error('Error pull per-list', e);
    throw e;
  }
}

async function saveDropboxPlaylistsPerList(token) {
  await ensurePlaylistsFolder(token);
  // Evita repetir intentos de move_v2 en el mismo ciclo de vida
  const moveTried = new Set();
  for (const pl of state.playlists) {
    const payload = {
      version: 2,
      id: pl.id,
      name: pl.name,
      updatedAt: pl.updatedAt ?? Date.now(),
      tracks: pl.tracks.map(serializeTrack),
    };
    const body = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const desiredPath = getPlaylistPath(pl);
    const meta = dropboxPerListMeta[pl.id] || { path: desiredPath, rev: null };
    const pathChanged = meta.path && meta.path !== desiredPath;
    const lcDesired = String(desiredPath).toLowerCase();
    const lcPrev = String(meta.path || '').toLowerCase();
    // Si solo cambió el nombre (ruta), intenta un rename/move una vez
    if (pathChanged && meta.path && lcDesired !== lcPrev && !moveTried.has(pl.id)) {
      try {
        const moveResp = await fetch('https://api.dropboxapi.com/2/files/move_v2', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ from_path: meta.path, to_path: desiredPath, autorename: false, allow_shared_folder: true, allow_ownership_transfer: false }),
        });
        moveTried.add(pl.id);
        if (moveResp.ok) {
          const mv = await moveResp.json().catch(() => null);
          const md = mv && (mv.metadata || mv);
          const newRev = md?.rev || null;
          const serverModified = md?.server_modified || null;
          dropboxPerListMeta[pl.id] = { path: desiredPath, rev: newRev, serverModified };
        } else if (moveResp.status === 409) {
          // Conflicto: asume que el destino ya existe o el origen no existe
          // Continúa con upload en desiredPath y marca el antiguo para borrar
          dropboxPerListMeta[pl.id] = { path: desiredPath, rev: null, serverModified: null };
          pendingDeletions.add(lcPrev);
        }
      } catch {}
    }
    let attempt = 0;
    const maxRetries = 5;
    while (attempt <= maxRetries) {
      try {
        await awaitDropboxWriteWindow();
        // Evitar update con rev antigua si cambió el path
        const current = dropboxPerListMeta[pl.id] || meta;
        const modeArg = (current.rev ? { '.tag': 'update', update: current.rev } : 'overwrite');
        const response = await fetch('https://content.dropboxapi.com/2/files/upload', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/octet-stream',
            'Dropbox-API-Arg': JSON.stringify({
              path: desiredPath,
              mode: modeArg,
              autorename: false,
              mute: true,
            }),
          },
          body,
        });
        if (!response.ok) {
          const text = await response.text();
          if (response.status === 409) {
            // Intento de resolución de conflicto: consulta metadata y reintenta
            try {
              const mresp = await fetch('https://api.dropboxapi.com/2/files/get_metadata', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ path: desiredPath, include_deleted: false }),
              });
              if (mresp.ok) {
                const md = await mresp.json();
                if (md && md['.tag'] === 'file' && md.rev) {
                  dropboxPerListMeta[pl.id] = { path: desiredPath, rev: md.rev, serverModified: md.server_modified || null };
                  attempt += 1;
                  await sleep(200 + Math.random() * 200);
                  continue;
                }
              } else {
                const txt = await mresp.text().catch(() => '');
                if (/not_found/i.test(txt)) {
                  // Forzar overwrite sin rev en próximo intento
                  dropboxPerListMeta[pl.id] = { path: desiredPath, rev: null, serverModified: null };
                  attempt += 1;
                  await sleep(200 + Math.random() * 200);
                  continue;
                }
              }
            } catch {}
            // Como último recurso, limpiar rev local para forzar overwrite
            if (dropboxPerListMeta[pl.id]?.rev) {
              dropboxPerListMeta[pl.id].rev = null;
              attempt += 1;
              await sleep(200 + Math.random() * 200);
              continue;
            }
          }
          const retrySeconds = parseDropboxRetryInfo(response.status, response.headers, text);
          if (retrySeconds && attempt < maxRetries) {
            dropboxWriteAvailableAt = Date.now() + retrySeconds * 1000;
            await sleep(retrySeconds * 1000 + Math.random() * 250);
            attempt += 1;
            continue;
          }
          throw new Error(text || 'Upload failed');
        }
        const metaJson = await response.json();
        dropboxPerListMeta[pl.id] = { path: desiredPath, rev: metaJson.rev || null, serverModified: metaJson.server_modified || null };
        // Si no se pudo mover antes y el path antiguo persiste diferente (no sólo por mayúsculas/minúsculas), programar borrado
        if (pathChanged && meta.path && (lcDesired !== lcPrev)) {
          pendingDeletions.add(lcPrev);
        }
        break;
      } catch (err) {
        if (attempt >= maxRetries) throw err;
        await sleep(Math.min(16000, 1000 * Math.pow(2, attempt)) + Math.random() * 300);
        attempt += 1;
      }
    }
  }
  persistLocalPlaylist();
}

async function saveDropboxSettings(token) {
  const payload = {
    version: 1,
    updatedAt: Date.now(),
    activePlaylistId: state.activePlaylistId,
    fadeDuration: state.fadeDuration,
    autoLoop: state.autoLoop,
    shuffle: state.shuffle,
    preferLocalSource: state.preferLocalSource,
    playbackRate: state.playbackRate,
    normalizationEnabled: state.normalizationEnabled,
    autoSync: !!state.autoSync,
  };
  const body = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const response = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({
        path: dropboxConfig.settingsPath,
        mode: dropboxSettingsMeta?.rev ? { '.tag': 'update', update: dropboxSettingsMeta.rev } : 'overwrite',
        autorename: false,
        mute: true,
      }),
    },
    body,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || 'Upload settings failed');
  }
  const meta = await response.json();
  dropboxSettingsMeta.rev = meta.rev || null;
  dropboxSettingsMeta.serverModified = meta.server_modified || null;
  persistLocalPlaylist();
}

async function pullDropboxSettings(token) {
  const response = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Dropbox-API-Arg': JSON.stringify({ path: dropboxConfig.settingsPath }) },
  });
  if (!response.ok) return;
  const metaHeader = response.headers.get('dropbox-api-result');
  if (metaHeader) {
    try { const m = JSON.parse(metaHeader); dropboxSettingsMeta.rev = m?.rev || null; dropboxSettingsMeta.serverModified = m?.server_modified || null; } catch {}
  }
  const json = await response.json().catch(() => null);
  if (!json) return;
  if (json.activePlaylistId && state.playlists.some(pl => pl.id === json.activePlaylistId)) state.activePlaylistId = json.activePlaylistId;
  if (Number.isFinite(json.fadeDuration)) { state.fadeDuration = json.fadeDuration; if (fadeSlider) fadeSlider.value = String(json.fadeDuration); fadeValue.textContent = `${state.fadeDuration.toFixed(1).replace(/\.0$/, '')} s`; }
  if (typeof json.autoLoop === 'boolean') { state.autoLoop = json.autoLoop; if (loopToggle) loopToggle.checked = state.autoLoop; }
  if (typeof json.shuffle === 'boolean') state.shuffle = json.shuffle;
  // downloadOnPlayOnly eliminado; ignorar
  if (typeof json.preferLocalSource === 'boolean') { state.preferLocalSource = json.preferLocalSource; if (preferLocalSourceToggle) preferLocalSourceToggle.checked = state.preferLocalSource; }
  if (Number.isFinite(json.playbackRate)) { state.playbackRate = Number(json.playbackRate) || 1; updateSpeedUI(); }
  if (typeof json.normalizationEnabled === 'boolean') { state.normalizationEnabled = json.normalizationEnabled; if (normalizationToggle) normalizationToggle.checked = state.normalizationEnabled; }
  if (typeof json.autoSync === 'boolean') { state.autoSync = !!json.autoSync; if (autoSyncToggle) autoSyncToggle.checked = state.autoSync; }
  persistLocalPlaylist();
}
