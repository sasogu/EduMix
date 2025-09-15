const playlistEl = document.getElementById('playlist');
const filePicker = document.getElementById('filePicker');
const togglePlayBtn = document.getElementById('togglePlay');
const prevTrackBtn = document.getElementById('prevTrack');
const nextTrackBtn = document.getElementById('nextTrack');
const nowPlayingEl = document.getElementById('nowPlaying');
const clearPlaylistBtn = document.getElementById('clearPlaylist');
const fadeSlider = document.getElementById('fadeSlider');
const fadeValue = document.getElementById('fadeValue');
const installButton = document.getElementById('installButton');
const loopToggle = document.getElementById('loopToggle');
const dropboxStatusEl = document.getElementById('dropboxStatus');
const dropboxConnectBtn = document.getElementById('dropboxConnect');
const dropboxSyncBtn = document.getElementById('dropboxSync');
const dropboxDisconnectBtn = document.getElementById('dropboxDisconnect');
const cloudSyncCard = document.querySelector('.cloud-sync');

const STORAGE_KEYS = {
  playlist: 'edumix-playlist',
  dropboxAuth: 'edumix-dropbox-auth',
  dropboxSession: 'edumix-dropbox-session',
};

const dropboxConfig = {
  clientId: '0rx3ya88whuu3br',
  playlistPath: '/playlist.json',
};

dropboxConfig.redirectUri = `${window.location.origin}${window.location.pathname}`;

const state = {
  tracks: [],
  currentIndex: -1,
  isPlaying: false,
  fadeDuration: Number(fadeSlider?.value ?? 3),
  autoLoop: Boolean(loopToggle?.checked),
};

const audioContext = new (window.AudioContext || window.webkitAudioContext)();
const players = [createPlayer(), createPlayer()];
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

const CROSS_FADE_MIN = 0.2;
const TOKEN_REFRESH_MARGIN = 90 * 1000;
const TEMP_LINK_MARGIN = 60 * 1000;

function createPlayer() {
  const audio = new Audio();
  audio.preload = 'auto';
  const source = audioContext.createMediaElementSource(audio);
  const gain = audioContext.createGain();
  gain.gain.value = 0;
  source.connect(gain);
  gain.connect(audioContext.destination);
  return { audio, gain, stopTimeout: null, advanceHandler: null };
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
        const nextIndex = index + 1;
        if (nextIndex < state.tracks.length) {
          playTrack(nextIndex, { fadeDurationOverride: fadeWindow }).catch(console.error);
        }
      }
    }
  };
  player.advanceHandler = handler;
  player.audio.addEventListener('timeupdate', handler);
}

async function ensureContextRunning() {
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }
}

filePicker?.addEventListener('change', event => {
  const files = Array.from(event.target.files || []);
  if (!files.length) {
    return;
  }
  addTracks(files);
  filePicker.value = '';
});

clearPlaylistBtn?.addEventListener('click', () => {
  const removeRemotePaths = state.tracks
    .map(track => track.dropboxPath)
    .filter(Boolean);
  removeRemotePaths.forEach(path => pendingDeletions.add(path));
  pendingUploads.clear();
  state.tracks.forEach(track => {
    if (!track.isRemote && track.url) {
      URL.revokeObjectURL(track.url);
    }
  });
  state.tracks = [];
  stopPlayback();
  renderPlaylist();
  updateControls();
  persistLocalPlaylist();
  requestDropboxSync();
});

fadeSlider?.addEventListener('input', () => {
  state.fadeDuration = Number(fadeSlider.value);
  fadeValue.textContent = `${state.fadeDuration.toFixed(1).replace(/\.0$/, '')} s`;
  persistLocalPlaylist();
});

