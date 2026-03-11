export function createTrackDataHelpers(deps) {
  const {
    coerceDropboxBoolean,
    coerceDropboxNumber,
    syncTracksFromActivePlaylist,
  } = deps;

  function ensureSharedTrackReferences(playlists) {
    const map = new Map();
    for (const playlist of playlists || []) {
      if (!playlist || !Array.isArray(playlist.tracks)) continue;
      for (let i = 0; i < playlist.tracks.length; i += 1) {
        const track = playlist.tracks[i];
        if (!track || !track.id) continue;
        const existing = map.get(track.id);
        if (existing) {
          playlist.tracks[i] = existing;
        } else {
          map.set(track.id, track);
        }
      }
    }
    syncTracksFromActivePlaylist();
  }

  function serializeTrack(track) {
    return {
      id: track.id,
      name: track.name,
      userRenamed: !!track.userRenamed,
      fileName: track.fileName,
      artist: track.artist ?? null,
      album: track.album ?? null,
      isFavorite: !!track.isFavorite,
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
      waveformStatus: track.waveformStatus ?? null,
    };
  }

  function serializeTrackLocal(track) {
    return {
      id: track.id,
      name: track.name,
      userRenamed: !!track.userRenamed,
      fileName: track.fileName,
      artist: track.artist ?? null,
      album: track.album ?? null,
      isFavorite: !!track.isFavorite,
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
      waveformStatus: track.waveformStatus ?? null,
    };
  }

  function deserializeTrack(entry) {
    const normalizedFavorite = coerceDropboxBoolean(entry?.isFavorite);
    const normalizedRating = coerceDropboxNumber(entry?.rating);
    const normalizedGain = coerceDropboxNumber(entry?.normalizationGain);
    return {
      id: entry.id,
      name: entry.name,
      userRenamed: !!entry.userRenamed,
      fileName: entry.fileName ?? entry.name,
      artist: entry.artist || '',
      album: entry.album || '',
      isFavorite: normalizedFavorite !== null ? normalizedFavorite : false,
      url: null,
      duration: entry.duration ?? null,
      updatedAt: entry.updatedAt ?? null,
      rating: normalizedRating !== null ? normalizedRating : 0,
      normalizationGain: normalizedGain !== null ? normalizedGain : null,
      size: entry.size ?? null,
      lastModified: entry.lastModified ?? null,
      dropboxPath: entry.dropboxPath ?? null,
      dropboxRev: entry.dropboxRev ?? null,
      dropboxSize: entry.dropboxSize ?? null,
      dropboxUpdatedAt: entry.dropboxUpdatedAt ?? null,
      waveform: entry.waveform ?? null,
      waveformStatus: entry.waveformStatus ?? null,
      urlExpiresAt: 0,
      isRemote: Boolean(entry.dropboxPath),
    };
  }

  return {
    ensureSharedTrackReferences,
    serializeTrack,
    serializeTrackLocal,
    deserializeTrack,
  };
}
