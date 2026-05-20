export function createDropboxSync({
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
  showAppChoice,
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
  updateSpeedUI,
  ensureEqState,
  normalizeEqBoost,
  updateEqUI,
  applyEqSettingsToAll,
  fadeSlider,
  loopToggle,
  fadeValue,
  normalizationToggle,
  preferLocalSourceToggle,
  autoSyncToggle,
}) {
  // === Constantes ===
  const TOKEN_REFRESH_MARGIN = 90 * 1000;
  const DROPBOX_AUTO_SYNC_MAX_BYTES = 150 * 1024 * 1024;
  const DROPBOX_READ_CONCURRENCY = 2;

  // === Configuración ===
  const config = {
    clientId: '118rcuago5bvt6j',
    playlistPath: '/playlist.json',
    playlistsDir: '/Playlists',
    settingsPath: '/Playlists/_settings.json',
    scopes: 'files.metadata.read files.content.read files.content.write',
    redirectUri: `${window.location.origin}${window.location.pathname}`,
  };

  // === Claves de almacenamiento ===
  const SK_AUTH = 'edumix-dropbox-auth';
  const SK_SESSION = 'edumix-dropbox-session';
  const SK_PENDING = 'edumix-dropbox-pending-deletions';
  const SK_PER_LIST_META = 'edumix-dropbox-perlist-meta';

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
  let playlistMeta = { rev: null, serverModified: null };
  let perListMeta = {};
  let settingsMeta = { rev: null, serverModified: null };
  let writeAvailableAt = 0;
  let readAvailableAt = 0;
  let readInFlight = 0;
  const remoteLinkInFlight = new Map();
  const legacyPathPromises = new Map();
  let pendingDeletions = new Set();

  // === Almacenamiento de auth ===
  function _loadAuth() {
    try {
      const raw = localStorage.getItem(SK_AUTH);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.warn('No se pudo cargar la sesión de Dropbox', e);
      return null;
    }
  }

  function _saveAuth(a) {
    auth = a;
    if (!a) {
      localStorage.removeItem(SK_AUTH);
    } else {
      localStorage.setItem(SK_AUTH, JSON.stringify(a));
    }
  }

  // === Ayudantes de coerción ===
  function coerceBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 1) return true;
    if (value === 'false' || value === 0) return false;
    return null;
  }

  function coerceNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  // === Nombres de archivo ===
  function sanitizeDropboxFileName(name) {
    if (!name) return null;
    return String(name).trim().replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || null;
  }

  function sanitizeFileName(name) {
    const base = (name || 'Lista').toString().trim().slice(0, 100).replace(/\.[a-z0-9]+$/i, '');
    const safe = base.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'Lista';
    return `${safe}.json`;
  }

  function getPlaylistPath(playlist) {
    const file = sanitizeFileName(playlist.name || 'Lista');
    return `${config.playlistsDir}/${file}`;
  }

  // === PKCE ===
  async function generateCodeVerifier() {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return base64UrlEncode(array);
  }

  async function generateCodeChallenge(verifier) {
    const data = new TextEncoder().encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return base64UrlEncode(new Uint8Array(digest));
  }

  function base64UrlEncode(buffer) {
    return btoa(String.fromCharCode(...buffer))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  // === Rate limiting ===
  function parseRetryInfo(status, headers, bodyText) {
    let retrySeconds = 0;
    const headerRetry = headers.get && headers.get('Retry-After');
    if (headerRetry) {
      const n = Number(headerRetry);
      if (Number.isFinite(n) && n > 0) retrySeconds = Math.max(retrySeconds, n);
    }
    if (bodyText) {
      try {
        const json = JSON.parse(bodyText);
        const fromBody = Number(json?.error?.retry_after);
        if (Number.isFinite(fromBody) && fromBody > 0) retrySeconds = Math.max(retrySeconds, fromBody);
        const summary = String(json?.error_summary || '');
        if (!retrySeconds && (status === 429 || summary.includes('too_many_write_operations'))) {
          retrySeconds = 1;
        }
      } catch {}
    }
    if (!retrySeconds && (status === 429 || status === 503)) retrySeconds = 1;
    return retrySeconds;
  }

  async function awaitWriteWindow(minDelayMs = 0) {
    const now = Date.now();
    const waitMs = Math.max(0, writeAvailableAt - now, minDelayMs);
    if (waitMs > 0) await sleep(waitMs + Math.random() * 120);
  }

  // === Auth pública ===
  function isConnected() {
    return Boolean(auth?.accessToken && auth?.refreshToken);
  }

  async function beginAuth() {
    const codeVerifier = await generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const stateToken = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    const sessionPayload = { codeVerifier, state: stateToken, redirectUri: config.redirectUri };
    sessionStorage.setItem(SK_SESSION, JSON.stringify(sessionPayload));
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      token_access_type: 'offline',
      scope: config.scopes,
      state: stateToken,
    });
    window.location.href = `https://www.dropbox.com/oauth2/authorize?${params.toString()}`;
  }

  async function handleRedirect() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const stateParam = params.get('state');
    if (!code) return;
    const sessionRaw = sessionStorage.getItem(SK_SESSION);
    sessionStorage.removeItem(SK_SESSION);
    if (!sessionRaw) { console.warn('No session found for Dropbox redirect'); return; }
    const session = JSON.parse(sessionRaw);
    if (session.state !== stateParam) { console.warn('Dropbox state mismatch'); return; }
    try {
      const response = await fetch('https://api.dropboxapi.com/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          grant_type: 'authorization_code',
          client_id: config.clientId,
          redirect_uri: session.redirectUri,
          code_verifier: session.codeVerifier,
        }),
      });
      if (!response.ok) throw new Error('Token exchange failed');
      const data = await response.json();
      const expiresAt = Date.now() + (Number(data.expires_in) * 1000 - TOKEN_REFRESH_MARGIN);
      _saveAuth({ accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt, accountId: data.account_id });
      syncState.error = null;
      onStatusChange();
      await performSync({ loadRemote: true });
    } catch (error) {
      console.error('Error completando autenticación Dropbox', error);
      onError('Fallo al conectar con Dropbox.');
    } finally {
      params.delete('code');
      params.delete('state');
      params.delete('scope');
      params.delete('token_type');
      const newUrl = `${window.location.pathname}${params.toString() ? `?${params}` : ''}${window.location.hash ?? ''}`;
      window.history.replaceState({}, document.title, newUrl);
    }
  }

  async function ensureToken() {
    if (!isConnected()) return null;
    const now = Date.now();
    if (auth.accessToken && auth.expiresAt && now < auth.expiresAt) return auth.accessToken;
    try {
      const response = await fetch('https://api.dropboxapi.com/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: auth.refreshToken, client_id: config.clientId }),
      });
      if (!response.ok) throw new Error('Refresh token failed');
      const data = await response.json();
      auth.accessToken = data.access_token;
      auth.expiresAt = Date.now() + (Number(data.expires_in) * 1000 - TOKEN_REFRESH_MARGIN);
      _saveAuth(auth);
      syncState.error = null;
      return auth.accessToken;
    } catch (error) {
      console.error('Error renovando token Dropbox', error);
      disconnect();
      onError('Sesión expirada, vuelve a conectar Dropbox.');
      return null;
    }
  }

  function disconnect() {
    try {
      const token = auth?.accessToken;
      if (token) {
        fetch('https://api.dropboxapi.com/2/auth/token/revoke', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {});
      }
    } catch {}
    _saveAuth(null);
    syncState.error = null;
    syncState.isSyncing = false;
    syncState.syncQueued = null;
    onStatusChange();
  }

  // === Persistencia de estado ===
  function loadPersistedState(data) {
    if (Array.isArray(data?.pendingDeletions)) {
      pendingDeletions = new Set(data.pendingDeletions);
    }
    try {
      const raw = localStorage.getItem(SK_PENDING);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) arr.forEach(p => pendingDeletions.add(String(p).toLowerCase()));
      }
    } catch {}
    if (data?.playlistRev || data?.playlistServerModified) {
      playlistMeta.rev = data.playlistRev || null;
      playlistMeta.serverModified = data.playlistServerModified || null;
    }
    if (data?.perListMeta && typeof data.perListMeta === 'object') {
      perListMeta = data.perListMeta;
    }
    try {
      const raw = localStorage.getItem(SK_PER_LIST_META);
      if (raw) {
        const meta = JSON.parse(raw);
        if (meta && typeof meta === 'object') perListMeta = { ...(perListMeta || {}), ...meta };
      }
    } catch {}
    if (data?.settingsMeta && typeof data.settingsMeta === 'object') {
      settingsMeta = data.settingsMeta;
    }
  }

  function getPersistedState() {
    return {
      pendingDeletions: Array.from(pendingDeletions),
      playlistRev: playlistMeta.rev || null,
      playlistServerModified: playlistMeta.serverModified || null,
      perListMeta,
      settingsMeta,
    };
  }

  function persistSidecarState() {
    try {
      if (pendingDeletions && typeof pendingDeletions.forEach === 'function') {
        const arr = Array.from(pendingDeletions).map(p => String(p).toLowerCase());
        localStorage.setItem(SK_PENDING, JSON.stringify(arr));
      }
    } catch {}
    try {
      if (perListMeta && typeof perListMeta === 'object') {
        localStorage.setItem(SK_PER_LIST_META, JSON.stringify(perListMeta));
      }
    } catch {}
  }

  // === Inspección de estado ===
  function getPendingChanges() {
    const uploads = pendingUploads ? pendingUploads.size : 0;
    const deletes = pendingDeletions ? pendingDeletions.size : 0;
    const since = Number(syncState?.lastSync) || 0;
    let listsChanged = 0;
    try {
      listsChanged = state.playlists.filter(pl => Number(pl.updatedAt || 0) > since).length;
    } catch { listsChanged = 0; }
    return { uploads, deletes, listsChanged };
  }

  function hasFailedUploads() {
    return getAllTracks().some(t => !t.dropboxPath && t._sync === 'error');
  }

  function estimateTrackUploadSize(track) {
    if (!track) return null;
    const file = pendingUploads.get(track.id);
    const fileSize = typeof file?.size === 'number' ? file.size : null;
    const candidates = [fileSize, track.dropboxSize, track.size];
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

  // === Eliminaciones pendientes ===
  function addPendingDeletion(path) {
    pendingDeletions.add(path);
  }

  // === Descarga de pistas ===
  async function maybeRestoreLegacyPath(track) {
    if (!track || track.dropboxPath || !track.id) return false;
    if (!isConnected()) return false;
    const now = Date.now();
    if (track._legacyRestoreCooldown && now < track._legacyRestoreCooldown) return false;
    if (legacyPathPromises.has(track.id)) {
      try { return await legacyPathPromises.get(track.id); } finally {}
    }
    const run = (async () => {
      const token = await ensureToken();
      if (!token) return false;
      const baseNames = [];
      if (track.fileName) baseNames.push(track.fileName);
      if (track.name && track.name !== track.fileName) {
        if (track.name.includes('.')) baseNames.push(track.name);
        else baseNames.push(`${track.name}.mp3`);
      }
      baseNames.push(`${track.id}.mp3`);
      const candidates = [];
      const seen = new Set();
      baseNames.forEach(base => {
        const safe = sanitizeDropboxFileName(base);
        if (!safe) return;
        const candidate = `/tracks/${track.id}-${safe}`;
        if (seen.has(candidate)) return;
        seen.add(candidate);
        candidates.push(candidate);
      });
      for (const path of candidates) {
        try {
          const response = await fetch('https://api.dropboxapi.com/2/files/get_metadata', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ path }),
          });
          if (response.status === 409) continue;
          if (!response.ok) {
            const text = await response.text().catch(() => '');
            const retrySec = parseRetryInfo(response.status, response.headers, text);
            if (retrySec > 0) readAvailableAt = Date.now() + retrySec * 1000;
            continue;
          }
          const meta = await response.json().catch(() => null);
          if (!meta) continue;
          track.dropboxPath = meta.path_lower || meta.path_display || path;
          track.dropboxRev = meta.rev || track.dropboxRev || null;
          track.dropboxSize = Number(meta.size) || track.dropboxSize || null;
          track.dropboxUpdatedAt = Date.now();
          track.isRemote = true;
          track._legacyRestoreCooldown = 0;
          persistLocalPlaylist();
          onStatusChange();
          return true;
        } catch (error) {
          console.warn('Legacy Dropbox path restore failed', error);
        }
      }
      track._legacyRestoreCooldown = Date.now() + 60000;
      return false;
    })();
    legacyPathPromises.set(track.id, run);
    try { return await run; } finally { legacyPathPromises.delete(track.id); }
  }

  async function ensureTrackUrl(track) {
    if (!track) return false;
    if (!track.dropboxPath) {
      const restored = await maybeRestoreLegacyPath(track);
      if (!restored) return false;
    }
    const now = Date.now();
    if (track.url && track.url.startsWith('blob:')) return true;
    if (track._remoteRetryAt && now < track._remoteRetryAt) return false;
    if (remoteLinkInFlight.has(track.id)) {
      try { return await remoteLinkInFlight.get(track.id); } finally {}
    }
    if (now < readAvailableAt || readInFlight >= DROPBOX_READ_CONCURRENCY) return false;
    readInFlight += 1;
    const done = (result) => { readInFlight = Math.max(0, readInFlight - 1); return result; };
    const run = (async () => {
      const token = await ensureToken();
      if (!token) { onError('Debes volver a conectar tu Dropbox.'); return done(false); }
      try {
        const response = await fetch('https://api.dropboxapi.com/2/files/get_temporary_link', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: track.dropboxPath }),
        });
        if (!response.ok) {
          let details = '';
          try { details = await response.text(); } catch (readError) { details = String(readError); }
          const summary = (() => { try { const p = JSON.parse(details); return p?.error_summary || details; } catch { return details; } })();
          const errorInfo = new Error(summary || 'No se pudo obtener enlace temporal');
          errorInfo.responseStatus = response.status;
          try {
            const retrySec = parseRetryInfo(response.status, response.headers, details);
            if (retrySec > 0) {
              readAvailableAt = Date.now() + retrySec * 1000;
              track._remoteRetryAt = Date.now() + Math.min(60000, retrySec * 1200);
            }
          } catch {}
          throw errorInfo;
        }
        const data = await response.json();
        const download = await fetch(data.link);
        if (!download.ok) throw new Error('No se pudo descargar el archivo de Dropbox');
        const blob = await download.blob();
        const fileName = track.fileName || data.metadata?.name || `${track.id}.mp3`;
        const fileType = blob.type || download.headers.get('Content-Type') || 'audio/mpeg';
        const fileLike = typeof File === 'function' ? new File([blob], fileName, { type: fileType, lastModified: Date.now() }) : blob;
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
        return done(true);
      } catch (error) {
        console.error('Error obteniendo enlace temporal', error);
        const status = error.responseStatus;
        if (status === 409) {
          // La pista ya no está en Dropbox; re-subir si hay copia local
          const hasLocalCopy = pendingUploads.has(track.id);
          if (hasLocalCopy) {
            track.dropboxPath = null;
            track.dropboxRev = null;
            track.dropboxSize = null;
            track.dropboxUpdatedAt = null;
            track.isRemote = false;
            track.urlExpiresAt = 0;
            track._sync = 'queued';
            persistLocalPlaylist();
            onStatusChange();
            requestSync({ loadRemote: false, onlyTrackIds: [track.id] });
            onError('Archivo no encontrado en Dropbox. Re-subiendo desde copia local.');
          } else {
            track._remoteRetryAt = Date.now() + 5 * 60 * 1000;
          }
        } else {
          onError('No se pudo obtener el audio desde Dropbox.');
        }
        return done(false);
      }
    })();
    remoteLinkInFlight.set(track.id, run);
    try { return await run; } finally { remoteLinkInFlight.delete(track.id); }
  }

  // === Subida de pistas ===
  async function uploadOneTrackWithRetry(token, track) {
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
    const safeName = (uploadName || track.fileName || track.id).replace(/[^a-zA-Z0-9._-]+/g, '_');
    const remotePath = `/tracks/${track.id}-${safeName}`;
    const CHUNK_THRESHOLD = 8 * 1024 * 1024;
    const CHUNK_SIZE = 8 * 1024 * 1024;
    const maxRetries = 6;
    let attempt = 0;
    while (attempt <= maxRetries) {
      try {
        await awaitWriteWindow();
        const useSession = (file.size || 0) > CHUNK_THRESHOLD;
        let metadata = null;
        if (!useSession) {
          const response = await fetch('https://content.dropboxapi.com/2/files/upload', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/octet-stream',
              'Dropbox-API-Arg': JSON.stringify({ path: remotePath, mode: 'overwrite', mute: false, autorename: false }),
            },
            body: file,
          });
          if (!response.ok) {
            const textResponse = await response.text();
            const retrySec = parseRetryInfo(response.status, response.headers, textResponse);
            if (retrySec && attempt < maxRetries) {
              writeAvailableAt = Date.now() + retrySec * 1000;
              await sleep(retrySec * 1000 + Math.random() * 250);
              attempt += 1;
              continue;
            }
            throw new Error(textResponse || 'Upload failed');
          }
          metadata = await response.json();
        } else {
          const total = file.size || 0;
          let offset = 0;
          const firstChunk = file.slice(0, Math.min(CHUNK_SIZE, total));
          let resp = await fetch('https://content.dropboxapi.com/2/files/upload_session/start', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': JSON.stringify({ close: false }) },
            body: firstChunk,
          });
          if (!resp.ok) {
            const text = await resp.text();
            const retrySec = parseRetryInfo(resp.status, resp.headers, text);
            if (retrySec && attempt < maxRetries) {
              writeAvailableAt = Date.now() + retrySec * 1000;
              await sleep(retrySec * 1000 + Math.random() * 300);
              attempt += 1;
              continue;
            }
            throw new Error(text || 'upload_session/start failed');
          }
          const startInfo = await resp.json();
          const sessionId = startInfo.session_id;
          offset = firstChunk.size;
          while (offset + CHUNK_SIZE < total) {
            const chunk = file.slice(offset, offset + CHUNK_SIZE);
            resp = await fetch('https://content.dropboxapi.com/2/files/upload_session/append_v2', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/octet-stream',
                'Dropbox-API-Arg': JSON.stringify({ cursor: { session_id: sessionId, offset }, close: false }),
              },
              body: chunk,
            });
            if (!resp.ok) {
              const text = await resp.text();
              const retrySec = parseRetryInfo(resp.status, resp.headers, text);
              if (retrySec && attempt < maxRetries) {
                writeAvailableAt = Date.now() + retrySec * 1000;
                await sleep(retrySec * 1000 + Math.random() * 300);
                attempt += 1;
                continue;
              }
              throw new Error(text || 'upload_session/append_v2 failed');
            }
            offset += chunk.size;
          }
          const lastChunk = file.slice(offset, total);
          resp = await fetch('https://content.dropboxapi.com/2/files/upload_session/finish', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/octet-stream',
              'Dropbox-API-Arg': JSON.stringify({ cursor: { session_id: sessionId, offset }, commit: { path: remotePath, mode: 'overwrite', autorename: false, mute: false } }),
            },
            body: lastChunk,
          });
          if (!resp.ok) {
            const text = await resp.text();
            const retrySec = parseRetryInfo(resp.status, resp.headers, text);
            if (retrySec && attempt < maxRetries) {
              writeAvailableAt = Date.now() + retrySec * 1000;
              await sleep(retrySec * 1000 + Math.random() * 300);
              attempt += 1;
              continue;
            }
            throw new Error(text || 'upload_session/finish failed');
          }
          metadata = await resp.json();
        }
        track.dropboxPath = metadata.path_lower ?? metadata.path_display ?? remotePath;
        track.dropboxRev = metadata.rev;
        track.dropboxSize = metadata.size;
        track.dropboxUpdatedAt = Date.now();
        track.isRemote = true;
        track.urlExpiresAt = 0;
        pendingUploads.delete(track.id);
        persistLocalPlaylist();
        return;
      } catch (error) {
        if (attempt >= maxRetries) {
          console.error(`No se pudo subir ${track.fileName}`, error);
          track._sync = 'error';
          onError(`Error subiendo ${track.fileName}.`);
          return;
        }
        const backoffMs = Math.min(16000, 1000 * Math.pow(2, attempt)) + Math.random() * 300;
        await sleep(backoffMs);
        attempt += 1;
      }
    }
  }

  async function uploadPendingTracks(token, list, options = {}) {
    const candidates = Array.isArray(list) ? list : getAllTracks().filter(track => !track.dropboxPath);
    const sizeByTrack = options?.sizeByTrack instanceof Map ? options.sizeByTrack : new Map();
    if (!candidates.length) return;
    const CONCURRENCY = 1;
    let index = 0;
    const worker = async () => {
      while (true) {
        const i = index;
        index += 1;
        const track = candidates[i];
        if (!track) break;
        track._sync = 'uploading';
        schedulePlaylistRender();
        await uploadOneTrackWithRetry(token, track);
        if (track.dropboxPath) {
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
    };
    const workers = Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, () => worker());
    await Promise.all(workers);
    scheduleStorageStatsUpdate();
  }

  // === Guardado de playlists en Dropbox ===
  async function ensurePlaylistsFolder(token) {
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    try {
      const metaRes = await fetch('https://api.dropboxapi.com/2/files/get_metadata', {
        method: 'POST',
        headers,
        body: JSON.stringify({ path: config.playlistsDir }),
      });
      if (metaRes.ok) return true;
    } catch {}
    try {
      const createRes = await fetch('https://api.dropboxapi.com/2/files/create_folder_v2', {
        method: 'POST',
        headers,
        body: JSON.stringify({ path: config.playlistsDir, autorename: false }),
      });
      if (createRes.ok) return true;
      if (createRes.status === 409) return true;
    } catch {}
    return false;
  }

  async function savePlaylist(token) {
    const payload = {
      version: 2,
      updatedAt: Date.now(),
      activePlaylistId: state.activePlaylistId,
      fadeDuration: state.fadeDuration,
      autoLoop: state.autoLoop,
      shuffle: state.shuffle,
      playbackRate: state.playbackRate,
      normalizationEnabled: state.normalizationEnabled,
      playlists: state.playlists.map(playlist => ({
        id: playlist.id,
        name: playlist.name,
        updatedAt: playlist.updatedAt ?? null,
        tracks: playlist.tracks.map(serializeTrack),
        isAuto: !!playlist.isAuto,
        autoType: playlist.autoType || null,
      })),
    };
    const body = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const maxRetries = 5;
    let attempt = 0;
    while (attempt <= maxRetries) {
      try {
        await awaitWriteWindow();
        const modeArg = playlistMeta?.rev ? { '.tag': 'update', update: playlistMeta.rev } : 'overwrite';
        const response = await fetch('https://content.dropboxapi.com/2/files/upload', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/octet-stream',
            'Dropbox-API-Arg': JSON.stringify({ path: config.playlistPath, mode: modeArg, autorename: false, mute: true }),
          },
          body,
        });
        if (!response.ok) {
          const text = await response.text();
          if (response.status === 409 && playlistMeta?.rev) {
            const remote = await pullPlaylistRaw(token).catch(() => null);
            const resolution = await showAppChoice('Se han detectado cambios locales y remotos en Dropbox. Elige como resolver el conflicto.', {
              title: 'Conflicto en Dropbox',
              choiceOptions: [
                { value: 'merge', label: 'Combinar cambios locales y remotos' },
                { value: 'cloud', label: 'Usar la version de la nube y descartar cambios locales', danger: true },
                { value: 'overwrite', label: 'Mantener la version local y sobrescribir la nube', variant: 'ghost' },
              ],
            });
            if (resolution === 'merge' && remote) {
              const merged = mergePlaylistDocuments(payload, remote.doc);
              playlistMeta.rev = remote.meta.rev || null;
              return await savePlaylistWithPayload(token, merged, playlistMeta.rev);
            } else if (resolution === 'cloud' && remote) {
              applyRemoteDocumentToState(remote.doc);
              persistLocalPlaylist();
              return;
            } else if (resolution === 'overwrite') {
              playlistMeta.rev = null;
              attempt += 1;
              continue;
            } else {
              return;
            }
          }
          const retrySec = parseRetryInfo(response.status, response.headers, text);
          if (retrySec && attempt < maxRetries) {
            writeAvailableAt = Date.now() + retrySec * 1000;
            await sleep(retrySec * 1000 + Math.random() * 250);
            attempt += 1;
            continue;
          }
          throw new Error(text || 'Upload failed');
        }
        const meta = await response.json();
        playlistMeta.rev = meta.rev || playlistMeta.rev || null;
        playlistMeta.serverModified = meta.server_modified || null;
        persistLocalPlaylist();
        return;
      } catch (error) {
        console.error('Error guardando playlist en Dropbox', error);
        throw error;
      }
    }
  }

  async function savePlaylistWithPayload(token, payload, rev) {
    const body = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const response = await fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({ path: config.playlistPath, mode: rev ? { '.tag': 'update', update: rev } : 'overwrite', autorename: false, mute: true }),
      },
      body,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || 'Upload failed');
    }
    const meta = await response.json();
    playlistMeta.rev = meta.rev || null;
    playlistMeta.serverModified = meta.server_modified || null;
    persistLocalPlaylist();
  }

  async function savePlaylistsPerList(token) {
    await ensurePlaylistsFolder(token);
    const moveTried = new Set();
    for (const pl of state.playlists) {
      if (pl.isAuto) continue;
      const payload = { version: 2, id: pl.id, name: pl.name, updatedAt: pl.updatedAt ?? Date.now(), tracks: pl.tracks.map(serializeTrack) };
      const desiredPath = getPlaylistPath(pl);
      const meta = perListMeta[pl.id] || { path: desiredPath, rev: null };
      const pathChanged = meta.path && meta.path !== desiredPath;
      if (!pathChanged && meta.rev && meta.savedUpdatedAt === pl.updatedAt) continue;
      const body = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      const lcDesired = String(desiredPath).toLowerCase();
      const lcPrev = String(meta.path || '').toLowerCase();
      if (pathChanged && meta.path && lcDesired !== lcPrev && !moveTried.has(pl.id)) {
        try {
          const moveResp = await fetch('https://api.dropboxapi.com/2/files/move_v2', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ from_path: meta.path, to_path: desiredPath, autorename: false, allow_shared_folder: true, allow_ownership_transfer: false }),
          });
          moveTried.add(pl.id);
          if (moveResp.ok) {
            const mv = await moveResp.json().catch(() => null);
            const md = mv && (mv.metadata || mv);
            perListMeta[pl.id] = { path: desiredPath, rev: md?.rev || null, serverModified: md?.server_modified || null };
          } else if (moveResp.status === 409) {
            perListMeta[pl.id] = { path: desiredPath, rev: null, serverModified: null };
            pendingDeletions.add(lcPrev);
          }
        } catch {}
      }
      let attempt = 0;
      const maxRetries = 5;
      while (attempt <= maxRetries) {
        try {
          await awaitWriteWindow();
          const current = perListMeta[pl.id] || meta;
          const modeArg = (current.rev ? { '.tag': 'update', update: current.rev } : 'overwrite');
          const response = await fetch('https://content.dropboxapi.com/2/files/upload', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/octet-stream',
              'Dropbox-API-Arg': JSON.stringify({ path: desiredPath, mode: modeArg, autorename: false, mute: true }),
            },
            body,
          });
          if (!response.ok) {
            const text = await response.text();
            if (response.status === 409) {
              try {
                const mresp = await fetch('https://api.dropboxapi.com/2/files/get_metadata', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                  body: JSON.stringify({ path: desiredPath, include_deleted: false }),
                });
                if (mresp.ok) {
                  const md = await mresp.json();
                  if (md && md['.tag'] === 'file' && md.rev) {
                    perListMeta[pl.id] = { path: desiredPath, rev: md.rev, serverModified: md.server_modified || null };
                    attempt += 1;
                    await sleep(200 + Math.random() * 200);
                    continue;
                  }
                } else {
                  const txt = await mresp.text().catch(() => '');
                  if (/not_found/i.test(txt)) {
                    perListMeta[pl.id] = { path: desiredPath, rev: null, serverModified: null };
                    attempt += 1;
                    await sleep(200 + Math.random() * 200);
                    continue;
                  }
                }
              } catch {}
              if (perListMeta[pl.id]?.rev) {
                perListMeta[pl.id].rev = null;
                attempt += 1;
                await sleep(200 + Math.random() * 200);
                continue;
              }
            }
            const retrySec = parseRetryInfo(response.status, response.headers, text);
            if (retrySec && attempt < maxRetries) {
              writeAvailableAt = Date.now() + retrySec * 1000;
              await sleep(retrySec * 1000 + Math.random() * 250);
              attempt += 1;
              continue;
            }
            throw new Error(text || 'Upload failed');
          }
          const metaJson = await response.json();
          perListMeta[pl.id] = { path: desiredPath, rev: metaJson.rev || null, serverModified: metaJson.server_modified || null, savedUpdatedAt: pl.updatedAt };
          if (pathChanged && meta.path && (lcDesired !== lcPrev)) {
            pendingDeletions.add(lcPrev);
          }
          break;
        } catch (err) {
          if (attempt >= maxRetries) throw err;
          await sleep(Math.min(16000, 1000 * Math.pow(2, attempt)) + Math.random() * 300);
          attempt += 1;
        }
      }
    }
    persistLocalPlaylist();
  }

  async function saveSettings(token) {
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
    const body = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const response = await fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({
          path: config.settingsPath,
          mode: settingsMeta?.rev ? { '.tag': 'update', update: settingsMeta.rev } : 'overwrite',
          autorename: false,
          mute: true,
        }),
      },
      body,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(text || 'Upload settings failed');
    }
    const meta = await response.json();
    settingsMeta.rev = meta.rev || null;
    settingsMeta.serverModified = meta.server_modified || null;
    persistLocalPlaylist();
  }

  // === Carga de playlists desde Dropbox ===
  async function pullPlaylist(token) {
    try {
      const response = await fetch('https://content.dropboxapi.com/2/files/download', {
        method: 'POST',
        headers: { 'Dropbox-API-Arg': JSON.stringify({ path: config.playlistPath }) },
      });
      if (response.status === 409) return;
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || 'Unable to download playlist');
      }
      const metaHeader = response.headers.get('dropbox-api-result');
      if (metaHeader) {
        try {
          const m = JSON.parse(metaHeader);
          playlistMeta.rev = m?.rev || playlistMeta.rev || null;
          playlistMeta.serverModified = m?.server_modified || playlistMeta.serverModified || null;
        } catch {}
      }
      const json = await response.json();
      if (Array.isArray(json?.playlists)) {
        const localTrackMap = new Map();
        const localPlaylistMeta = new Map();
        state.playlists.forEach(playlist => {
          if (playlist.isAuto) return;
          localPlaylistMeta.set(playlist.id, { name: playlist.name });
          playlist.tracks.forEach(track => localTrackMap.set(track.id, { track, playlistId: playlist.id }));
        });
        const nextPlaylists = [];
        json.playlists.forEach(remotePlaylist => {
          const playlistId = remotePlaylist.id || generateId('pl');
          const playlist = { id: playlistId, name: remotePlaylist.name || 'Lista', tracks: [] };
          localPlaylistMeta.delete(playlistId);
          if (Array.isArray(remotePlaylist.tracks)) {
            remotePlaylist.tracks.forEach(entry => {
              if (!entry?.id) return;
              const existingInfo = localTrackMap.get(entry.id);
              let track;
              if (existingInfo) {
                track = existingInfo.track;
                localTrackMap.delete(entry.id);
                const remoteHasName = typeof entry.name === 'string' && entry.name.length > 0;
                const localRenamed = !!track.userRenamed;
                const remoteRenamed = !!entry.userRenamed;
                const localTs = Number(track.updatedAt || 0);
                const remoteTs = Number(entry.updatedAt || 0);
                if (remoteHasName) {
                  if (localRenamed && (!remoteRenamed || localTs >= remoteTs)) {
                    // keep local
                  } else if (remoteRenamed && remoteTs > localTs) {
                    track.name = entry.name; track.userRenamed = true;
                  } else if (!localRenamed && remoteTs >= localTs) {
                    track.name = entry.name; track.userRenamed = !!entry.userRenamed;
                  }
                }
                track.fileName = entry.fileName ?? track.fileName ?? track.name;
                const remoteArtist = typeof entry.artist === 'string' ? entry.artist.trim() : '';
                if (remoteArtist) {
                  const localArtist = (track.artist || '').trim();
                  const rTs = Number(entry.updatedAt || 0);
                  const lTs = Number(track.updatedAt || 0);
                  if (!localArtist || rTs > lTs) track.artist = remoteArtist;
                }
                const remoteAlbum = typeof entry.album === 'string' ? entry.album.trim() : '';
                if (remoteAlbum) {
                  const localAlbum = (track.album || '').trim();
                  const rTs = Number(entry.updatedAt || 0);
                  const lTs = Number(track.updatedAt || 0);
                  if (!localAlbum || rTs > lTs) track.album = remoteAlbum;
                }
                const remoteFavorite = coerceBoolean(entry.isFavorite);
                if (remoteFavorite !== null) {
                  const rTs = Number(entry.updatedAt || 0);
                  const lTs = Number(track.updatedAt || 0);
                  if (rTs >= lTs || typeof track.isFavorite !== 'boolean') track.isFavorite = remoteFavorite;
                }
                if (Number.isFinite(entry.duration)) track.duration = entry.duration;
                const remoteNormGain = coerceNumber(entry.normalizationGain);
                if (remoteNormGain !== null) track.normalizationGain = remoteNormGain;
                const remoteRating = coerceNumber(entry.rating);
                if (remoteRating !== null) {
                  const rTs = Number(entry.updatedAt || 0);
                  const lTs = Number(track.updatedAt || 0);
                  if (rTs >= lTs || !Number.isFinite(track.rating)) track.rating = remoteRating;
                }
              } else {
                track = deserializeTrack(entry);
              }
              if (entry.dropboxPath) {
                track.dropboxPath = entry.dropboxPath;
                track.dropboxRev = entry.dropboxRev ?? track.dropboxRev ?? null;
                track.dropboxSize = entry.dropboxSize ?? track.dropboxSize ?? null;
                track.dropboxUpdatedAt = entry.dropboxUpdatedAt ?? track.dropboxUpdatedAt ?? null;
                track.isRemote = true;
              } else {
                track.dropboxPath = null; track.dropboxRev = null; track.dropboxSize = null; track.dropboxUpdatedAt = null;
                if (!pendingUploads.has(track.id)) track.isRemote = false;
              }
              track.url = null; track.urlExpiresAt = 0;
              if (entry.waveform?.peaks?.length) {
                track.waveform = entry.waveform; track.waveformStatus = entry.waveformStatus ?? null;
              } else if (typeof entry.waveformStatus === 'string') {
                track.waveformStatus = entry.waveformStatus;
              }
              playlist.tracks.push(track);
              if (!getTrackArtist(track)) ensureTrackMetadata(track).catch(() => {});
            });
          }
          nextPlaylists.push(playlist);
        });
        localTrackMap.forEach(({ track, playlistId }) => {
          let pl = nextPlaylists.find(item => item.id === playlistId);
          if (!pl) {
            const meta = localPlaylistMeta.get(playlistId);
            pl = { id: playlistId || generateId('pl'), name: meta?.name || 'Lista local', tracks: [] };
            nextPlaylists.push(pl);
          }
          pl.tracks.push(track);
          if (!getTrackArtist(track)) ensureTrackMetadata(track).catch(() => {});
        });
        localPlaylistMeta.forEach((meta, playlistId) => {
          if (playlistId && !nextPlaylists.some(item => item.id === playlistId)) {
            nextPlaylists.push({ id: playlistId, name: meta?.name || 'Lista local', tracks: [] });
          }
        });
        state.playlists = nextPlaylists;
        ensureSharedTrackReferences();
        if (json.activePlaylistId && state.playlists.some(pl => pl.id === json.activePlaylistId)) {
          state.activePlaylistId = json.activePlaylistId;
        }
        applyFetchedSettings(json);
        ensurePlaylistsInitialized();
        persistLocalPlaylist();
        renderPlaylist();
        updateControls();
        return;
      }
      if (!Array.isArray(json?.tracks)) return;
      const remoteMap = new Map();
      json.tracks.forEach(entry => { if (entry?.id && entry?.dropboxPath) remoteMap.set(entry.id, entry); });
      const allLocalTracks = getAllTracks();
      const mergedTracks = [];
      json.tracks.forEach(entry => {
        const existing = allLocalTracks.find(t => t.id === entry.id);
        if (existing) {
          existing.dropboxPath = entry.dropboxPath;
          existing.dropboxRev = entry.dropboxRev ?? existing.dropboxRev;
          existing.dropboxSize = entry.dropboxSize ?? existing.dropboxSize;
          existing.dropboxUpdatedAt = entry.dropboxUpdatedAt ?? existing.dropboxUpdatedAt;
          existing.isRemote = true; existing.urlExpiresAt = 0; existing.url = null;
          const remoteArtist = typeof entry.artist === 'string' ? entry.artist.trim() : '';
          if (remoteArtist) {
            const localArtist = (existing.artist || '').trim();
            const rTs = Number(entry.updatedAt || 0); const lTs = Number(existing.updatedAt || 0);
            if (!localArtist || rTs > lTs) existing.artist = remoteArtist;
          }
          const remoteAlbum = typeof entry.album === 'string' ? entry.album.trim() : '';
          if (remoteAlbum) {
            const localAlbum = (existing.album || '').trim();
            const rTs = Number(entry.updatedAt || 0); const lTs = Number(existing.updatedAt || 0);
            if (!localAlbum || rTs > lTs) existing.album = remoteAlbum;
          }
          if (!existing.duration && entry.duration) existing.duration = entry.duration;
          const remoteNormGain = coerceNumber(entry.normalizationGain);
          if (remoteNormGain !== null) existing.normalizationGain = remoteNormGain;
          const remoteRating = coerceNumber(entry.rating);
          if (remoteRating !== null) existing.rating = remoteRating;
          if (entry.waveform?.peaks?.length) { existing.waveform = entry.waveform; existing.waveformStatus = entry.waveformStatus ?? null; }
          else if (typeof entry.waveformStatus === 'string') existing.waveformStatus = entry.waveformStatus;
          mergedTracks.push(existing);
          if (!getTrackArtist(existing)) ensureTrackMetadata(existing).catch(() => {});
        } else {
          const track = deserializeTrack(entry);
          mergedTracks.push(track);
          if (!getTrackArtist(track)) ensureTrackMetadata(track).catch(() => {});
        }
      });
      const unsynced = allLocalTracks.filter(t => !remoteMap.has(t.id));
      const combined = [...mergedTracks, ...unsynced];
      state.playlists = [createPlaylistObject('Lista Dropbox', combined)];
      ensureSharedTrackReferences();
      state.activePlaylistId = state.playlists[0].id;
      ensurePlaylistsInitialized();
      persistLocalPlaylist();
      renderPlaylist();
      updateControls();
    } catch (error) {
      console.error('Error cargando playlist de Dropbox', error);
      throw error;
    }
  }

  async function pullPlaylistRaw(token) {
    const response = await fetch('https://content.dropboxapi.com/2/files/download', {
      method: 'POST',
      headers: { 'Dropbox-API-Arg': JSON.stringify({ path: config.playlistPath }) },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(text || 'Unable to download playlist');
    }
    const metaHeader = response.headers.get('dropbox-api-result');
    const meta = { rev: null, server_modified: null };
    if (metaHeader) {
      try { const m = JSON.parse(metaHeader); meta.rev = m?.rev || null; meta.server_modified = m?.server_modified || null; } catch {}
    }
    const doc = await response.json();
    return { doc, meta };
  }

  async function pullPlaylistsPerList(token) {
    try {
      const response = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ path: config.playlistsDir, recursive: false }),
      });
      if (response.status === 409) return;
      if (!response.ok) {
        const txt = await response.text().catch(() => '');
        throw new Error(txt || 'list_folder failed');
      }
      const listing = await response.json();
      const entries = Array.isArray(listing?.entries) ? listing.entries : [];
      const jsonFiles = entries.filter(e => {
        if (e['.tag'] !== 'file' || typeof e?.path_lower !== 'string') return false;
        if (!e.name.toLowerCase().endsWith('.json') || e.name === '_settings.json') return false;
        if (pendingDeletions.has(String(e.path_lower).toLowerCase())) return false;
        return true;
      });
      const cachedByPath = new Map();
      Object.entries(perListMeta).forEach(([id, m]) => {
        if (m?.path) cachedByPath.set(String(m.path).toLowerCase(), { id, serverModified: m.serverModified, rev: m.rev });
      });
      const downloaded = (await Promise.all(jsonFiles.map(async (file) => {
        const path = file.path_lower || String(file.path_display || '').toLowerCase();
        const cached = cachedByPath.get(path);
        if (cached?.serverModified && cached.serverModified === file.server_modified) {
          const localPl = state.playlists.find(p => p.id === cached.id);
          if (localPl) return null;
        }
        const resp = await fetch('https://content.dropboxapi.com/2/files/download', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Dropbox-API-Arg': JSON.stringify({ path }) },
        });
        if (!resp.ok) return null;
        const metaHeader = resp.headers.get('dropbox-api-result');
        let meta = {};
        try { meta = JSON.parse(metaHeader || '{}'); } catch {}
        const doc = await resp.json().catch(() => null);
        return (doc && doc.id) ? { path, meta, doc } : null;
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
      const remotePaths = new Set(jsonFiles.map(f => String(f.path_lower || '').toLowerCase()).filter(Boolean));
      downloaded.forEach(({ path, meta, doc }) => {
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
        perListMeta[id] = { path, rev: meta?.rev || null, serverModified: meta?.server_modified || null };
        const seenIds = new Set();
        if (Array.isArray(doc.tracks)) {
          doc.tracks.forEach(entry => {
            if (!entry?.id) return;
            const existing = mapLocalTracks.get(entry.id)?.track;
            const track = existing ? existing : deserializeTrack(entry);
            if (existing) mapLocalTracks.delete(entry.id);
            seenIds.add(entry.id);
            const remoteHasName2 = typeof entry.name === 'string' && entry.name.length > 0;
            const localRenamed2 = !!track.userRenamed;
            const remoteRenamed2 = !!entry.userRenamed;
            const localTs2 = Number(track.updatedAt || 0);
            const remoteTs2 = Number(entry.updatedAt || 0);
            if (remoteHasName2) {
              if (localRenamed2 && (!remoteRenamed2 || localTs2 >= remoteTs2)) {
                // keep local
              } else if (remoteRenamed2 && remoteTs2 > localTs2) {
                track.name = entry.name; track.userRenamed = true;
              } else if (!localRenamed2 && remoteTs2 >= localTs2) {
                track.name = entry.name; track.userRenamed = !!entry.userRenamed;
              }
            }
            track.fileName = entry.fileName ?? track.fileName ?? track.name;
            const remoteArtist2 = typeof entry.artist === 'string' ? entry.artist.trim() : '';
            if (remoteArtist2) track.artist = remoteArtist2;
            const remoteAlbum2 = typeof entry.album === 'string' ? entry.album.trim() : '';
            if (remoteAlbum2) track.album = remoteAlbum2;
            const remoteFavorite2 = coerceBoolean(entry.isFavorite);
            if (remoteFavorite2 !== null) {
              const rTs2 = Number(entry.updatedAt || 0); const lTs2 = Number(track.updatedAt || 0);
              if (rTs2 >= lTs2 || typeof track.isFavorite !== 'boolean') track.isFavorite = remoteFavorite2;
            }
            if (Number.isFinite(entry.duration)) track.duration = entry.duration;
            const remoteNormGain2 = coerceNumber(entry.normalizationGain);
            if (remoteNormGain2 !== null) track.normalizationGain = remoteNormGain2;
            const remoteRating2 = coerceNumber(entry.rating);
            if (remoteRating2 !== null) {
              const rTs2 = Number(entry.updatedAt || 0); const lTs2 = Number(track.updatedAt || 0);
              if (rTs2 >= lTs2 || !Number.isFinite(track.rating)) track.rating = remoteRating2;
            }
            if (entry.dropboxPath) {
              track.dropboxPath = entry.dropboxPath;
              track.dropboxRev = entry.dropboxRev ?? track.dropboxRev ?? null;
              track.dropboxSize = entry.dropboxSize ?? track.dropboxSize ?? null;
              track.dropboxUpdatedAt = entry.dropboxUpdatedAt ?? track.dropboxUpdatedAt ?? null;
              track.isRemote = true;
            }
            track.url = null; track.urlExpiresAt = 0;
            if (entry.waveform?.peaks?.length) { track.waveform = entry.waveform; track.waveformStatus = entry.waveformStatus ?? null; }
            else if (typeof entry.waveformStatus === 'string') track.waveformStatus = entry.waveformStatus;
            track.updatedAt = entry.updatedAt ?? track.updatedAt ?? null;
            playlist.tracks.push(track);
            if (!getTrackArtist(track) && track.isFavorite) ensureTrackMetadata(track).catch(() => {});
          });
        }
        nextPlaylists.push(playlist);
      });

      // Playlists locales sin cambios remotos (no descargadas pero existentes en el listing)
      const seenLocalIds = new Set(nextPlaylists.map(p => p.id));
      state.playlists.forEach(pl => {
        if (pl.isAuto || seenLocalIds.has(pl.id)) return;
        const meta = perListMeta[pl.id];
        if (meta?.path && remotePaths.has(String(meta.path).toLowerCase())) {
          // No cambió: mantener local
          nextPlaylists.push(pl);
          return;
        }
        // Tenía ruta remota conocida pero ya no existe en Dropbox → borrada en otro dispositivo
        if (meta?.path && !remotePaths.has(String(meta.path).toLowerCase())) {
          recordDeletedPlaylistId(pl.id);
          delete perListMeta[pl.id];
          return;
        }
        // No existe en remoto y no hay meta: nueva local o borrada remotamente
        // Conservar si tiene tracks (el usuario la creó localmente)
        if (pl.tracks.length > 0 && !deletedPlaylistIds.has(pl.id)) {
          nextPlaylists.push(pl);
        }
      });

      // Tracks locales sin lista en remoto: reasignar a listas existentes
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
    } catch (error) {
      console.error('Error cargando playlists por lista desde Dropbox', error);
      throw error;
    }
  }

  async function pullSettings(token) {
    const response = await fetch('https://content.dropboxapi.com/2/files/download', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Dropbox-API-Arg': JSON.stringify({ path: config.settingsPath }) },
    });
    if (!response.ok) return;
    const metaHeader = response.headers.get('dropbox-api-result');
    if (metaHeader) {
      try {
        const m = JSON.parse(metaHeader);
        settingsMeta.rev = m?.rev || null;
        settingsMeta.serverModified = m?.server_modified || null;
      } catch {}
    }
    const json = await response.json().catch(() => null);
    if (!json) return;
    applyFetchedSettings(json);
    persistLocalPlaylist();
  }

  // === Eliminaciones en Dropbox ===
  async function processPendingDeletions(token) {
    if (!pendingDeletions.size) return;
    try {
      pendingDeletions = new Set(Array.from(pendingDeletions).map(p => String(p).toLowerCase()));
      const desiredSet = new Set((state.playlists || []).map(pl => String(getPlaylistPath(pl)).toLowerCase()));
      Array.from(pendingDeletions).forEach(p => {
        if (desiredSet.has(p)) {
          try { console.debug('[DELETE] omitir activo', p); } catch {}
          pendingDeletions.delete(p);
        }
      });
    } catch {}
    const deletions = Array.from(pendingDeletions);
    const CHUNK = 900;
    for (let start = 0; start < deletions.length; start += CHUNK) {
      const slice = deletions.slice(start, start + CHUNK).map(path => ({ path }));
      let attempt = 0;
      const maxRetries = 5;
      while (attempt <= maxRetries) {
        try {
          await awaitWriteWindow();
          const response = await fetch('https://api.dropboxapi.com/2/files/delete_batch', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ entries: slice }),
          });
          if (!response.ok) {
            const text = await response.text().catch(() => '');
            const retrySec = parseRetryInfo(response.status, response.headers, text);
            if (retrySec && attempt < maxRetries) {
              writeAvailableAt = Date.now() + retrySec * 1000;
              await sleep(retrySec * 1000 + Math.random() * 250);
              attempt += 1;
              continue;
            }
            throw new Error('delete_batch failed');
          }
          const resJson = await response.json();
          let asyncJobId = resJson?.async_job_id || null;
          if (!asyncJobId && Array.isArray(resJson?.entries)) {
            resJson.entries.forEach(e => {
              if (e['.tag'] === 'success' && e?.metadata?.path_lower) pendingDeletions.delete(e.metadata.path_lower);
              else if (e['.tag'] === 'failure') console.warn('[DELETE_BATCH] fallo entrada', e);
            });
            break;
          }
          while (asyncJobId) {
            await sleep(600);
            const check = await fetch('https://api.dropboxapi.com/2/files/delete_batch/check', {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ async_job_id: asyncJobId }),
            });
            if (!check.ok) {
              const text = await check.text().catch(() => '');
              const retrySec2 = parseRetryInfo(check.status, check.headers, text);
              if (retrySec2 && attempt < maxRetries) {
                writeAvailableAt = Date.now() + retrySec2 * 1000;
                await sleep(retrySec2 * 1000 + Math.random() * 250);
                attempt += 1;
                continue;
              }
              throw new Error('delete_batch/check failed');
            }
            const status = await check.json();
            if (status['.tag'] === 'in_progress') continue;
            if (status['.tag'] === 'complete' && Array.isArray(status.entries)) {
              status.entries.forEach(e => {
                if (e['.tag'] === 'success' && e?.metadata?.path_lower) pendingDeletions.delete(e.metadata.path_lower);
                else if (e['.tag'] === 'failure' && e?.failure?.['.tag'] === 'path_lookup') {
                  const p = e?.failure?.path_lookup?.['.tag'] === 'not_found' ? e?.failure?.path_lookup?.path : null;
                  if (p) pendingDeletions.delete(p);
                }
              });
            }
            asyncJobId = null;
          }
          break;
        } catch (error) {
          if (attempt >= maxRetries) { console.error('No se pudo eliminar archivos en lote en Dropbox', error); break; }
          await sleep(Math.min(16000, 1000 * Math.pow(2, attempt)) + Math.random() * 300);
          attempt += 1;
        }
      }
    }
    persistLocalPlaylist();
    scheduleStorageStatsUpdate();
  }

  async function forceDeleteRemainder(token) {
    const arr = Array.from(pendingDeletions || []);
    if (!arr.length) return;
    const CHUNK = 80;
    for (let i = 0; i < arr.length; i += CHUNK) {
      const slice = arr.slice(i, i + CHUNK);
      for (const path of slice) {
        let attempt = 0;
        const maxRetries = 5;
        while (attempt <= maxRetries) {
          try {
            await awaitWriteWindow();
            console.debug('[DELETE_V2] intentando', path, 'intento', attempt + 1);
            const resp = await fetch('https://api.dropboxapi.com/2/files/delete_v2', {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ path }),
            });
            if (resp.ok) {
              console.debug('[DELETE_V2] eliminado', path);
              pendingDeletions.delete(String(path).toLowerCase());
              break;
            }
            const txt = await resp.text().catch(() => '');
            console.warn('[DELETE_V2] fallo', path, 'status', resp.status, (txt || '').slice(0, 200));
            if (resp.status === 401 && attempt < maxRetries) {
              const fresh = await ensureToken(true);
              if (fresh) { attempt += 1; continue; }
            }
            if (resp.status === 409 && /not_found|path_lookup/i.test(txt)) {
              console.debug('[DELETE_V2] no encontrado, se limpia de pendientes', path);
              pendingDeletions.delete(String(path).toLowerCase());
              break;
            }
            const retrySec = parseRetryInfo(resp.status, resp.headers, txt);
            if (retrySec && attempt < maxRetries) {
              writeAvailableAt = Date.now() + retrySec * 1000;
              await sleep(retrySec * 1000 + Math.random() * 250);
              attempt += 1;
              continue;
            }
            break;
          } catch (e) {
            console.warn('[DELETE_V2] error de red', path, 'intento', attempt + 1, e);
            if (attempt >= maxRetries) break;
            await sleep(Math.min(16000, 1000 * Math.pow(2, attempt)) + Math.random() * 300);
            attempt += 1;
          }
        }
      }
      persistLocalPlaylist();
      onStatusChange();
      await sleep(150);
    }
  }

  // === Detección de modo per-list ===
  async function isPerListModeAvailable(token) {
    try {
      const response = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ path: config.playlistsDir, recursive: false, limit: 2 }),
      });
      if (response.status === 409) return false;
      if (!response.ok) return false;
      return true;
    } catch { return false; }
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
    const baseCandidates = scopeTracks.filter(track => !track.dropboxPath);
    const isManualSubset = !!effective.onlyTrackIds;
    let candidates = isManualSubset ? baseCandidates.filter(t => effective.onlyTrackIds.includes(t.id)) : baseCandidates;
    const { totalBytes: estimatedBytes, sizeByTrack } = estimateUploadPlan(candidates);
    if (effective.triggeredAutomatically && estimatedBytes > DROPBOX_AUTO_SYNC_MAX_BYTES && candidates.length) {
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
      const token = await ensureToken();
      if (!token) return;
      const perListAvailable = await isPerListModeAvailable(token);
      if (effective.loadRemote) {
        if (perListAvailable) {
          await pullPlaylistsPerList(token);
          await pullSettings(token).catch(() => {});
        } else {
          await pullPlaylist(token);
        }
      }
      await uploadPendingTracks(token, candidates, { sizeByTrack });
      await processPendingDeletions(token);
      if (pendingDeletions && pendingDeletions.size > 0) {
        await forceDeleteRemainder(token).catch(() => {});
      }
      if (perListAvailable) {
        await savePlaylistsPerList(token);
        await saveSettings(token).catch(() => {});
      } else {
        await savePlaylist(token);
      }
      syncState.lastSync = Date.now();
      syncState.netStrikes = 0;
    } catch (error) {
      console.error('Dropbox sync error', error);
      syncState.error = error;
      onError('No se pudo sincronizar con Dropbox.');
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