loopToggle?.addEventListener('change', () => {
  state.autoLoop = loopToggle.checked;
  updateControls();
  persistLocalPlaylist();
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
    case 'remove':
      removeTrack(index);
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
  if (state.currentIndex === -1) {
    playTrack(0).catch(console.error);
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
});

prevTrackBtn?.addEventListener('click', () => {
  if (state.currentIndex > 0) {
    playTrack(state.currentIndex - 1).catch(console.error);
  }
});

nextTrackBtn?.addEventListener('click', () => {
  if (state.currentIndex + 1 < state.tracks.length) {
    playTrack(state.currentIndex + 1).catch(console.error);
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
    navigator.serviceWorker.register('service-worker.js').catch(console.error);
  });
}

dropboxConnectBtn?.addEventListener('click', () => {
  beginDropboxAuth().catch(error => {
    console.error('Error iniciando Dropbox', error);
    showDropboxError('No se pudo iniciar la autenticación.');
  });
});

dropboxSyncBtn?.addEventListener('click', () => {
  performDropboxSync({ loadRemote: true }).catch(console.error);
});

dropboxDisconnectBtn?.addEventListener('click', () => {
  disconnectDropbox();
});

function addTracks(files) {
  const newTracks = files
    .filter(file => file.type.startsWith('audio/'))
    .map(file => {
      const url = URL.createObjectURL(file);
      const track = {
        id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
        name: file.name.replace(/\.[^/.]+$/, ''),
        fileName: file.name,
        url,
        duration: null,
        size: file.size,
        lastModified: file.lastModified,
        dropboxPath: null,
        dropboxRev: null,
        dropboxSize: null,
        dropboxUpdatedAt: null,
        urlExpiresAt: 0,
        isRemote: false,
      };
      pendingUploads.set(track.id, file);
      readDuration(track);
      return track;
    });
  if (!newTracks.length) {
    return;
  }
  state.tracks.push(...newTracks);
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
    renderPlaylist();
    persistLocalPlaylist();
  }, { once: true });
}

function removeTrack(index) {
  const track = state.tracks[index];
  if (!track) {
    return;
  }
  if (!track.isRemote && track.url) {
    URL.revokeObjectURL(track.url);
  }
  pendingUploads.delete(track.id);
  if (track.dropboxPath) {
    pendingDeletions.add(track.dropboxPath);
  }
  state.tracks.splice(index, 1);
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
  renderPlaylist();
  updateControls();
  persistLocalPlaylist();
  requestDropboxSync();
}

function reorderTracks(from, to) {
  if (from === to || from < 0 || to < 0 || from >= state.tracks.length || to >= state.tracks.length) {
    return;
  }
  const [moved] = state.tracks.splice(from, 1);
  state.tracks.splice(to, 0, moved);
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
  if (track.url && track.urlExpiresAt && now + TEMP_LINK_MARGIN < track.urlExpiresAt) {
    return true;
  }
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
      throw new Error('No se pudo obtener enlace temporal');
    }
    const data = await response.json();
    track.url = data.link;
    track.urlExpiresAt = Date.now() + 3.5 * 60 * 60 * 1000;
    track.isRemote = true;
    return true;
  } catch (error) {
    console.error('Error obteniendo enlace temporal', error);
    showDropboxError('No se pudo obtener el audio desde Dropbox.');
    return false;
  }
}

