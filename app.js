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

const state = {
  tracks: [],
  currentIndex: -1,
  isPlaying: false,
  fadeDuration: Number(fadeSlider?.value ?? 3),
};

const audioContext = new (window.AudioContext || window.webkitAudioContext)();
const players = [createPlayer(), createPlayer()];
let activePlayerIndex = 0;
let dragIndex = null;
let deferredPrompt = null;

const CROSS_FADE_MIN = 0.2;

function createPlayer() {
  const audio = new Audio();
  audio.preload = 'auto';
  const source = audioContext.createMediaElementSource(audio);
  const gain = audioContext.createGain();
  gain.gain.value = 0;
  source.connect(gain);
  gain.connect(audioContext.destination);
  return { audio, gain, stopTimeout: null };
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
  state.tracks.forEach(track => URL.revokeObjectURL(track.url));
  state.tracks = [];
  stopPlayback();
  renderPlaylist();
  updateControls();
});

fadeSlider?.addEventListener('input', () => {
  state.fadeDuration = Number(fadeSlider.value);
  fadeValue.textContent = `${state.fadeDuration.toFixed(1).replace(/\.0$/, '')} s`;
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
  } else {
    ensureContextRunning()
      .then(() => currentPlayer.audio.play())
      .then(() => {
        state.isPlaying = true;
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
      };
      readDuration(track);
      return track;
    });
  if (!newTracks.length) {
    return;
  }
  state.tracks.push(...newTracks);
  renderPlaylist();
  updateControls();
}

function readDuration(track) {
  const probe = document.createElement('audio');
  probe.src = track.url;
  probe.preload = 'metadata';
  probe.addEventListener('loadedmetadata', () => {
    track.duration = probe.duration;
    renderPlaylist();
  }, { once: true });
}

function removeTrack(index) {
  const track = state.tracks[index];
  if (!track) {
    return;
  }
  URL.revokeObjectURL(track.url);
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
}

async function playTrack(index, options = {}) {
  const track = state.tracks[index];
  if (!track) {
    return;
  }
  const { fade = true } = options;
  await ensureContextRunning();

  const hasCurrent = state.currentIndex !== -1 && state.isPlaying;
  const useFade = fade && hasCurrent;
  const previousPlayerIndex = activePlayerIndex;
  const nextPlayerIndex = useFade ? 1 - activePlayerIndex : activePlayerIndex;
  const nextPlayer = players[nextPlayerIndex];
  const previousPlayer = players[previousPlayerIndex];

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
  const fadeDuration = useFade ? Math.max(state.fadeDuration, CROSS_FADE_MIN) : CROSS_FADE_MIN;
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

  nextPlayer.audio.onended = () => {
    if (state.currentIndex !== index) {
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

function updateControls() {
  togglePlayBtn.disabled = !state.tracks.length;
  togglePlayBtn.textContent = state.isPlaying ? 'Pausar' : 'Reproducir';
  prevTrackBtn.disabled = state.currentIndex <= 0;
  nextTrackBtn.disabled = state.currentIndex === -1 || state.currentIndex >= state.tracks.length - 1;
  clearPlaylistBtn.disabled = !state.tracks.length;
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

    const handle = document.createElement('span');
    handle.className = 'track-handle';
    handle.textContent = '☰';
    handle.title = 'Arrastra para reordenar';

    const title = document.createElement('div');
    title.className = 'track-title';
    const name = document.createElement('strong');
    name.textContent = track.name;
    const meta = document.createElement('span');
    meta.textContent = track.duration ? formatDuration(track.duration) : track.fileName;
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

updateControls();
renderPlaylist();

fadeValue.textContent = `${state.fadeDuration.toFixed(1).replace(/\.0$/, '')} s`;
