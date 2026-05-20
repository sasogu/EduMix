import { findDuplicateTracks } from './duplicate-detector.js';

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDuration(seconds) {
  if (!seconds || !isFinite(seconds)) return '?:??';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function createDuplicateUi(deps) {
  const {
    state,
    getTrackDisplayTitle,
    showAppAlert,
    persistLocalPlaylist,
    requestCloudSync,
    updateControls,
    cleanupTrackResources,
    invalidateShuffle,
    stopPlayback,
    schedulePlaylistRender,
    refreshFavoritesPlaylist,
    scheduleStorageStatsUpdate,
  } = deps;

  let previewAudio = null;
  let previewTrackId = null;
  let backdropEl = null;
  let resolvedCount = 0;
  let totalGroups = 0;
  let counterEl = null;

  function getPreviewAudio() {
    if (!previewAudio) {
      previewAudio = new Audio();
      previewAudio.addEventListener('ended', () => {
        previewTrackId = null;
        updatePlayButtons();
      });
      previewAudio.addEventListener('pause', () => {
        if (previewTrackId !== null) {
          // Only clear if not transitioning to a new track
        }
        updatePlayButtons();
      });
    }
    return previewAudio;
  }

  function stopPreview() {
    if (previewAudio) {
      previewAudio.pause();
      previewAudio.src = '';
    }
    previewTrackId = null;
    updatePlayButtons();
  }

  function updatePlayButtons() {
    if (!backdropEl) return;
    backdropEl.querySelectorAll('.dup-play-btn').forEach(btn => {
      const isPlaying = btn.dataset.trackId === previewTrackId && previewAudio && !previewAudio.paused;
      btn.textContent = isPlaying ? '⏸' : '▶';
      btn.setAttribute('aria-label', isPlaying ? 'Pausar' : 'Escuchar');
      btn.classList.toggle('is-playing', isPlaying);
    });
  }

  function removeTrackFromAllPlaylists(trackToRemove) {
    let wasCurrentTrack = false;
    for (const playlist of state.playlists) {
      if (!playlist || playlist.isAuto) continue;
      const idx = (playlist.tracks || []).findIndex(t => t?.id === trackToRemove.id);
      if (idx === -1) continue;
      playlist.tracks.splice(idx, 1);
      playlist.updatedAt = Date.now();
      // state.tracks is the same reference as active playlist's tracks array
      if (playlist.id === state.activePlaylistId) {
        if (state.currentIndex === idx) {
          wasCurrentTrack = true;
        } else if (state.currentIndex > idx) {
          state.currentIndex -= 1;
        }
      }
    }
    return wasCurrentTrack;
  }

  async function keepTrack(group, keepIndex) {
    const itemsToRemove = group.items.filter((_, i) => i !== keepIndex);
    let needsPlaybackStop = false;

    for (const item of itemsToRemove) {
      const wasCurrent = removeTrackFromAllPlaylists(item.track);
      if (wasCurrent) needsPlaybackStop = true;
      // deleteRemote:false to avoid accidentally removing cloud files
      cleanupTrackResources(item.track, { deleteRemote: false });
    }

    if (needsPlaybackStop) {
      stopPlayback();
    }

    invalidateShuffle();
    schedulePlaylistRender();
    updateControls();
    persistLocalPlaylist();
    requestCloudSync();
    refreshFavoritesPlaylist({ force: true });
    scheduleStorageStatsUpdate();
  }

  function markResolved(groupEl, message) {
    groupEl.dataset.resolved = 'true';
    groupEl.classList.add('dup-resolved');
    const msg = document.createElement('div');
    msg.className = 'dup-resolved-msg';
    msg.textContent = message;
    groupEl.innerHTML = '';
    groupEl.appendChild(msg);
    resolvedCount += 1;
    if (counterEl) {
      const pending = totalGroups - resolvedCount;
      counterEl.textContent = `${resolvedCount} / ${totalGroups} resueltos · ${pending} pendientes`;
    }
  }

  function buildGroupEl(group, index) {
    const groupEl = document.createElement('div');
    groupEl.className = 'dup-group';
    groupEl.dataset.resolved = 'false';

    const criterionLabel = group.criterion === 'fileName'
      ? 'Nombre de archivo idéntico'
      : 'Nombre y duración similares';

    const header = document.createElement('div');
    header.className = 'dup-group-header';
    header.innerHTML =
      `<span class="dup-criterion">${escapeHtml(criterionLabel)}</span>` +
      `<span class="dup-key" title="${escapeHtml(group.key)}">${escapeHtml(group.key)}</span>` +
      `<span class="dup-group-num">${index + 1} / ${totalGroups}</span>`;
    groupEl.appendChild(header);

    const tracksEl = document.createElement('div');
    tracksEl.className = 'dup-tracks';

    group.items.forEach((item, itemIndex) => {
      const trackEl = document.createElement('div');
      trackEl.className = 'dup-track';

      const title = getTrackDisplayTitle(item.track) || item.track.name || item.track.fileName || 'Pista sin nombre';
      const duration = formatDuration(item.track.duration);
      const playlists = item.playlistRefs.map(p => escapeHtml(p.name)).join(', ');
      const hasUrl = !!item.track.url;

      const infoEl = document.createElement('div');
      infoEl.className = 'dup-track-info';
      infoEl.innerHTML =
        `<span class="dup-track-title">${escapeHtml(title)}</span>` +
        `<span class="dup-track-meta">${escapeHtml(duration)} · ${playlists}</span>`;

      const actionsEl = document.createElement('div');
      actionsEl.className = 'dup-track-actions';

      const playBtn = document.createElement('button');
      playBtn.type = 'button';
      playBtn.className = 'dup-play-btn ghost icon-button';
      playBtn.dataset.trackId = item.track.id;
      playBtn.textContent = '▶';
      playBtn.setAttribute('aria-label', 'Escuchar');
      if (!hasUrl) {
        playBtn.disabled = true;
        playBtn.title = 'Audio no disponible localmente';
      }
      playBtn.addEventListener('click', () => {
        const audio = getPreviewAudio();
        if (previewTrackId === item.track.id) {
          if (audio.paused) {
            audio.play().catch(() => { previewTrackId = null; updatePlayButtons(); });
          } else {
            audio.pause();
            previewTrackId = null;
          }
        } else {
          audio.pause();
          audio.src = item.track.url;
          audio.currentTime = 0;
          previewTrackId = item.track.id;
          audio.play().catch(() => { previewTrackId = null; updatePlayButtons(); });
        }
        updatePlayButtons();
      });

      const keepBtn = document.createElement('button');
      keepBtn.type = 'button';
      keepBtn.className = 'dup-keep-btn';
      keepBtn.textContent = 'Conservar esta';
      keepBtn.addEventListener('click', async () => {
        stopPreview();
        await keepTrack(group, itemIndex);
        markResolved(groupEl, '✓ Conservada — duplicadas eliminadas');
      });

      actionsEl.appendChild(playBtn);
      actionsEl.appendChild(keepBtn);
      trackEl.appendChild(infoEl);
      trackEl.appendChild(actionsEl);
      tracksEl.appendChild(trackEl);
    });

    groupEl.appendChild(tracksEl);

    const footerEl = document.createElement('div');
    footerEl.className = 'dup-group-footer';
    const ignoreBtn = document.createElement('button');
    ignoreBtn.type = 'button';
    ignoreBtn.className = 'ghost';
    ignoreBtn.textContent = 'Ignorar grupo';
    ignoreBtn.addEventListener('click', () => {
      stopPreview();
      markResolved(groupEl, '— Ignorado');
    });
    footerEl.appendChild(ignoreBtn);
    groupEl.appendChild(footerEl);

    return groupEl;
  }

  function closePanel() {
    stopPreview();
    if (backdropEl) {
      backdropEl.remove();
      backdropEl = null;
    }
    document.body.classList.remove('dialog-open');
  }

  async function showPanel() {
    if (backdropEl) return; // already open

    const groups = findDuplicateTracks(state.playlists);

    if (!groups.length) {
      await showAppAlert('No se encontraron pistas duplicadas en ninguna lista.', {
        title: 'Sin duplicados',
      });
      return;
    }

    totalGroups = groups.length;
    resolvedCount = 0;

    backdropEl = document.createElement('div');
    backdropEl.className = 'dup-backdrop';
    backdropEl.setAttribute('role', 'dialog');
    backdropEl.setAttribute('aria-modal', 'true');
    backdropEl.setAttribute('aria-label', 'Detector de duplicados');

    const panelEl = document.createElement('div');
    panelEl.className = 'dup-panel';

    // Header
    const headerEl = document.createElement('div');
    headerEl.className = 'dup-panel-header';

    const titleEl = document.createElement('h2');
    titleEl.textContent = 'Pistas duplicadas';
    headerEl.appendChild(titleEl);

    counterEl = document.createElement('span');
    counterEl.className = 'dup-panel-counter';
    counterEl.textContent = `0 / ${totalGroups} resueltos · ${totalGroups} pendientes`;
    headerEl.appendChild(counterEl);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'ghost icon-button';
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('aria-label', 'Cerrar');
    closeBtn.addEventListener('click', closePanel);
    headerEl.appendChild(closeBtn);

    // Body
    const bodyEl = document.createElement('div');
    bodyEl.className = 'dup-panel-body';

    groups.forEach((group, i) => {
      bodyEl.appendChild(buildGroupEl(group, i));
    });

    panelEl.appendChild(headerEl);
    panelEl.appendChild(bodyEl);
    backdropEl.appendChild(panelEl);

    // Close on backdrop click
    backdropEl.addEventListener('click', e => {
      if (e.target === backdropEl) closePanel();
    });

    // Close on Escape
    const escHandler = e => {
      if (e.key === 'Escape' && backdropEl) {
        e.preventDefault();
        closePanel();
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);

    document.body.appendChild(backdropEl);
    document.body.classList.add('dialog-open');
    setTimeout(() => closeBtn.focus(), 0);
  }

  return { showPanel };
}