async function playTrack(index, options = {}) {
  const track = state.tracks[index];
  if (!track) {
    return;
  }
  const { fade = true, fadeDurationOverride } = options;
  if (track.isRemote) {
    const ready = await ensureTrackRemoteLink(track);
    if (!ready) {
      return;
    }
  }
  await ensureContextRunning();

  const hasCurrent = state.currentIndex !== -1 && state.isPlaying;
  const useFade = fade && hasCurrent;
  const previousPlayerIndex = activePlayerIndex;
  const nextPlayerIndex = useFade ? 1 - activePlayerIndex : activePlayerIndex;
  const nextPlayer = players[nextPlayerIndex];
  const previousPlayer = players[previousPlayerIndex];

  if (previousPlayer) {
    previousPlayer.audio.onended = null;
    cancelAutoAdvance(previousPlayer);
  }
  cancelAutoAdvance(nextPlayer);

  if (nextPlayer.audio.src !== track.url) {
    nextPlayer.audio.src = track.url;
  }
  nextPlayer.audio.currentTime = 0;

  try {
    await nextPlayer.audio.play();
  } catch (error) {
    console.error('No se pudo reproducir la pista', error);
    return;
  }

  const now = audioContext.currentTime;
  const fallbackFade = Number.isFinite(state.fadeDuration) ? state.fadeDuration : CROSS_FADE_MIN;
  const resolvedFade = Number.isFinite(fadeDurationOverride) ? fadeDurationOverride : fallbackFade;
  const fadeDuration = useFade ? Math.max(resolvedFade, CROSS_FADE_MIN) : CROSS_FADE_MIN;
  nextPlayer.gain.gain.cancelScheduledValues(now);
  nextPlayer.gain.gain.setValueAtTime(useFade ? 0 : 1, now);
  nextPlayer.gain.gain.linearRampToValueAtTime(1, now + (useFade ? fadeDuration : 0.05));

  if (useFade) {
    previousPlayer.gain.gain.cancelScheduledValues(now);
    const currentValue = previousPlayer.gain.gain.value;
    previousPlayer.gain.gain.setValueAtTime(currentValue, now);
    previousPlayer.gain.gain.linearRampToValueAtTime(0, now + fadeDuration);
    window.clearTimeout(previousPlayer.stopTimeout);
    previousPlayer.stopTimeout = window.setTimeout(() => {
      previousPlayer.audio.pause();
      previousPlayer.audio.currentTime = 0;
      previousPlayer.gain.gain.setValueAtTime(0, audioContext.currentTime);
    }, fadeDuration * 1000 + 120);
  } else if (previousPlayerIndex !== nextPlayerIndex) {
    previousPlayer.audio.pause();
    previousPlayer.audio.currentTime = 0;
    previousPlayer.gain.gain.setValueAtTime(0, now);
  }

  activePlayerIndex = nextPlayerIndex;
  state.currentIndex = index;
  state.isPlaying = true;
  updateNowPlaying();
  renderPlaylist();
  updateControls();
  scheduleAutoAdvance(nextPlayer, index);

  nextPlayer.audio.onended = () => {
    if (state.currentIndex !== index) {
      return;
    }
    if (state.autoLoop && state.tracks[index]) {
      playTrack(index, { fade: false }).catch(console.error);
      return;
    }
    const nextIndex = index + 1;
    if (nextIndex < state.tracks.length) {
      playTrack(nextIndex, { fade: false }).catch(console.error);
    } else {
      stopPlayback();
    }
  };
}

function stopPlayback() {
  players.forEach(player => {
    cancelAutoAdvance(player);
    player.audio.onended = null;
    player.audio.pause();
    player.audio.currentTime = 0;
    player.gain.gain.setValueAtTime(0, audioContext.currentTime);
    window.clearTimeout(player.stopTimeout);
  });
  state.currentIndex = -1;
  state.isPlaying = false;
  updateNowPlaying();
  renderPlaylist();
  updateControls();
}

function updateNowPlaying() {
  const track = state.tracks[state.currentIndex];
  if (!track) {
    nowPlayingEl.textContent = 'Ninguna pista seleccionada';
    return;
  }
  const duration = track.duration ? ` · ${formatDuration(track.duration)}` : '';
  nowPlayingEl.textContent = `${track.name}${duration}`;
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
  prevTrackBtn.disabled = state.currentIndex <= 0;
  nextTrackBtn.disabled = state.currentIndex === -1 || state.currentIndex >= state.tracks.length - 1;
  clearPlaylistBtn.disabled = !state.tracks.length;
  syncLoopToggle();
  updateDropboxUI();
}

