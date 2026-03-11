export function createWaveformUi(deps) {
  const {
    waveformCanvas,
    waveformContainer,
    waveformMessage,
    progressFill,
    progressHandle,
    waveformState,
    drawWaveform,
    ensureWaveform,
    firstFiniteNumber,
    formatBytes,
    formatDuration,
    WAVEFORM_MAX_SOURCE_BYTES,
    WAVEFORM_MAX_SOURCE_DURATION,
  } = deps;

  function handleWaveformMetadata(player, state, persistLocalPlaylist) {
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

  function handleWaveformProgress(player, maybePrefetchNext) {
    const duration = player.audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      return;
    }

    const progress = Math.min(1, Math.max(0, player.audio.currentTime / duration));

    if (progressFill && progressHandle) {
      const percentage = progress * 100;
      progressFill.style.width = `${percentage}%`;
      progressHandle.style.left = `${percentage}%`;
    }

    if (!waveformContainer.hidden && waveformCanvas && waveformState.trackId === player.trackId) {
      if (Math.abs(progress - waveformState.progress) >= 0.003) {
        waveformState.progress = progress;
        if (waveformState.peaks && waveformState.peaks.length) {
          drawWaveform(waveformState.peaks, waveformState.progress);
        }
      }
    }

    if (player.trackId && progress >= 0.5) {
      maybePrefetchNext();
    }
  }

  function handleWaveformClick(ev, state, players, activePlayerIndex, updateTimeDisplay, updateMediaSessionPosition) {
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

  function getWaveformDisabledMessage(track) {
    if (!track || !track.waveformStatus) {
      return 'Forma de onda no disponible para esta pista.';
    }
    if (track.waveformStatus === 'disabled:size') {
      const size = firstFiniteNumber([track.size, track.dropboxSize]);
      const formatted = size ? formatBytes(size) : formatBytes(WAVEFORM_MAX_SOURCE_BYTES);
      return `Forma de onda desactivada: archivo demasiado grande (${formatted}).`;
    }
    if (track.waveformStatus === 'disabled:duration') {
      const duration = Number(track.duration);
      const formatted = Number.isFinite(duration) ? formatDuration(duration) : formatDuration(WAVEFORM_MAX_SOURCE_DURATION);
      return `Forma de onda desactivada: pista demasiado larga (${formatted}).`;
    }
    return 'Forma de onda no disponible para esta pista.';
  }

  function setWaveformTrack(track) {
    if (progressFill && progressHandle) {
      progressFill.style.width = '0%';
      progressHandle.style.left = '0%';
    }

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
    if (track.waveformStatus && track.waveformStatus.startsWith('disabled')) {
      waveformState.peaks = null;
      waveformContainer.classList.remove('is-loading');
      waveformContainer.classList.remove('has-data');
      if (waveformMessage) {
        waveformMessage.textContent = getWaveformDisabledMessage(track);
      }
      drawWaveform(null, 0);
      return;
    }
    if (track.waveform?.peaks?.length) {
      waveformState.peaks = track.waveform.peaks;
      waveformState.duration = track.waveform.duration ?? waveformState.duration;
      waveformContainer.classList.remove('is-loading');
      waveformContainer.classList.add('has-data');
      if (waveformMessage) {
        waveformMessage.textContent = '';
      }
      drawWaveform(waveformState.peaks, waveformState.progress);
    } else {
      waveformState.peaks = null;
      if (!waveformContainer.hidden) {
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
            waveformContainer.classList.remove('is-loading');
            if (result.disabled) {
              waveformContainer.classList.remove('has-data');
              if (waveformMessage) {
                waveformMessage.textContent = getWaveformDisabledMessage(track);
              }
              drawWaveform(null, 0);
              return;
            }
            waveformState.peaks = result.peaks;
            waveformState.duration = result.duration ?? waveformState.duration;
            waveformContainer.classList.add('has-data');
            if (waveformMessage) {
              waveformMessage.textContent = '';
            }
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
  }

  return {
    handleWaveformMetadata,
    handleWaveformProgress,
    handleWaveformClick,
    getWaveformDisabledMessage,
    setWaveformTrack,
  };
}
