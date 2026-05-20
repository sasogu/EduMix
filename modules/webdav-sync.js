export function createWebdavSync({
  state,
  pendingUploads,
  getAllTracks,
  getActivePlaylist,
  serializeTrack,
  deserializeTrack,
  persistLocalPlaylist,
  renderPlaylist,
  updateControls,
  schedulePlaylistRender,
  scheduleStorageStatsUpdate,
  storeTrackFile,
  loadTrackFile,
  formatBytes,
  sleep,
  isNetworkError,
  generateId,
  applyRemoteDocumentToState,
  mergePlaylistDocuments,
  createPlaylistObject,
  loadDeletedPlaylistIds,
  recordDeletedPlaylistId,
  AUTO_PLAYLISTS,
  getTrackArtist,
  ensureTrackMetadata,
  ensureSharedTrackReferences,
  ensurePlaylistsInitialized,
  onStatusChange,
  onError,
  applyFetchedSettings,
  ensureEqState,
}) {
  const WEBDAV_AUTO_SYNC_MAX_BYTES = 150 * 1024 * 1024;

  // === Claves de almacenamiento ===
  const SK_AUTH = 'edumix-webdav-auth';
  const SK_PENDING = 'edumix-webdav-pending-deletions';
  const SK_PER_LIST_META = 'edumix-webdav-perlist-meta';

  // === Estado interno ===
  let auth = _loadAuth();
  const syncState = {
    isSyncing: false,
    syncQueued: null,
    lastSync: null,
    error: null,
    largeSyncNotice: null,
    netStrikes: 0,
    pausedUntil: 0,
    progressTotal: 0,
    progressDone: 0,
    pendingBytesTotal: 0,
    pendingBytesDone: 0,
  };
  let perListMeta = {};
  let settingsMeta = { etag: null, serverModified: null };
  const remoteLinkInFlight = new Map();
  let pendingDeletions = new Set();

  // === Auth ===
  function _loadAuth() {
    try {
      const raw = localStorage.getItem(SK_AUTH);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function _saveAuth(a) {
    auth = a;
    if (!a) localStorage.removeItem(SK_AUTH);
    else localStorage.setItem(SK_AUTH, JSON.stringify(a));
  }

  function isConnected() {
    return Boolean(auth?.serverUrl && auth?.username && auth?.appPassword);
  }

  function _authHeader(credentials) {
    const creds = credentials || (auth ? `${auth.username}:${auth.appPassword}` : '');
    try {
      return `Basic ${btoa(creds)}`;
    } catch {
      return `Basic ${btoa(unescape(encodeURIComponent(creds)))}`;
    }
  }

  function authHeader() {
    return _authHeader();
  }

  // === URLs ===
  function baseUrl() {
    const url = auth.serverUrl.replace(/\/$/, '');
    return `${url}/remote.php/dav/files/${encodeURIComponent(auth.username)}/EduMix`;
  }

  function hrefToUrl(href) {
    if (!href) return null;
    if (href.startsWith('http://') || href.startsWith('https://')) return href;
    try {
      const origin = new URL(auth.serverUrl).origin;
      return `${origin}${href}`;
    } catch { return href; }
  }

  function sanitizeFileName(name) {
    return (name || 'track').toString().trim().slice(0, 100)
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '') || 'track';
  }

  function getAudioPath(track) {
    const uploadName = track.fileName || track.name || `${track.id}.mp3`;
    const safe = sanitizeFileName(uploadName);
    return `${baseUrl()}/audio/${track.id}_${safe}`;
  }

  function getPlaylistPath(playlist) {
    const safeName = sanitizeFileName(playlist.name || 'Lista');
    return `${baseUrl()}/Playlists/${playlist.id}_${safeName}.json`;
  }

  function getSettingsPath() {
    return `${baseUrl()}/Playlists/_settings.json`;
  }

  // === PROPFIND ===
  function parsePropfind(xml) {
    try {
      const NS = 'DAV:';
      const doc = new DOMParser().parseFromString(xml, 'application/xml');
      const responses = doc.getElementsByTagNameNS(NS, 'response');
      return Array.from(responses).map(r => {
        const href = r.getElementsByTagNameNS(NS, 'href')[0]?.textContent?.trim() || '';
        const prop = r.getElementsByTagNameNS(NS, 'prop')[0];
        const rawEtag = prop?.getElementsByTagNameNS(NS, 'getetag')[0]?.textContent || null;
        const etag = rawEtag ? rawEtag.replace(/^"|"$/g, '').trim() : null;
        const contentLength = prop?.getElementsByTagNameNS(NS, 'getcontentlength')[0]?.textContent?.trim() || null;
        const lastModified = prop?.getElementsByTagNameNS(NS, 'getlastmodified')[0]?.textContent?.trim() || null;
        const resourceType = prop?.getElementsByTagNameNS(NS, 'resourcetype')[0];
        const isCollection = Boolean(resourceType?.getElementsByTagNameNS(NS, 'collection')[0]);
        return {
          href: hrefToUrl(href),
          etag,
          contentLength: contentLength ? Number(contentLength) : null,
          lastModified,
          isCollection,
        };
      });
    } catch { return []; }
  }

  async function propfind(url, depth = '1') {
    const body = `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:getcontentlength/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>`;
    try {
      const response = await fetch(url, {
        method: 'PROPFIND',
        headers: { Authorization: authHeader(), 'Content-Type': 'application/xml', Depth: depth },
        body,
      });
      if (!response.ok) return null;
      const xml = await response.text();
      return parsePropfind(xml);
    } catch { return null; }
  }

  // === Creación de carpetas ===
  async function ensureFolder(url) {
    try {
      const response = await fetch(url, {
        method: 'MKCOL',
        headers: { Authorization: authHeader() },
      });
      return response.ok || response.status === 405 || response.status === 409;
    } catch { return false; }
  }

  async function ensureFolders() {
    await ensureFolder(baseUrl());
    await ensureFolder(`${baseUrl()}/audio`);
    await ensureFolder(`${baseUrl()}/Playlists`);
  }

  // === Configuración (sin OAuth) ===
  async function configure({ serverUrl, username, appPassword }) {
    const trimmedUrl = (serverUrl || '').trim().replace(/\/$/, '');
    const trimmedUser = (username || '').trim();
    const trimmedPass = (appPassword || '').trim();
    if (!trimmedUrl || !trimmedUser || !trimmedPass) {
      onError('Faltan datos de conexión WebDAV.');
      return false;
    }
    try {
      const testUrl = `${trimmedUrl}/remote.php/dav/files/${encodeURIComponent(trimmedUser)}/`;
      const body = `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/></d:prop></d:propfind>`;
      const resp = await fetch(testUrl, {
        method: 'PROPFIND',
        headers: {
          Authorization: _authHeader(`${trimmedUser}:${trimmedPass}`),
          'Content-Type': 'application/xml',
          Depth: '0',
        },
        body,
      });
      if (!resp.ok && resp.status !== 207) {
        onError('No se pudo conectar con Nextcloud. Verifica la URL y las credenciales.');
        return false;
      }
    } catch {
      onError('No se pudo conectar con Nextcloud. Verifica la URL y las credenciales.');
      return false;
    }
    _saveAuth({ serverUrl: trimmedUrl, username: trimmedUser, appPassword: trimmedPass });
    syncState.error = null;
    onStatusChange();
    return true;
  }

  async function beginAuth() {
    // WebDAV usa configure() en lugar de OAuth
  }

  async function handleRedirect() {
    // Sin redirección OAuth
  }

  async function ensureToken() {
    return isConnected() ? auth : null;
  }

  function disconnect() {
    _saveAuth(null);
    syncState.error = null;
    syncState.isSyncing = false;
    syncState.syncQueued = null;
    onStatusChange();
  }

  // === Persistencia de estado ===
  function loadPersistedState(data) {
    if (Array.isArray(data?.webdavPendingDeletions)) {
      pendingDeletions = new Set(data.webdavPendingDeletions);
    }
    try {
      const raw = localStorage.getItem(SK_PENDING);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) arr.forEach(p => pendingDeletions.add(String(p)));
      }
    } catch {}
    if (data?.webdavPerListMeta && typeof data.webdavPerListMeta === 'object') {
      perListMeta = data.webdavPerListMeta;
    }
    try {
      const raw = localStorage.getItem(SK_PER_LIST_META);
      if (raw) {
        const meta = JSON.parse(raw);
        if (meta && typeof meta === 'object') perListMeta = { ...(perListMeta || {}), ...meta };
      }
    } catch {}
    if (data?.webdavSettingsMeta && typeof data.webdavSettingsMeta === 'object') {
      settingsMeta = data.webdavSettingsMeta;
    }
  }

  function getPersistedState() {
    return {
      webdavPendingDeletions: Array.from(pendingDeletions),
      webdavPerListMeta: perListMeta,
      webdavSettingsMeta: settingsMeta,
    };
  }

  function persistSidecarState() {
    try {
      localStorage.setItem(SK_PENDING, JSON.stringify(Array.from(pendingDeletions)));
    } catch {}
    try {
      if (perListMeta && typeof perListMeta === 'object') {
        localStorage.setItem(SK_PER_LIST_META, JSON.stringify(perListMeta));
      }
    } catch {}
  }

  // === Inspección ===
  function getPendingChanges() {
    const uploads = pendingUploads ? pendingUploads.size : 0;
    const deletes = pendingDeletions ? pendingDeletions.size : 0;
    const since = Number(syncState?.lastSync) || 0;
    let listsChanged = 0;
    try {
      listsChanged = state.playlists.filter(pl => Number(pl.updatedAt || 0) > since).length;
    } catch {}
    return { uploads, deletes, listsChanged };
  }

  function hasFailedUploads() {
    return getAllTracks().some(t => !t.webdavPath && t._sync === 'error');
  }

  function estimateTrackUploadSize(track) {
    if (!track) return null;
    const file = pendingUploads.get(track.id);
    const fileSize = typeof file?.size === 'number' ? file.size : null;
    const candidates = [fileSize, track.webdavSize, track.size];
    for (const c of candidates) {
      if (typeof c === 'number' && Number.isFinite(c) && c > 0) return c;
    }
    return null;
  }

  function estimateUploadPlan(tracks) {
    const sizeByTrack = new Map();
    let totalBytes = 0;
    if (Array.isArray(tracks)) {
      tracks.forEach(track => {
        if (!track || !track.id || sizeByTrack.has(track.id)) return;
        const size = estimateTrackUploadSize(track);
        if (Number.isFinite(size) && size > 0) {
          sizeByTrack.set(track.id, size);
          totalBytes += size;
        }
      });
    }
    return { totalBytes, sizeByTrack };
  }

  function addPendingDeletion(path) {
    if (path) pendingDeletions.add(path);
  }

  // === Descarga de pistas ===
  async function ensureTrackUrl(track) {
    if (!track || !track.webdavPath) return false;
    if (track.url && track.url.startsWith('blob:')) return true;
    if (track._remoteRetryAt && Date.now() < track._remoteRetryAt) return false;
    if (remoteLinkInFlight.has(track.id)) {
      try { return await remoteLinkInFlight.get(track.id); } finally {}
    }
    const run = (async () => {
      if (!isConnected()) return false;
      try {
        const response = await fetch(track.webdavPath, {
          headers: { Authorization: authHeader() },
        });
        if (!response.ok) {
          if (response.status === 404 || response.status === 410) {
            if (pendingUploads.has(track.id)) {
              track.webdavPath = null;
              track.webdavEtag = null;
              track.webdavSize = null;
              track.webdavUpdatedAt = null;
              track.isRemote = false;
              track.urlExpiresAt = 0;
              track._sync = 'queued';
              persistLocalPlaylist();
              onStatusChange();
              requestSync({ loadRemote: false, onlyTrackIds: [track.id] });
              onError('Archivo no encontrado en el servidor. Re-subiendo desde copia local.');
            } else {
              track._remoteRetryAt = Date.now() + 5 * 60 * 1000;
            }
          } else {
            track._remoteRetryAt = Date.now() + 60 * 1000;
            onError('No se pudo obtener el audio desde el servidor WebDAV.');
          }
          return false;
        }
        const blob = await response.blob();
        const fileName = track.fileName || `${track.id}.mp3`;
        const fileType = blob.type || 'audio/mpeg';
        const fileLike = typeof File === 'function'
          ? new File([blob], fileName, { type: fileType, lastModified: Date.now() })
          : blob;
        await storeTrackFile(track.id, fileLike).catch(console.error);
        if (track.url && track.url.startsWith('blob:')) {
          try { URL.revokeObjectURL(track.url); } catch {}
        }
        track.url = URL.createObjectURL(blob);
        track.size = blob.size;
        track.fileName = fileName;
        track.lastModified = Date.now();
        track.isRemote = true;
        track.urlExpiresAt = 0;
        return true;
      } catch (error) {
        console.error('Error descargando pista desde WebDAV', error);
        track._remoteRetryAt = Date.now() + 60 * 1000;
        onError('No se pudo obtener el audio desde el servidor WebDAV.');
        return false;
      }
    })();
    remoteLinkInFlight.set(track.id, run);
    try { return await run; } finally { remoteLinkInFlight.delete(track.id); }
  }

  // === Subida de pistas ===
  async function uploadOneTrackWithRetry(track) {
    let file = pendingUploads.get(track.id);
    let uploadName = track.fileName || `${track.id}.mp3`;
    if (!file) {
      const stored = await loadTrackFile(track.id);
      if (stored) {
        const blob = new Blob([stored.buffer], { type: stored.type || 'audio/mpeg' });
        uploadName = track.fileName || stored.name || uploadName;
        file = typeof File === 'function'
          ? new File([blob], uploadName, { type: stored.type || blob.type || 'audio/mpeg', lastModified: stored.lastModified || track.lastModified || Date.now() })
          : blob;
      } else if (track.url && track.url.startsWith('blob:')) {
        try {
          const resp = await fetch(track.url);
          if (resp.ok) {
            const blob = await resp.blob();
            file = typeof File === 'function'
              ? new File([blob], uploadName, { type: blob.type || 'audio/mpeg', lastModified: track.lastModified || Date.now() })
              : blob;
          }
        } catch {}
      }
    } else if (typeof file.name === 'string') {
      uploadName = file.name;
    }
    if (!file) {
      track._sync = 'error';
      onError(`No se encontró copia local de ${track.name || track.fileName}. Vuelve a importarla para subir.`);
      return;
    }
    const safeName = sanitizeFileName(uploadName);
    const remotePath = `${baseUrl()}/audio/${track.id}_${safeName}`;
    const maxRetries = 5;
    let attempt = 0;
    while (attempt <= maxRetries) {
      try {
        const response = await fetch(remotePath, {
          method: 'PUT',
          headers: {
            Authorization: authHeader(),
            'Content-Type': file.type || 'audio/mpeg',
          },
          body: file,
        });
        if (!response.ok) {
          if (attempt >= maxRetries) {
            track._sync = 'error';
            onError(`Error subiendo ${uploadName}.`);
            return;
          }
          await sleep(Math.min(16000, 1000 * Math.pow(2, attempt)) + Math.random() * 300);
          attempt += 1;
          continue;
        }
        const rawEtag = response.headers.get('ETag');
        track.webdavPath = remotePath;
        track.webdavEtag = rawEtag ? rawEtag.replace(/^"|"$/g, '') : null;
        track.webdavSize = file.size || null;
        track.webdavUpdatedAt = Date.now();
        track.isRemote = true;
        track.urlExpiresAt = 0;
        pendingUploads.delete(track.id);
        persistLocalPlaylist();
        return;
      } catch (error) {
        if (attempt >= maxRetries) {
          console.error(`No se pudo subir ${uploadName}`, error);
          track._sync = 'error';
          onError(`Error subiendo ${uploadName}.`);
          return;
        }
        await sleep(Math.min(16000, 1000 * Math.pow(2, attempt)) + Math.random() * 300);
        attempt += 1;
      }
    }
  }

  async function uploadPendingTracks(list, options = {}) {
    const candidates = Array.isArray(list) ? list : getAllTracks().filter(t => !t.webdavPath);
    const sizeByTrack = options?.sizeByTrack instanceof Map ? options.sizeByTrack : new Map();
    if (!candidates.length) return;
    for (const track of candidates) {
      track._sync = 'uploading';
      schedulePlaylistRender();
      await uploadOneTrackWithRetry(track);
      if (track.webdavPath) {
        syncState.progressDone += 1;
        const size = sizeByTrack.get(track.id) || estimateTrackUploadSize(track) || 0;
        if (Number.isFinite(size) && size > 0) {
          syncState.pendingBytesDone += size;
          if (Number.isFinite(syncState.pendingBytesTotal) && syncState.pendingBytesTotal > 0) {
            syncState.pendingBytesDone = Math.min(syncState.pendingBytesDone, syncState.pendingBytesTotal);
          }
        }
        track._sync = 'done';
      } else {
        track._sync = track._sync || null;
      }
      onStatusChange();
      schedulePlaylistRender();
    }
    scheduleStorageStatsUpdate();
  }

  // === Guardar playlists en WebDAV ===
  async function savePlaylistsPerList() {
    await ensureFolders();
    for (const pl of state.playlists) {
      if (pl.isAuto) continue;
      const payload = {
        version: 2,
        id: pl.id,
        name: pl.name,
        updatedAt: pl.updatedAt ?? Date.now(),
        tracks: pl.tracks.map(serializeTrack),
      };
      const desiredPath = getPlaylistPath(pl);
      const meta = perListMeta[pl.id] || { path: desiredPath, etag: null };
      if (meta.path === desiredPath && meta.etag && meta.savedUpdatedAt === pl.updatedAt) continue;
      if (meta.path && meta.path !== desiredPath) {
        pendingDeletions.add(meta.path);
        meta.etag = null;
      }
      const body = JSON.stringify(payload);
      const maxRetries = 4;
      let attempt = 0;
      while (attempt <= maxRetries) {
        try {
          const headers = { Authorization: authHeader(), 'Content-Type': 'application/json' };
          if (meta.etag && meta.path === desiredPath) headers['If-Match'] = meta.etag;
          const response = await fetch(desiredPath, { method: 'PUT', headers, body });
          if (response.status === 412) {
            const head = await fetch(desiredPath, { method: 'HEAD', headers: { Authorization: authHeader() } });
            const freshEtag = head.headers.get('ETag')?.replace(/^"|"$/g, '') || null;
            meta.etag = freshEtag;
            perListMeta[pl.id] = { ...meta };
            attempt += 1;
            await sleep(200 + Math.random() * 200);
            continue;
          }
          if (!response.ok) {
            if (attempt >= maxRetries) { console.error('Error guardando playlist en WebDAV', desiredPath); break; }
            await sleep(Math.min(8000, 1000 * Math.pow(2, attempt)) + Math.random() * 200);
            attempt += 1;
            continue;
          }
          const rawEtag = response.headers.get('ETag');
          perListMeta[pl.id] = {
            path: desiredPath,
            etag: rawEtag ? rawEtag.replace(/^"|"$/g, '') : null,
            serverModified: new Date().toISOString(),
            savedUpdatedAt: pl.updatedAt,
          };
          break;
        } catch (error) {
          if (attempt >= maxRetries) { console.error('Error guardando playlist', error); break; }
          await sleep(Math.min(8000, 1000 * Math.pow(2, attempt)) + Math.random() * 200);
          attempt += 1;
        }
      }
    }
    persistLocalPlaylist();
  }

  async function saveSettings() {
    const payload = {
      version: 1,
      updatedAt: Date.now(),
      activePlaylistId: state.activePlaylistId,
      fadeDuration: state.fadeDuration,
      autoLoop: state.autoLoop,
      shuffle: state.shuffle,
      preferLocalSource: state.preferLocalSource,
      playbackRate: state.playbackRate,
      normalizationEnabled: state.normalizationEnabled,
      autoSync: !!state.autoSync,
      eqBoost: ensureEqState(),
    };
    const path = getSettingsPath();
    const headers = { Authorization: authHeader(), 'Content-Type': 'application/json' };
    if (settingsMeta?.etag) headers['If-Match'] = settingsMeta.etag;
    try {
      const response = await fetch(path, { method: 'PUT', headers, body: JSON.stringify(payload) });
      if (response.ok) {
        const rawEtag = response.headers.get('ETag');
        settingsMeta = {
          etag: rawEtag ? rawEtag.replace(/^"|"$/g, '') : null,
          serverModified: new Date().toISOString(),
        };
        persistLocalPlaylist();
      }
    } catch (error) {
      console.warn('Error guardando settings en WebDAV', error);
    }
  }

  // === Cargar playlists desde WebDAV ===
  function _coerceBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 1) return true;
    if (value === 'false' || value === 0) return false;
    return null;
  }

  function _coerceNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') { const n = Number(value); if (Number.isFinite(n)) return n; }
    return null;
  }

  async function pullPlaylistsPerList() {
    const listingUrl = `${baseUrl()}/Playlists/`;
    const entries = await propfind(listingUrl, '1');
    if (!entries) return;

    const jsonFiles = entries.filter(e => {
      if (e.isCollection) return false;
      const lower = (e.href || '').toLowerCase();
      if (!lower.endsWith('.json')) return false;
      if (lower.endsWith('/_settings.json')) return false;
      if (pendingDeletions.has(e.href)) return false;
      return true;
    });

    const cachedByPath = new Map();
    Object.entries(perListMeta).forEach(([id, m]) => {
      if (m?.path) cachedByPath.set(m.path, { id, etag: m.etag });
    });

    const downloaded = (await Promise.all(jsonFiles.map(async (file) => {
      const cached = cachedByPath.get(file.href);
      if (cached?.etag && cached.etag === file.etag) {
        const localPl = state.playlists.find(p => p.id === cached.id);
        if (localPl) return null;
      }
      try {
        const resp = await fetch(file.href, { headers: { Authorization: authHeader() } });
        if (!resp.ok) return null;
        const rawEtag = resp.headers.get('ETag');
        const etag = rawEtag ? rawEtag.replace(/^"|"$/g, '') : (file.etag || null);
        const doc = await resp.json().catch(() => null);
        return (doc && doc.id) ? { href: file.href, etag, doc } : null;
      } catch { return null; }
    }))).filter(Boolean);

    const mapLocalTracks = new Map();
    const mapLocalPlaylistMeta = new Map();
    state.playlists.forEach(pl => {
      if (pl.isAuto) return;
      mapLocalPlaylistMeta.set(pl.id, { name: pl.name, updatedAt: pl.updatedAt });
      pl.tracks.forEach(t => mapLocalTracks.set(t.id, { track: t, playlistId: pl.id }));
    });

    const nextPlaylists = [];
    const deletedPlaylistIds = loadDeletedPlaylistIds();
    const remotePaths = new Set(jsonFiles.map(f => f.href).filter(Boolean));

    downloaded.forEach(({ href, etag, doc }) => {
      const sourceId = doc.id || generateId('pl');
      if (deletedPlaylistIds.has(sourceId)) return;
      const autoConfig = doc.autoType ? AUTO_PLAYLISTS[doc.autoType] : null;
      const id = autoConfig?.id || sourceId;
      const playlist = {
        id,
        name: autoConfig?.name || doc.name || 'Lista',
        updatedAt: doc.updatedAt ?? Date.now(),
        tracks: [],
        isAuto: Boolean(doc.isAuto || autoConfig),
        autoType: doc.autoType || (autoConfig ? 'favorites' : null),
      };
      perListMeta[id] = { path: href, etag, serverModified: new Date().toISOString() };

      if (Array.isArray(doc.tracks)) {
        doc.tracks.forEach(entry => {
          if (!entry?.id) return;
          const existing = mapLocalTracks.get(entry.id)?.track;
          const track = existing ? existing : deserializeTrack(entry);
          if (existing) mapLocalTracks.delete(entry.id);

          const remoteHasName = typeof entry.name === 'string' && entry.name.length > 0;
          const localRenamed = !!track.userRenamed;
          const remoteRenamed = !!entry.userRenamed;
          const localTs = Number(track.updatedAt || 0);
          const remoteTs = Number(entry.updatedAt || 0);
          if (remoteHasName) {
            if (localRenamed && (!remoteRenamed || localTs >= remoteTs)) {
              // conservar local
            } else if (remoteRenamed && remoteTs > localTs) {
              track.name = entry.name; track.userRenamed = true;
            } else if (!localRenamed && remoteTs >= localTs) {
              track.name = entry.name; track.userRenamed = !!entry.userRenamed;
            }
          }

          track.fileName = entry.fileName ?? track.fileName ?? track.name;

          const remoteArtist = typeof entry.artist === 'string' ? entry.artist.trim() : '';
          if (remoteArtist) track.artist = remoteArtist;
          const remoteAlbum = typeof entry.album === 'string' ? entry.album.trim() : '';
          if (remoteAlbum) track.album = remoteAlbum;

          const remoteFavorite = _coerceBoolean(entry.isFavorite);
          if (remoteFavorite !== null) {
            const rTs = Number(entry.updatedAt || 0); const lTs = Number(track.updatedAt || 0);
            if (rTs >= lTs || typeof track.isFavorite !== 'boolean') track.isFavorite = remoteFavorite;
          }

          if (Number.isFinite(entry.duration)) track.duration = entry.duration;

          const remoteGain = _coerceNumber(entry.normalizationGain);
          if (remoteGain !== null) track.normalizationGain = remoteGain;

          const remoteRating = _coerceNumber(entry.rating);
          if (remoteRating !== null) {
            const rTs = Number(entry.updatedAt || 0); const lTs = Number(track.updatedAt || 0);
            if (rTs >= lTs || !Number.isFinite(track.rating)) track.rating = remoteRating;
          }

          if (entry.webdavPath) {
            track.webdavPath = entry.webdavPath;
            track.webdavEtag = entry.webdavEtag ?? track.webdavEtag ?? null;
            track.webdavSize = entry.webdavSize ?? track.webdavSize ?? null;
            track.webdavUpdatedAt = entry.webdavUpdatedAt ?? track.webdavUpdatedAt ?? null;
            track.isRemote = true;
          }
          track.url = null;
          track.urlExpiresAt = 0;
          if (entry.waveform?.peaks?.length) {
            track.waveform = entry.waveform; track.waveformStatus = entry.waveformStatus ?? null;
          } else if (typeof entry.waveformStatus === 'string') {
            track.waveformStatus = entry.waveformStatus;
          }
          track.updatedAt = entry.updatedAt ?? track.updatedAt ?? null;

          playlist.tracks.push(track);
          if (!getTrackArtist(track) && track.isFavorite) ensureTrackMetadata(track).catch(() => {});
        });
      }
      nextPlaylists.push(playlist);
    });

    const seenLocalIds = new Set(nextPlaylists.map(p => p.id));
    state.playlists.forEach(pl => {
      if (pl.isAuto || seenLocalIds.has(pl.id)) return;
      const meta = perListMeta[pl.id];
      if (meta?.path && remotePaths.has(meta.path)) {
        nextPlaylists.push(pl);
        return;
      }
      if (pl.tracks.length > 0 && !deletedPlaylistIds.has(pl.id)) {
        nextPlaylists.push(pl);
      }
    });

    mapLocalTracks.forEach(({ track, playlistId }) => {
      let targetPl = nextPlaylists.find(p => p.id === playlistId);
      if (!targetPl) {
        const localMeta = mapLocalPlaylistMeta.get(playlistId);
        targetPl = { id: playlistId || generateId('pl'), name: localMeta?.name || 'Lista local', tracks: [], isAuto: false, autoType: null };
        nextPlaylists.push(targetPl);
      }
      if (!targetPl.tracks.some(t => t.id === track.id)) targetPl.tracks.push(track);
    });

    state.playlists = nextPlaylists;
    ensureSharedTrackReferences();
    ensurePlaylistsInitialized();
    persistLocalPlaylist();
  }

  async function pullSettings() {
    const path = getSettingsPath();
    try {
      const response = await fetch(path, { headers: { Authorization: authHeader() } });
      if (!response.ok) return;
      const rawEtag = response.headers.get('ETag');
      const etag = rawEtag ? rawEtag.replace(/^"|"$/g, '') : null;
      const json = await response.json().catch(() => null);
      if (!json) return;
      if (etag) settingsMeta = { etag, serverModified: new Date().toISOString() };
      applyFetchedSettings(json);
      persistLocalPlaylist();
    } catch (error) {
      console.warn('Error cargando settings desde WebDAV', error);
    }
  }

  // === Eliminaciones pendientes ===
  async function processPendingDeletions() {
    if (!pendingDeletions.size) return;
    const toDelete = Array.from(pendingDeletions);
    for (const path of toDelete) {
      try {
        const response = await fetch(path, {
          method: 'DELETE',
          headers: { Authorization: authHeader() },
        });
        if (response.ok || response.status === 404 || response.status === 410) {
          pendingDeletions.delete(path);
        }
      } catch (error) {
        console.warn('Error eliminando archivo WebDAV', path, error);
      }
    }
    persistLocalPlaylist();
    scheduleStorageStatsUpdate();
  }

  async function forceDeleteRemainder() {
    await processPendingDeletions();
  }

  // === Sincronización principal ===
  function requestSync(options = {}) {
    if (!isConnected()) return;
    if (!state.autoSync) return;
    performSync({ ...options, triggeredAutomatically: true }).catch(console.error);
  }

  async function performSync(options = {}) {
    if (!isConnected()) return;
    if (!navigator.onLine) { onError('Sin conexión. Conéctate a Internet.'); return; }
    const nowTs = Date.now();
    if (Number(syncState.pausedUntil || 0) > nowTs) {
      const secs = Math.ceil((syncState.pausedUntil - nowTs) / 1000);
      onError(`Red inestable. Reintenta en ${secs}s.`);
      return;
    }
    const effective = {
      loadRemote: Boolean(options.loadRemote),
      onlyTrackIds: Array.isArray(options.onlyTrackIds) ? options.onlyTrackIds.slice() : null,
      triggeredAutomatically: Boolean(options.triggeredAutomatically),
    };
    if (syncState.isSyncing) {
      const queuedIds = new Set([...(syncState.syncQueued?.onlyTrackIds || []), ...(effective.onlyTrackIds || [])]);
      syncState.syncQueued = {
        loadRemote: effective.loadRemote || Boolean(syncState?.syncQueued?.loadRemote),
        onlyTrackIds: Array.from(queuedIds),
      };
      return;
    }
    const scopeTracks = effective.onlyTrackIds ? getAllTracks() : (getActivePlaylist()?.tracks || state.tracks || []);
    const baseCandidates = scopeTracks.filter(t => !t.webdavPath);
    const isManualSubset = !!effective.onlyTrackIds;
    const candidates = isManualSubset
      ? baseCandidates.filter(t => effective.onlyTrackIds.includes(t.id))
      : baseCandidates;
    const { totalBytes: estimatedBytes, sizeByTrack } = estimateUploadPlan(candidates);
    if (effective.triggeredAutomatically && estimatedBytes > WEBDAV_AUTO_SYNC_MAX_BYTES && candidates.length) {
      syncState.largeSyncNotice = { reason: 'auto-limit', count: candidates.length, totalBytes: estimatedBytes };
      syncState.pendingBytesTotal = estimatedBytes;
      syncState.pendingBytesDone = 0;
      syncState.progressTotal = candidates.length;
      syncState.progressDone = 0;
      onStatusChange();
      return;
    }
    syncState.isSyncing = true;
    syncState.error = null;
    syncState.largeSyncNotice = null;
    syncState.progressTotal = candidates.length;
    syncState.progressDone = 0;
    syncState.pendingBytesTotal = estimatedBytes;
    syncState.pendingBytesDone = 0;
    candidates.forEach(t => { t._sync = 'queued'; });
    schedulePlaylistRender();
    onStatusChange();
    try {
      if (effective.loadRemote) {
        await pullPlaylistsPerList();
        await pullSettings().catch(() => {});
      }
      await uploadPendingTracks(candidates, { sizeByTrack });
      await processPendingDeletions();
      await savePlaylistsPerList();
      await saveSettings().catch(() => {});
      syncState.lastSync = Date.now();
      syncState.netStrikes = 0;
    } catch (error) {
      console.error('WebDAV sync error', error);
      syncState.error = error;
      onError('No se pudo sincronizar con Nextcloud/WebDAV.');
      if (isNetworkError(error)) {
        syncState.netStrikes = (Number(syncState.netStrikes) || 0) + 1;
        if (syncState.netStrikes >= 3) syncState.pausedUntil = Date.now() + 30000;
      } else {
        syncState.netStrikes = 0;
      }
    } finally {
      syncState.isSyncing = false;
      syncState.progressTotal = 0;
      syncState.progressDone = 0;
      syncState.pendingBytesTotal = 0;
      syncState.pendingBytesDone = 0;
      getAllTracks().forEach(t => { if (t._sync && t._sync !== 'error') delete t._sync; });
      onStatusChange();
      const queued = syncState.syncQueued;
      syncState.syncQueued = null;
      if (queued) performSync(queued).catch(console.error);
    }
  }

  // === Interfaz pública ===
  return {
    isConnected,
    getState: () => syncState,
    getAuth: () => auth,
    getPerListMeta: () => perListMeta,
    configure,
    beginAuth,
    handleRedirect,
    disconnect,
    ensureToken,
    requestSync,
    performSync,
    ensureTrackUrl,
    addPendingDeletion,
    getPendingDeletions: () => pendingDeletions,
    loadPersistedState,
    getPersistedState,
    persistSidecarState,
    getPendingChanges,
    hasFailedUploads,
    estimateUploadPlan,
    estimateTrackUploadSize,
    forceDeleteRemainder,
  };
}