function renderPlaylist() {
  if (!playlistEl) {
    return;
  }
  playlistEl.innerHTML = '';
  state.tracks.forEach((track, index) => {
    const item = document.createElement('li');
    item.className = 'track';
    item.draggable = true;
    item.dataset.index = String(index);
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

    const title = document.createElement('div');
    title.className = 'track-title';
    const name = document.createElement('strong');
    name.textContent = track.name;
    const meta = document.createElement('span');
    if (track.duration) {
      meta.textContent = formatDuration(track.duration);
    } else if (track.dropboxPath) {
      meta.textContent = 'Guardado en Dropbox';
    } else {
      meta.textContent = track.fileName;
    }
    title.append(name, meta);

    const actions = document.createElement('div');
    actions.className = 'track-actions';

    const playButton = document.createElement('button');
    playButton.className = 'ghost';
    playButton.textContent = index === state.currentIndex && state.isPlaying ? 'Reproduciendo' : 'Reproducir';
    playButton.dataset.action = 'play';
    playButton.dataset.index = String(index);

    const removeButton = document.createElement('button');
    removeButton.className = 'ghost';
    removeButton.textContent = 'Eliminar';
    removeButton.dataset.action = 'remove';
    removeButton.dataset.index = String(index);

    actions.append(playButton, removeButton);
    item.append(handle, title, actions);
    playlistEl.append(item);
  });
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

function persistLocalPlaylist() {
  const data = {
    tracks: state.tracks.map(track => ({
      id: track.id,
      name: track.name,
      fileName: track.fileName,
      duration: track.duration,
      size: track.size ?? null,
      lastModified: track.lastModified ?? null,
      dropboxPath: track.dropboxPath,
      dropboxRev: track.dropboxRev,
      dropboxSize: track.dropboxSize ?? null,
      dropboxUpdatedAt: track.dropboxUpdatedAt ?? null,
    })),
    fadeDuration: state.fadeDuration,
    autoLoop: state.autoLoop,
    pendingDeletions: Array.from(pendingDeletions),
    updatedAt: Date.now(),
  };
  try {
    localStorage.setItem(STORAGE_KEYS.playlist, JSON.stringify(data));
  } catch (error) {
    console.warn('No se pudo guardar localmente la lista', error);
  }
}

function loadLocalPlaylist() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.playlist);
    if (!raw) {
      return;
    }
    const data = JSON.parse(raw);
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
    if (Array.isArray(data?.tracks)) {
      state.tracks = data.tracks.map(entry => ({
        id: entry.id,
        name: entry.name,
        fileName: entry.fileName ?? entry.name,
        url: null,
        duration: entry.duration ?? null,
        size: entry.size ?? null,
        lastModified: entry.lastModified ?? null,
        dropboxPath: entry.dropboxPath ?? null,
        dropboxRev: entry.dropboxRev ?? null,
        dropboxSize: entry.dropboxSize ?? null,
        dropboxUpdatedAt: entry.dropboxUpdatedAt ?? null,
        urlExpiresAt: 0,
        isRemote: Boolean(entry.dropboxPath),
      }));
    }
  } catch (error) {
    console.warn('No se pudo leer la lista local', error);
  }
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
    dropboxDisconnectBtn.hidden = true;
    dropboxConnectBtn.hidden = false;
    cloudSyncCard.classList.remove('is-syncing', 'is-error');
    return;
  }
  if (dropboxState.error) {
    dropboxStatusEl.textContent = 'Error de sincronización';
    dropboxStatusEl.classList.add('is-error');
    cloudSyncCard.classList.add('is-error');
  } else {
    dropboxStatusEl.textContent = dropboxState.isSyncing ? 'Sincronizando…' : 'Conectado';
    dropboxStatusEl.classList.remove('is-error');
    cloudSyncCard.classList.remove('is-error');
  }
  cloudSyncCard.classList.toggle('is-syncing', dropboxState.isSyncing);
  dropboxConnectBtn.hidden = true;
  dropboxSyncBtn.hidden = false;
  dropboxDisconnectBtn.hidden = false;
  dropboxSyncBtn.disabled = dropboxState.isSyncing;
  dropboxDisconnectBtn.disabled = dropboxState.isSyncing;
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
  const effective = {
    loadRemote: Boolean(options.loadRemote),
  };
  if (dropboxState.isSyncing) {
    dropboxState.syncQueued = {
      loadRemote: effective.loadRemote || Boolean(dropboxState?.syncQueued?.loadRemote),
    };
    return;
  }
  dropboxState.isSyncing = true;
  dropboxState.error = null;
  updateDropboxUI();
  try {
    const token = await ensureDropboxToken();
    if (!token) {
      return;
    }
    if (effective.loadRemote) {
      await pullDropboxPlaylist(token);
    }
    await uploadPendingTracks(token);
    await processPendingDeletions(token);
    await saveDropboxPlaylist(token);
    dropboxState.lastSync = Date.now();
  } catch (error) {
    console.error('Dropbox sync error', error);
    dropboxState.error = error;
    showDropboxError('No se pudo sincronizar con Dropbox.');
  } finally {
    dropboxState.isSyncing = false;
    updateDropboxUI();
    const queued = dropboxState.syncQueued;
    dropboxState.syncQueued = null;
    if (queued) {
      performDropboxSync(queued).catch(console.error);
    }
  }
}

