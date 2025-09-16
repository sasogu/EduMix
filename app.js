const playlistEl = document.getElementById('playlist');
const filePicker = document.getElementById('filePicker');
const togglePlayBtn = document.getElementById('togglePlay');
const prevTrackBtn = document.getElementById('prevTrack');
const nextTrackBtn = document.getElementById('nextTrack');
const nowPlayingEl = document.getElementById('nowPlaying');
const clearPlaylistBtn = document.getElementById('clearPlaylist');
const playlistPicker = document.getElementById('playlistPicker');
const newPlaylistBtn = document.getElementById('newPlaylist');
const fadeSlider = document.getElementById('fadeSlider');
const fadeValue = document.getElementById('fadeValue');
const installButton = document.getElementById('installButton');
const loopToggle = document.getElementById('loopToggle');
const dropboxStatusEl = document.getElementById('dropboxStatus');
const dropboxConnectBtn = document.getElementById('dropboxConnect');
const dropboxSyncBtn = document.getElementById('dropboxSync');
const dropboxDisconnectBtn = document.getElementById('dropboxDisconnect');
const cloudSyncCard = document.querySelector('.cloud-sync');
const waveformCanvas = document.getElementById('waveformCanvas');
const waveformMessage = document.getElementById('waveformMessage');
const waveformContainer = document.querySelector('.waveform');

const STORAGE_KEYS = {
  playlist: 'edumix-playlist',
  dropboxAuth: 'edumix-dropbox-auth',
  dropboxSession: 'edumix-dropbox-session',
};

const dropboxConfig = {
  clientId: '118rcuago5bvt6j',
  playlistPath: '/playlist.json',
  scopes: 'files.metadata.read files.content.read files.content.write',
};

dropboxConfig.redirectUri = `${window.location.origin}${window.location.pathname}`;

const state = {
  playlists: [],
  activePlaylistId: null,
  tracks: [],
  currentIndex: -1,
  isPlaying: false,
  fadeDuration: Number(fadeSlider?.value ?? 3),
  autoLoop: Boolean(loopToggle?.checked),
};

const audioContext = new (window.AudioContext || window.webkitAudioContext)();
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

const waveformState = {
  trackId: null,
  peaks: null,
  duration: 0,
  progress: 0,
};
const waveformCache = new Map();
let waveformResizeFrame = null;

const CROSS_FADE_MIN = 0.2;
const TOKEN_REFRESH_MARGIN = 90 * 1000;
const TEMP_LINK_MARGIN = 60 * 1000;
const WAVEFORM_SAMPLES = 800;
const IDB_CONFIG = {
  name: 'edumix-media',
  version: 1,
  store: 'tracks',
};
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
  };
}

function getActivePlaylist() {
  return state.playlists.find(playlist => playlist.id === state.activePlaylistId) || null;
}

function syncTracksFromActivePlaylist() {
  const active = getActivePlaylist();
  state.tracks = active ? active.tracks : [];
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
  state.currentIndex = -1;
  renderPlaylist();
  updateControls();
  updateNowPlaying();
  renderPlaylistPicker();
  persistLocalPlaylist();
  requestDropboxSync();
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
    fileName: track.fileName,
    duration: track.duration,
    size: track.size ?? null,
    lastModified: track.lastModified ?? null,
    dropboxPath: track.dropboxPath ?? null,
    dropboxRev: track.dropboxRev ?? null,
    dropboxSize: track.dropboxSize ?? null,
    dropboxUpdatedAt: track.dropboxUpdatedAt ?? null,
    waveform: track.waveform ?? null,
  };
}

function deserializeTrack(entry) {
  return {
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
  mediaDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_CONFIG.name, IDB_CONFIG.version);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDB_CONFIG.store)) {
        db.createObjectStore(IDB_CONFIG.store, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
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
  if (!waveformCanvas || waveformState.trackId !== player.trackId || !waveformState.peaks || !waveformState.peaks.length) {
    return;
  }
  const duration = waveformState.duration || player.audio.duration;
  if (!Number.isFinite(duration) || duration <= 0) {
    return;
  }
  const progress = Math.min(1, Math.max(0, player.audio.currentTime / duration));
  if (Math.abs(progress - waveformState.progress) < 0.003) {
    return;
  }
  waveformState.progress = progress;
  drawWaveform(waveformState.peaks, waveformState.progress);
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
    audioContext.decodeAudioData(copy, resolve, reject);
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
  const source = audioContext.createMediaElementSource(audio);
  const gain = audioContext.createGain();
  gain.gain.value = 0;
  source.connect(gain);
  gain.connect(audioContext.destination);
  const player = { audio, gain, stopTimeout: null, advanceHandler: null, trackId: null };
  audio.addEventListener('timeupdate', () => handleWaveformProgress(player));
  audio.addEventListener('loadedmetadata', () => handleWaveformMetadata(player));
  return player;
}

players.push(createPlayer(), createPlayer());

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

window.addEventListener('resize', scheduleWaveformResize);

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
  waveformCache.clear();
  state.tracks.forEach(track => {
    if (!track.isRemote && track.url) {
      URL.revokeObjectURL(track.url);
    }
    deleteTrackFile(track.id).catch(console.error);
  });
  state.tracks.splice(0, state.tracks.length);
  stopPlayback();
  renderPlaylist();
  updateControls();
  persistLocalPlaylist();
  requestDropboxSync();
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
    case 'rename':
      renameTrack(index);
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
        dropboxPath: null,
        dropboxRev: null,
        dropboxSize: null,
        dropboxUpdatedAt: null,
        waveform: null,
        urlExpiresAt: 0,
        isRemote: false,
      };
      pendingUploads.set(track.id, file);
      storeTrackFile(track.id, file).catch(console.error);
      readDuration(track);
      return track;
    });
  if (!newTracks.length) {
    return;
  }
  state.tracks.push(...newTracks);
  newTracks.forEach(track => {
    ensureWaveform(track).catch(console.error);
  });
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
  deleteTrackFile(track.id).catch(console.error);
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
  if (!state.tracks.length) {
    setWaveformTrack(null);
  }
  renderPlaylist();
  updateControls();
  persistLocalPlaylist();
  requestDropboxSync();
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
  renderPlaylist();
  updateNowPlaying();
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
  if (track.url && track.url.startsWith('blob:')) {
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
  }
}

