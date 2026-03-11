export function trackExistsInPlaylist(playlist, trackId) {
  if (!playlist || !Array.isArray(playlist.tracks)) return false;
  return playlist.tracks.some(track => track && track.id === trackId);
}

export function countTrackReferencesInManualPlaylists(playlists, trackId, excludePlaylistId = null) {
  let count = 0;
  for (const playlist of playlists || []) {
    if (!playlist || playlist.isAuto) continue;
    if (excludePlaylistId && playlist.id === excludePlaylistId) continue;
    for (const track of playlist.tracks || []) {
      if (track && track.id === trackId) {
        count += 1;
      }
    }
  }
  return count;
}

export function countDropboxPathReferences(playlists, path, excludePlaylistId = null) {
  if (!path) return 0;
  let count = 0;
  for (const playlist of playlists || []) {
    if (!playlist || playlist.isAuto) continue;
    if (excludePlaylistId && playlist.id === excludePlaylistId) continue;
    for (const track of playlist.tracks || []) {
      if (track?.dropboxPath === path) {
        count += 1;
      }
    }
  }
  return count;
}

export function createTrackCleanupHelpers(deps) {
  const { pendingUploads, waveformCache, deleteTrackFile, pendingDeletions, playlistsRef } = deps;

  function cleanupTrackResources(track, options = {}) {
    const { deleteRemote = false } = options || {};
    if (!track) return;
    if (!track.isRemote && track.url) {
      try { URL.revokeObjectURL(track.url); } catch {}
    }
    pendingUploads.delete(track.id);
    waveformCache.delete(track.id);
    if (track.coverUrl) {
      try { URL.revokeObjectURL(track.coverUrl); } catch {}
      track.coverUrl = null;
    }
    deleteTrackFile(track.id).catch(console.error);
    if (deleteRemote && track.dropboxPath) {
      pendingDeletions.add(track.dropboxPath);
    }
  }

  function cleanupPlaylistTrackResources(tracks, playlistId) {
    const uniqueTracks = new Map();
    for (const track of tracks || []) {
      if (track?.id && !uniqueTracks.has(track.id)) {
        uniqueTracks.set(track.id, track);
      }
    }
    for (const track of uniqueTracks.values()) {
      const remainingTrackRefs = countTrackReferencesInManualPlaylists(playlistsRef(), track.id, playlistId);
      const remainingDropboxRefs = countDropboxPathReferences(playlistsRef(), track.dropboxPath, playlistId);
      if (remainingTrackRefs === 0) {
        cleanupTrackResources(track, { deleteRemote: remainingDropboxRefs === 0 });
      } else if (track.dropboxPath && remainingDropboxRefs === 0) {
        pendingDeletions.add(track.dropboxPath);
      }
    }
  }

  return {
    cleanupTrackResources,
    cleanupPlaylistTrackResources,
  };
}
