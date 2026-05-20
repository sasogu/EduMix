function normalizeFileName(name) {
  return (name || '').toLowerCase().trim();
}

function normalizeName(name) {
  return (name || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Finds groups of duplicate tracks across all non-auto playlists.
 * Returns [{criterion, key, items: [{track, playlistRefs:[{id,name}]}]}]
 *
 * criterion 'fileName'       → identical original file name
 * criterion 'nameAndDuration'→ same display name + duration within ±2s
 */
export function findDuplicateTracks(playlists) {
  // Build a deduplicated map of trackId → {track, playlistRefs[]}
  const trackMap = new Map();

  for (const playlist of playlists || []) {
    if (!playlist || playlist.isAuto) continue;
    for (const track of playlist.tracks || []) {
      if (!track?.id) continue;
      if (!trackMap.has(track.id)) {
        trackMap.set(track.id, { track, playlistRefs: [] });
      }
      trackMap.get(track.id).playlistRefs.push({ id: playlist.id, name: playlist.name });
    }
  }

  const allEntries = Array.from(trackMap.values());
  const groups = [];
  const usedTrackIds = new Set();

  // ── Criterion 1: identical fileName ──
  const byFileName = new Map();
  for (const entry of allEntries) {
    const key = normalizeFileName(entry.track.fileName);
    if (!key) continue;
    if (!byFileName.has(key)) byFileName.set(key, []);
    byFileName.get(key).push(entry);
  }
  for (const [key, entries] of byFileName) {
    if (entries.length < 2) continue;
    groups.push({ criterion: 'fileName', key, items: entries });
    for (const e of entries) usedTrackIds.add(e.track.id);
  }

  // ── Criterion 2: same name + duration within ±2s (excludes already found) ──
  const remaining = allEntries.filter(e => !usedTrackIds.has(e.track.id));
  const DURATION_TOLERANCE = 2;

  const byName = new Map();
  for (const entry of remaining) {
    const key = normalizeName(entry.track.name || entry.track.fileName);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(entry);
  }

  for (const [key, nameGroup] of byName) {
    if (nameGroup.length < 2) continue;
    const assigned = new Set();
    for (let i = 0; i < nameGroup.length; i++) {
      if (assigned.has(i)) continue;
      const dA = nameGroup[i].track.duration || 0;
      const cluster = [nameGroup[i]];
      for (let j = i + 1; j < nameGroup.length; j++) {
        if (assigned.has(j)) continue;
        const dB = nameGroup[j].track.duration || 0;
        if (Math.abs(dA - dB) <= DURATION_TOLERANCE) {
          cluster.push(nameGroup[j]);
          assigned.add(j);
        }
      }
      assigned.add(i);
      if (cluster.length >= 2) {
        groups.push({ criterion: 'nameAndDuration', key, items: cluster });
      }
    }
  }

  return groups;
}