async function uploadPendingTracks(token) {
  const promises = [];
  state.tracks.forEach(track => {
    if (track.dropboxPath) {
      return;
    }
    const file = pendingUploads.get(track.id);
    if (!file) {
      return;
    }
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, '_');
    const path = `/tracks/${track.id}-${safeName}`;
    const uploadPromise = fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({
          path,
          mode: 'overwrite',
          mute: false,
          autorename: false,
        }),
      },
      body: file,
    })
      .then(async response => {
        if (!response.ok) {
          const text = await response.text();
          throw new Error(text || 'Upload failed');
        }
        return response.json();
      })
      .then(metadata => {
        track.dropboxPath = metadata.path_lower ?? metadata.path_display ?? path;
        track.dropboxRev = metadata.rev;
        track.dropboxSize = metadata.size;
        track.dropboxUpdatedAt = Date.now();
        track.isRemote = true;
        track.urlExpiresAt = 0;
        pendingUploads.delete(track.id);
        persistLocalPlaylist();
      })
      .catch(error => {
        console.error(`No se pudo subir ${track.fileName}`, error);
        showDropboxError(`Error subiendo ${track.fileName}.`);
      });
    promises.push(uploadPromise);
  });
  await Promise.all(promises);
}

async function saveDropboxPlaylist(token) {
  const payload = {
    updatedAt: Date.now(),
    tracks: state.tracks
      .filter(track => track.dropboxPath)
      .map(track => ({
        id: track.id,
        name: track.name,
        fileName: track.fileName,
        duration: track.duration,
        dropboxPath: track.dropboxPath,
        dropboxRev: track.dropboxRev,
        dropboxSize: track.dropboxSize,
        dropboxUpdatedAt: track.dropboxUpdatedAt,
      })),
  };
  try {
    await fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({
          path: dropboxConfig.playlistPath,
          mode: 'overwrite',
          autorename: false,
          mute: true,
        }),
      },
      body: new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
    });
  } catch (error) {
    console.error('Error guardando playlist en Dropbox', error);
    throw error;
  }
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
    const json = await response.json();
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
    const merged = [];
    json.tracks.forEach(entry => {
      const existing = state.tracks.find(track => track.id === entry.id);
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
        merged.push(existing);
      } else {
        merged.push({
          id: entry.id,
          name: entry.name,
          fileName: entry.fileName ?? entry.name,
          url: null,
          duration: entry.duration ?? null,
          size: entry.dropboxSize ?? null,
          lastModified: null,
          dropboxPath: entry.dropboxPath,
          dropboxRev: entry.dropboxRev ?? null,
          dropboxSize: entry.dropboxSize ?? null,
          dropboxUpdatedAt: entry.dropboxUpdatedAt ?? null,
          urlExpiresAt: 0,
          isRemote: true,
        });
      }
    });
    const unsynced = state.tracks.filter(track => !remoteMap.has(track.id));
    state.tracks = [...merged, ...unsynced];
    persistLocalPlaylist();
    renderPlaylist();
    updateControls();
  } catch (error) {
    console.error('Error cargando playlist de Dropbox', error);
    throw error;
  }
}

async function processPendingDeletions(token) {
  if (!pendingDeletions.size) {
    return;
  }
  const deletions = Array.from(pendingDeletions);
  const promises = deletions.map(path => (
    fetch('https://api.dropboxapi.com/2/files/delete_v2', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path }),
    })
      .then(response => {
        if (!response.ok && response.status !== 409) {
          throw new Error('Delete failed');
        }
        pendingDeletions.delete(path);
      })
      .catch(error => {
        console.error('No se pudo eliminar archivo en Dropbox', error);
      })
  ));
  await Promise.all(promises);
  persistLocalPlaylist();
}

function disconnectDropbox() {
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

function initialize() {
  loadLocalPlaylist();
  renderPlaylist();
  updateControls();
  fadeValue.textContent = `${state.fadeDuration.toFixed(1).replace(/\.0$/, '')} s`;
  if (isDropboxConnected()) {
    performDropboxSync({ loadRemote: true }).catch(console.error);
  }
}

handleDropboxRedirect().catch(console.error).finally(() => {
  initialize();
});
