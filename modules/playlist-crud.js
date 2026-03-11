export function createPlaylistCrud(deps) {
  const {
    state,
    createPlaylistObject,
    getActivePlaylist,
    ensureAutoPlaylists,
    syncTracksFromActivePlaylist,
    renderPlaylistPicker,
    renderPlaylist,
    updateControls,
    updateNowPlaying,
    persistLocalPlaylist,
    requestDropboxSync,
    stopPlayback,
    showAppAlert,
    showAppPrompt,
    showAppConfirm,
    isDropboxConnected,
    performDropboxSync,
    cleanupPlaylistTrackResources,
    pendingDeletions,
    dropboxPerListMeta,
  } = deps;

  function createPlaylist(name) {
    const trimmed = (name || '').trim();
    if (!trimmed) {
      return;
    }
    const playlist = createPlaylistObject(trimmed, []);
    state.playlists.push(playlist);
    stopPlayback({ skipPlaylistRender: true, skipControlsUpdate: true });
    state.activePlaylistId = playlist.id;
    syncTracksFromActivePlaylist();
    state.currentIndex = -1;
    playlist.updatedAt = Date.now();
    ensureAutoPlaylists();
    renderPlaylistPicker();
    renderPlaylist();
    updateControls();
    updateNowPlaying();
    persistLocalPlaylist();
    requestDropboxSync();
  }

  async function renameActivePlaylist() {
    const active = getActivePlaylist();
    if (!active) return;
    if (active.isAuto) {
      await showAppAlert('No puedes renombrar la lista automática de favoritas.', { title: 'Accion no disponible' });
      return;
    }
    const proposed = await showAppPrompt('Escribe el nuevo nombre de la lista.', {
      title: 'Renombrar lista',
      defaultValue: active.name || '',
      confirmText: 'Guardar',
    });
    if (proposed === null) return;
    const nextName = proposed.trim();
    if (!nextName || nextName === active.name) return;
    active.name = nextName;
    active.updatedAt = Date.now();
    renderPlaylistPicker();
    persistLocalPlaylist();
    if (isDropboxConnected()) {
      performDropboxSync({ loadRemote: false }).catch(console.error);
    } else {
      requestDropboxSync();
    }
  }

  async function deleteActivePlaylist() {
    const active = getActivePlaylist();
    if (!active) return;
    if (active.isAuto) {
      await showAppAlert('La lista automática de favoritas no se puede eliminar.', { title: 'Accion no disponible' });
      return;
    }
    const confirmed = await showAppConfirm(`¿Eliminar la lista "${active.name}"? Se eliminarán sus pistas de esta sesión.`, {
      title: 'Eliminar lista',
      confirmText: 'Eliminar',
      danger: true,
    });
    if (!confirmed) return;

    cleanupPlaylistTrackResources(active.tracks, active.id);

    const perListMeta = dropboxPerListMeta && dropboxPerListMeta[active.id];
    if (perListMeta && perListMeta.path) {
      pendingDeletions.add(String(perListMeta.path).toLowerCase());
    }
    if (dropboxPerListMeta && typeof dropboxPerListMeta === 'object') {
      delete dropboxPerListMeta[active.id];
    }

    state.playlists = state.playlists.filter(p => p.id !== active.id);
    if (!state.playlists.some(p => !p.isAuto)) {
      const fallback = createPlaylistObject('Lista 1', []);
      state.playlists.unshift(fallback);
    }
    ensureAutoPlaylists();
    state.activePlaylistId = state.playlists[0].id;
    stopPlayback({ skipPlaylistRender: true, skipControlsUpdate: true });
    syncTracksFromActivePlaylist();
    state.currentIndex = -1;
    renderPlaylistPicker();
    renderPlaylist();
    updateControls();
    updateNowPlaying();
    persistLocalPlaylist();
    requestDropboxSync();
  }

  return {
    createPlaylist,
    renameActivePlaylist,
    deleteActivePlaylist,
  };
}