async function playTrack(index, options = {}) {
  const track = state.tracks[index];
  if (!track) {
    return;
  }
  const { fade = true, fadeDurationOverride } = options;
  setWaveformTrack(track);

  await ensureContextRunning();

  let ready = true;
  if (track.dropboxPath) {
    ready = await ensureTrackRemoteLink(track);
    if (!ready) {
      ready = await ensureLocalTrackUrl(track);
    }
  } else {
    ready = await ensureLocalTrackUrl(track);
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
      showDropboxError('No se pudo obtener el audio desde Dropbox.');
    }
    return;
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
  nextPlayer.audio.currentTime = 0;
  nextPlayer.trackId = track.id;

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
    const fadedTrackId = previousPlayer.trackId;
    previousPlayer.stopTimeout = window.setTimeout(() => {
      if (previousPlayer.trackId !== fadedTrackId) {
        return;
      }
      previousPlayer.audio.pause();
      previousPlayer.audio.currentTime = 0;
      previousPlayer.gain.gain.setValueAtTime(0, audioContext.currentTime);
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
    player.trackId = null;
  });
  state.currentIndex = -1;
  state.isPlaying = false;
  updateNowPlaying();
  renderPlaylist();
  updateControls();
  setWaveformTrack(null);
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

    actions.append(playButton, renameButton, removeButton);
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
    playlists: state.playlists.map(playlist => ({
      id: playlist.id,
      name: playlist.name,
      tracks: playlist.tracks.map(serializeTrack),
    })),
    activePlaylistId: state.activePlaylistId,
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
      ensurePlaylistsInitialized();
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
    if (Array.isArray(data?.playlists)) {
      state.playlists = data.playlists.map(playlist => ({
        id: playlist.id || generateId('pl'),
        name: playlist.name || 'Lista',
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
  } catch (error) {
    console.warn('No se pudo leer la lista local', error);
    ensurePlaylistsInitialized();
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
  const uploads = getAllTracks().map(async track => {
    if (track.dropboxPath) {
      return;
    }
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
    try {
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
        throw new Error(textResponse || 'Upload failed');
      }
      const metadata = await response.json();
      track.dropboxPath = metadata.path_lower ?? metadata.path_display ?? remotePath;
      track.dropboxRev = metadata.rev;
      track.dropboxSize = metadata.size;
      track.dropboxUpdatedAt = Date.now();
      track.isRemote = true;
      track.urlExpiresAt = 0;
      pendingUploads.delete(track.id);
      persistLocalPlaylist();
    } catch (error) {
      console.error(`No se pudo subir ${track.fileName}`, error);
      showDropboxError(`Error subiendo ${track.fileName}.`);
    }
  });
  await Promise.all(uploads);
}

async function saveDropboxPlaylist(token) {
  const payload = {
    version: 2,
    updatedAt: Date.now(),
    activePlaylistId: state.activePlaylistId,
    fadeDuration: state.fadeDuration,
    autoLoop: state.autoLoop,
    playlists: state.playlists.map(playlist => ({
      id: playlist.id,
      name: playlist.name,
      tracks: playlist.tracks.map(serializeTrack),
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
              track.name = entry.name || track.name;
              track.fileName = entry.fileName ?? track.fileName ?? track.name;
              if (Number.isFinite(entry.duration)) {
                track.duration = entry.duration;
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

async function initialize() {
  loadLocalPlaylist();
  await restoreLocalMedia();
  const allTracks = getAllTracks();
  await Promise.allSettled(allTracks.filter(track => !track.dropboxPath).map(track => ensureLocalTrackUrl(track)));
  renderPlaylist();
  updateControls();
  scheduleWaveformResize();
  fadeValue.textContent = `${state.fadeDuration.toFixed(1).replace(/\.0$/, '')} s`;
  if (isDropboxConnected()) {
    performDropboxSync({ loadRemote: true }).catch(console.error);
  }
}

handleDropboxRedirect().catch(console.error).finally(() => {
  initialize().catch(console.error);
});
