export function createLocalMediaStore(deps) {
  const {
    IDB_CONFIG,
    IDB_MAX_VALUE_BYTES,
    pendingUploads,
    getAllTracks,
  } = deps;

  let mediaDbPromise = null;

  function openMediaDatabase() {
    if (!('indexedDB' in window)) {
      return Promise.resolve(null);
    }
    if (mediaDbPromise) {
      return mediaDbPromise;
    }
    mediaDbPromise = new Promise((resolve) => {
      const tryOpenNoVersion = () => {
        let req;
        try { req = indexedDB.open(IDB_CONFIG.name); } catch (e) { tryOpenWithVersion(IDB_CONFIG.version); return; }
        req.onupgradeneeded = () => {
          const db = req.result;
          try {
            if (!db.objectStoreNames.contains(IDB_CONFIG.store)) {
              db.createObjectStore(IDB_CONFIG.store, { keyPath: 'id' });
            }
          } catch {}
        };
        req.onsuccess = () => {
          const db = req.result;
          try {
            if (!db.objectStoreNames.contains(IDB_CONFIG.store)) {
              const targetVersion = Math.max(IDB_CONFIG.version || 1, (db.version || 1) + 1);
              try { db.close(); } catch {}
              const req2 = indexedDB.open(IDB_CONFIG.name, targetVersion);
              req2.onupgradeneeded = () => {
                const db2 = req2.result;
                try {
                  if (!db2.objectStoreNames.contains(IDB_CONFIG.store)) {
                    db2.createObjectStore(IDB_CONFIG.store, { keyPath: 'id' });
                  }
                } catch {}
              };
              req2.onsuccess = () => resolve(req2.result);
              req2.onerror = () => resolve(null);
            } else {
              resolve(db);
            }
          } catch {
            resolve(db);
          }
        };
        req.onerror = () => {
          tryOpenWithVersion(IDB_CONFIG.version);
        };
      };

      const tryOpenWithVersion = (version) => {
        let req;
        try { req = indexedDB.open(IDB_CONFIG.name, version); } catch (e) { resolve(null); return; }
        req.onupgradeneeded = () => {
          const db = req.result;
          try {
            if (!db.objectStoreNames.contains(IDB_CONFIG.store)) {
              db.createObjectStore(IDB_CONFIG.store, { keyPath: 'id' });
            }
          } catch {}
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      };
      tryOpenNoVersion();
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
    const size = Number(file?.size || 0);
    if (size > IDB_MAX_VALUE_BYTES) {
      console.warn('Archivo demasiado grande para IndexedDB; se omite almacenamiento local', { id, size });
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

  return {
    openMediaDatabase,
    storeTrackFile,
    loadTrackFile,
    deleteTrackFile,
    ensureLocalTrackUrl,
    restoreLocalMedia,
  };
}
