# Test report: EduMix

## Summary
- Recommendation: publish with risks.
- Main confidence: static app shell assets serve correctly, all JS parses, manifest/icons are coherent, helper invariants pass synthetic unit smoke, and the latest 1.7.6 fix claims are visible in code.
- Main risk: no real-browser/audio/IndexedDB/Dropbox/WebDAV end-to-end flow was run, so sync/playback behavior is not fully verified.

## Context
- Repo: `/home/daizan/web/EduMix`
- Commit: `aa7067d` — `1.7.6 — fix sync: borrado de lista propagado a otros dispositivos; fix dialog maxLength; evitar 409 en create_folder`
- Branch: `main...origin/main`
- Date: 2026-05-21

## Results

| Claim | Verdict | Evidence | Notes |
|---|---|---|---|
| C1 — The app shell is servable as a static PWA | PASS | `logs/http-smoke.log`: HTTP 200 for `/`, `/index.html`, `/app.js`, `/styles.css`, `/service-worker.js`, `/version.js`, manifest, key modules and icons. `logs/static-checks.log`: manifest parses and icons exist. | First attempt on port 8765 hit an existing unrelated server; rerun on 8766 passed. |
| C2 — JavaScript modules are syntactically valid | PASS | `logs/static-checks.log`: `node --check` passed for `app.js`, `service-worker.js`, `version.js`, and all `modules/*.js`. | Syntax only, not runtime browser execution. |
| C3 — Core pure helpers preserve playlist/track invariants | PASS | `logs/helper-smoke.log`: `helper-smoke: PASS`. | Tested duplicate detection, auto playlist exclusion, track reference counts and Dropbox path counts with synthetic data. |
| C4 — Deleting a playlist leaves cloud-sync tombstones | PASS | `logs/code-inspection.log`: `recordDeletedPlaylistId(active.id)` at `modules/playlist-crud.js:90`; `addPendingDeletion(...)` at line 94; `removeCloudPerListMeta(active.id)` at line 96; `requestCloudSync()` at line 113. | Code inspection supports the 1.7.6 claim. Not tested with real Dropbox sync. |
| C5 — App dialog prompt enforces maxLength consistently | PASS | `logs/code-inspection.log`: `inputMaxLength = 200` at `modules/app-dialog.js:84`; prompt sets `inputEl.maxLength = inputMaxLength || 200` at line 116; non-prompt removes `maxlength` at line 118. | Code inspection only; no DOM runtime test. |
| C6 — Dropbox create-folder conflict avoids harmful 409 handling | PASS | `modules/dropbox-sync.js:762-768`: `create_folder_v2`; `if (createRes.status === 409) return true;`. Also `logs/code-inspection.log`. | Confirms existing folder does not block. Not tested against Dropbox API. |
| C7 — Release metadata is coherent | PASS | `logs/static-checks.log`: `version.js:1 self.EDUMIX_VERSION = '1.7.6';`; service worker imports version and uses `edumix-cache-v${APP_VERSION}`. | Fallback remains `1.6.15`, but imported version should dominate when `version.js` loads. |

## Bugs / follow-ups
1. Add a small automated test harness for pure modules (`duplicate-detector`, `track-utils`, maybe dialog with a tiny DOM shim or jsdom) so these checks are not ad-hoc.
2. Add a Playwright smoke test when convenient: load page, verify no console errors, create/rename/delete playlist locally, and verify UI state.
3. Add a mocked Dropbox/WebDAV sync test around playlist deletion tombstones and 409 folder creation.
4. Consider bumping the service-worker fallback version from `1.6.15` to `1.7.6` for readability, even though `version.js` currently supplies the real value.

## Untested / assumptions
- Real browser audio playback and waveform generation.
- IndexedDB persistence with real audio files.
- Dropbox/WebDAV auth, upload/download, conflict resolution and multi-device propagation.
- Installed PWA/service-worker update behavior for users with old caches.
- Mobile background controls.
