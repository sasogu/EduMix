export function createTrackCrud(deps) {
  const {
    state,
    getActivePlaylist,
    trackExistsInPlaylist,
    getTrackDisplayTitle,
    showAppAlert,
    showAppSelect,
    showAppConfirm,
    showAppPrompt,
    persistLocalPlaylist,
    requestDropboxSync,
    syncTracksFromActivePlaylist,
    renderPlaylist,
    updateControls,
    updateNowPlaying,
    countTrackReferencesInManualPlaylists,
    countDropboxPathReferences,
    cleanupTrackResources,
    pendingDeletions,
    invalidateShuffle,
    playTrack,
    stopPlayback,
    setWaveformTrack,
    schedulePlaylistRender,
    refreshFavoritesPlaylist,
    scheduleStorageStatsUpdate,
  } = deps;

  async function copyTrackToPlaylist(index) {
    const track = state.tracks[index];
    if (!track) {
      return;
    }
    const source = getActivePlaylist();
    const manualTargets = state.playlists.filter(playlist => {
      if (!playlist || playlist.isAuto) return false;
      if (source && !source.isAuto && playlist.id === source.id) return false;
      return true;
    });
    if (!manualTargets.length) {
      await showAppAlert('No hay ninguna otra lista manual disponible. Crea una para poder copiar pistas.', {
        title: 'Sin destinos disponibles',
      });
      return;
    }
    const availableTargets = manualTargets.filter(playlist => !trackExistsInPlaylist(playlist, track.id));
    const firstAvailable = availableTargets[0] || null;
    if (!firstAvailable) {
      await showAppAlert('La pista ya forma parte de todas tus listas manuales.', {
        title: 'Sin destinos disponibles',
      });
      return;
    }
    const input = await showAppSelect(`Selecciona la lista destino para "${getTrackDisplayTitle(track) || track.name || track.fileName || 'Pista'}".`, {
      title: 'Copiar pista',
      defaultValue: firstAvailable?.id || '',
      confirmText: 'Copiar',
      selectOptions: availableTargets.map(playlist => ({
        value: playlist.id,
        label: playlist.name,
      })),
    });
    if (input === null) {
      return;
    }
    const target = availableTargets.find(playlist => playlist.id === String(input).trim());
    if (!target) {
      await showAppAlert('Selección no válida. Intenta de nuevo.', { title: 'Destino no valido' });
      return;
    }
    if (trackExistsInPlaylist(target, track.id)) {
      await showAppAlert(`"${target.name}" ya tiene esta pista.`, { title: 'Pista duplicada' });
      return;
    }
    target.tracks.push(track);
    target.updatedAt = Date.now();
    persistLocalPlaylist();
    requestDropboxSync();
    if (state.activePlaylistId === target.id) {
      syncTracksFromActivePlaylist();
      renderPlaylist();
      updateControls();
    }
    await showAppAlert(`Pista añadida a "${target.name}".`, { title: 'Pista copiada' });
  }

  async function removeTrack(index) {
    const track = state.tracks[index];
    if (!track) {
      return;
    }
    const active = getActivePlaylist();
    if (active?.isAuto) {
      await showAppAlert('Para quitar una pista de Favoritas, desmarca el corazón.', { title: 'Accion no disponible' });
      return;
    }
    const displayName = track.name || track.fileName || 'esta pista';
    const confirmed = await showAppConfirm(`¿Eliminar "${displayName}" de la lista?`, {
      title: 'Eliminar pista',
      confirmText: 'Eliminar',
      danger: true,
    });
    if (!confirmed) {
      return;
    }
    const remainingTrackRefs = countTrackReferencesInManualPlaylists(track.id, active?.id || null);
    const remainingDropboxRefs = countDropboxPathReferences(track.dropboxPath, active?.id || null);
    if (remainingTrackRefs === 0) {
      cleanupTrackResources(track, { deleteRemote: remainingDropboxRefs === 0 });
    } else if (track.dropboxPath && remainingDropboxRefs === 0) {
      pendingDeletions.add(track.dropboxPath);
    }
    state.tracks.splice(index, 1);
    const playlist = getActivePlaylist();
    if (playlist) {
      playlist.updatedAt = Date.now();
    }
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
    schedulePlaylistRender();
    updateControls();
    persistLocalPlaylist();
    requestDropboxSync();
    refreshFavoritesPlaylist({ force: true });
    scheduleStorageStatsUpdate();
  }

  async function renameTrack(index) {
    const track = state.tracks[index];
    if (!track) {
      return;
    }
    const active = getActivePlaylist();
    if (active?.isAuto) {
      await showAppAlert('No puedes renombrar pistas desde la lista automática. Ve a la lista original.', {
        title: 'Accion no disponible',
      });
      return;
    }
    const proposed = await showAppPrompt('Escribe el nuevo nombre de la pista.', {
      title: 'Renombrar pista',
      defaultValue: track.name || track.fileName || '',
      confirmText: 'Guardar',
    });
    if (proposed === null) {
      return;
    }
    const nextName = proposed.trim();
    if (!nextName || nextName === track.name) {
      return;
    }
    track.name = nextName;
    track.userRenamed = true;
    track.updatedAt = Date.now();
    const playlist = getActivePlaylist();
    if (playlist) playlist.updatedAt = Date.now();
    renderPlaylist();
    updateNowPlaying();
    persistLocalPlaylist();
    requestDropboxSync();
  }

  return {
    copyTrackToPlaylist,
    removeTrack,
    renameTrack,
  };
}
