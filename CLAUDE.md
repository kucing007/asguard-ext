# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`asguard-ext` is a Manifest V3 Chrome extension — the browser companion to the Asguard/Nadine Python CLI in `../src/nadine/`. It piggybacks on the user's live Kemenkeu session to: stream AI summaries of naskah dinas from a local `llama.cpp` server; save/replay naskah-creation templates and run mail-merge batches; file E-Arsip records; and run a large SIMAN (BMN asset management) workflow surface — templates, daftar pengelolaan, evaluasi kinerja, monitoring, EWS (Early Warning System for asset-utilization leases), and tindak lanjut. Preact + Vite + `@crxjs/vite-plugin`, **no backend of our own** — everything runs in the browser plus a localhost LLM. The one external server (`vps.asetpattimura.my.id`) is shared across three concerns: license validation, extension update checks, and EWS-notes sync.

## Commands

```bash
npm install
npm run dev          # Vite dev server with HMR (CRX plugin reloads the unpacked extension)
npm run build        # tsc --noEmit then vite build → dist/
npm run typecheck    # tsc --noEmit (the only static check — no lint/format/test configured)
npm run zip          # zip dist/ → asguard-ext.zip for distribution
npm run dist         # bash build-dist.sh — produces dist.crx + dist.pem for signed distribution
```

Load the unpacked extension from `dist/` via `chrome://extensions` → Developer mode → Load unpacked.

**Production builds are obfuscated.** `vite.config.ts` wires `rollup-plugin-obfuscator` (string-array + base64 encoding, hexadecimal identifiers) into the rollup pipeline **only when `mode === "production"`**. Dev builds are clean. If you're debugging a shipped build, expect mangled strings — reproduce against a `npm run dev` build instead.

## Architecture

### Three execution contexts

The extension is split across three JS realms that cannot share state directly — all state flows through `chrome.runtime` messaging:

1. **Content scripts** (`src/content/`) — injected at `document_start` into `satu.kemenkeu.go.id`, `service.kemenkeu.go.id`, **and** `siman.kemenkeu.go.id`:
   - `page-inject.ts` runs in `world: "MAIN"` (same realm as the Angular app). It monkey-patches `window.fetch` and `XMLHttpRequest` to sniff (a) the Nadine `Authorization: Bearer …` header the first time the app calls the Nadine API, (b) the SIMAN bearer token + role/user metadata from SIMAN API calls, and (c) clone PDF response bodies for reuse. It also scrapes `ndId` from `DetailKonsepByNdId/{id}` URLs. It cannot use `chrome.*` APIs, so it posts results to the window via `window.postMessage({ __asguard: true, … })`.
   - `index.ts` runs in the ISOLATED world. It listens for those `window.postMessage` events and forwards them to the background service worker with `chrome.runtime.sendMessage`.
2. **Background service worker** (`src/background/`) — the single source of truth. Holds captured tokens, current `ndId`, LLM settings, cached summaries, saved templates, notification seen-sets, license/update status, and EWS notes. Runs **two** `chrome.alarms`: a 1-minute keepalive pinging `/nadine-nanas/auth/now`, and a 1-minute poll that fires `notifications.runPollCycle()`.
3. **Side panel** (`src/sidepanel/`) — Preact UI. Opens on action-click. Reads snapshots from the background, subscribes to `state/changed` broadcasts, and opens streaming `Port`s for long-running operations.

### Background module layout

The background is deliberately split into focused modules — **don't collapse them back into `index.ts`**:

- **`index.ts`** — boot only: restore stores, load settings, restore license, prime update check, create alarms, wire `setupNotificationListeners()`, call `setupRouter()`.
- **`state.ts`** — shared mutable state (`llmSettings`, `pendingPayload`, `activeTab`, `licenseStatus`, `capturedPenetapanBody`, `capturedPdfs`, `naskahTextCache`) plus utilities: `snapshot()`, `broadcastState()` (deduped by JSON), `runApi<T>()`, `sleep()`, and typed setters. All handlers import from here instead of sharing closures.
- **`router.ts`** — thin dispatcher: `chrome.runtime.onMessage` delegates to domain handlers (one big if-chain by `raw.type`); `chrome.runtime.onConnect` delegates to port modules by `port.name`. **Adding a message/port = add a branch here** (see Conventions).
- **`handlers/`** — one file per request/response domain:
  - `nadine-auth.ts` — token capture/clear, page changed, ndId, PDF captured, naskah created, Nadine API calls (`api/counts`, `api/naskah`, `api/me`, `api/switch-role`)
  - `siman-auth.ts` — SIMAN token + role-data capture from content scripts, role switching
  - `settings.ts` — LLM settings get/set, health check, cache clear
  - `templates.ts` — Nadine naskah template CRUD + unit picker
  - `arsiparis.ts` — E-Arsip fetch, berkas list/create, klasifikasi, bulk archival, berkas download
  - `siman.ts` — the large SIMAN request surface: state, token/role management, penetapan, tipe pengelolaan, kelengkapan, download tokens, kanwil/kpknl lists, template CRUD, **Evaluasi BMN** (`eval/*`), **Monitoring Pengelolaan** (`siman/get-monitoring-*`, struktur termohon, dok analisis, SK, surat persetujuan, tinjut-batch check), and **EWS notes** (`ews/*`, delegated to `ews-notes-client`)
  - `notifications.ts` — background-watcher polling (see below)
  - `license.ts` — license check and cache clear
- **`ports/`** — one file per streaming port (see Messaging patterns for the full list).
- **Other top-level background modules:**
  - `nadine-client.ts` / `siman-client.ts` — API wrappers (see clients below)
  - `llama-client.ts` — llama.cpp OpenAI-compat streaming client
  - `token-store.ts` (Nadine, `chrome.storage.local`) / `siman-store.ts` (SIMAN token+role, `chrome.storage.session`)
  - `template-store.ts` (`asguard.templates`) / `siman-store` template list (`asguard.simanTemplates`)
  - `license-client.ts` / `update-client.ts` — both talk to `vps.asetpattimura.my.id`
  - `ews-notes-client.ts` — local-first EWS notes with server sync (see EWS notes)
  - `notif-store.ts` (settings) / `notif-seen-store.ts` (seen-item de-dup set)
  - `user-identity.ts` — persistent fullname used as EWS-note `author` before session tokens are captured
  - `terbilang.ts` — Indonesian number→words (naskah nominal wording, used by siman-client)
  - `summary-cache.ts`, `pdf-extract.ts` — summary cache and PDF-extract delegation

### Messaging patterns

- **Request/response**: `chrome.runtime.sendMessage` with `PanelRequest` / `BgMessage` unions in `src/shared/types.ts`. Every handler returns `true` to keep the channel open for async `sendResponse`. SIMAN types live separately in `src/shared/siman-types.ts`.
- **Streaming**: `chrome.runtime.connect({ name: "<port-name>" })`. Active ports (10 total): `llm-stream` (AI summary + chat), `template-run` (replay naskah template), `mail-merge-run` (batch docx), `arsip-run` (E-Arsip bulk), `siman-run` (SIMAN template → generate + upload naskah), `siman-dok-lengkap`, `siman-sop-tarik`, `siman-evaluasi` (Evaluasi Kinerja BMN), `siman-monitoring` (scrape + doc download), `siman-ews` (EWS Waktu Pemanfaatan), `siman-tinjut` (tindak lanjut). Wire types: `LlmStreamMsg`, `TemplateRunMsg`, `MailMergeRunMsg`, `ArsipPortMsg`, `SimanRunMsg`, `SimanEwsMsg`, etc. in `src/shared/types.ts`.
- **State broadcast**: background calls `broadcastState()` → `{ type: "state/changed", snapshot }`; the panel's `onMessage` listener reactively updates. The panel deliberately does **not** re-sync `activeTab` from broadcasts (only on initial `state/get`) so background refreshes don't yank the user back to the Nadine tab.

### Token lifecycle

- **Nadine token** — captured by `page-inject.ts` sniffing outbound headers. Persisted to `chrome.storage.local` via `token-store.ts`. Cleared on 401/403. Panel shows `TokenWarning` when `snap.token.token` is falsy.
- **SIMAN token + role** — captured from SIMAN API calls. Stored in `chrome.storage.session` via `siman-store.ts` (clears when the browser closes). Holds NIP, userId, fullname, jabatan, and a selected **role context** (`role.token`, `role.idRole`, `role.idKpknl`, etc.). `siman/set-role` switches the active role.
- **NIP** is available from both stores. The background uses whichever is non-null to drive license checks and EWS-note authorship.

### Clients

- **`nadine-client.ts`** wraps `https://service.kemenkeu.go.id/nadine-nanas`. All requests attach `Authorization: Bearer <token>` from `token-store`. Two custom error classes (`NadineHttpError`, `NadineNoTokenError`) are unwrapped by `state.runApi()` into the `ApiResult<T>` wire type.
- **`siman-client.ts`** wraps `https://siman-svc.kemenkeu.go.id` (the API host — the frontend is `siman.kemenkeu.go.id`, used as `Origin`/`Referer`). Two request modes: `request()` uses the base SIMAN token; `requestWithRole()` uses the role-scoped token and **auto-refreshes it on 401** by re-deriving the role filter from `idUserDetail`. Has its own `SimanHttpError` / `SimanNoTokenError`.
- **Important (Nadine)**: when fetching subordinate org units for the Nota Pengantar penandatangan picker, `kodeOrganisasi` MUST come from `GET /Auth/me → Data.CurrentUnit.KodeOrganisasi`, not from pengirim fields in the captured payload (names vary). See `handlers/templates.ts` `handleTemplateUnits`: prefer `Eselon == pengirimEselon + 1`, fall back to any unit below, cap at 15.

### SIMAN panel surface

The SIMAN tab (`App.tsx` `simanView`) is a deep navigation tree, not a single screen: `home → template-list → template-detail`; `home → daftar → run` (build a naskah from a saved template for a selected ticket); `home → evaluasi → evaluasi-detail`; and `home → monitoring → {monitoring-scrape | monitoring-ews → monitoring-ews-detail}`. Each leaf maps to a handler in `handlers/siman.ts` and usually a streaming port. `SimanRunView` / `SimanEwsDetailView` are the heaviest views (template execution and per-ticket EWS detail + note sync). The SIMAN home also offers "Ganti Role" (clears the SIMAN token so the user re-picks a role).

### Notifications watcher

`handlers/notifications.ts` runs a poll cycle on the 1-minute alarm. Per source (Nadine disposisi, Nadine amplop, SIMAN tickets): skip if disabled/no-token/no-role → fetch latest list → diff IDs against the persisted seen-set in `notif-seen-store` → on the **first** cycle for a source it only primes the set (no notification), thereafter fires `chrome.notification`(s) per truly-new item, batching when 2+ arrive together. Click opens the relevant Nadine/SIMAN inbox tab. Settings (`disposisi`/`amplop`/`siman` toggles) live in `asguard.notifSettings`. **Cold-start invariant**: `index.ts` awaits `_ready` before dispatching the alarm so the seen-set is restored — without that, every browser restart would re-notify every existing item.

### Update checking, backup, license

- **Update check** (`update-client.ts`): `GET /api/version` on the license server, semver compare vs `chrome.runtime.getManifest().version`, cached in `asguard.updateCheck` for 4h. Boot calls `shouldCheck()` then `checkForUpdate()` fire-and-forget; panel surfaces it via `update/check` + `update/get-cached` and an `UpdateBanner`.
- **Backup** (`backup/export`, `backup/import` in `router.ts`): exports/imports a fixed key set — `asguard.templates`, `asguard.simanTemplates`, `asguard.llmSettings`, `asguard.notifSettings`. Import re-loads settings + notification config and rebroadcasts state.
- **License** (`license-client.ts`): validates NIP against `/api/license/check`, cached in `asguard.license` for 24h. Status flows into `state.licenseStatus` and every `PanelSnapshot`. When invalid (and not offline/error), `App.tsx` renders a `LicenseGate` that blocks the whole panel.

### EWS notes sync

`ews-notes-client.ts` is **local-first**: notes (a user's confirmation about an EWS ticket's renewal status — `sudah_perpanjang` / `proses_perpanjangan` / `tidak` / `diperpanjang`, plus free-text and the perpanjangan ticket no.) are written to `chrome.storage.local` under `asguard.ews-notes` (keyed per-KPKNL, then per `no_tiket`) immediately, then pushed to `/api/ews/notes` fire-and-forget. Reads try server sync first and fall back to local. `ews/note-sync-one` does a single-ticket last-write-wins via `POST /notes/sync`. A one-shot legacy migration from `asguard.ews-confirmations` runs on read. **The server is a convenience, not a dependency** — every feature works offline against local storage.

### PDF extraction quirk

Service workers cannot run `pdf.js` — dynamic `import()` is blocked on `ServiceWorkerGlobalScope`, and `Worker`/`OffscreenCanvas` aren't available. So the background delegates extraction to the sidepanel: it base64-encodes the PDF and sends `{ type: "pdf/extract", base64 }` over the LLM port; the panel (`sidepanel/pdf-extract.ts`) decodes, runs `pdfjs-dist`, and replies with `{ type: "pdf/text", text, ndId }`. If you add PDF handling, keep that split.

Three PDF acquisition strategies exist, in preference order (see `handlers/nadine-auth.ts` `handleSummarize`): (0) PDF captured by `page-inject.ts` from the page's own network (freshest auth, matches what the user sees), (1) explicit download via `PathKonsep`, (2) lampiran download. Captured PDFs live in an in-memory `Map<ndId, …>` with a 5-minute TTL.

### Mail Merge

`src/sidepanel/mailmerge/` runs entirely in the panel: `placeholder-scan.ts` (detect `{{VAR}}` in `.docx`), `excel-parser.ts` (`.xlsx` → rows via `xlsx`), `docx-render.ts` (fill placeholders via `docxtemplater` + `pizzip`). The `mail-merge-run` port streams per-document progress; rendered docs are offered as browser downloads from the sidepanel.

### Template storage

- Nadine: `background/template-store.ts` stores `NaskahTemplate[]` in `chrome.storage.local` under `asguard.templates`. Each holds the raw `CreateNaskahPayload` from `naskah/created` plus optional konsep `.docx` (base64) and Nota Pengantar data/docx. No schema migration — read defensively.
- SIMAN: `asguard.simanTemplates` holds `SimanTemplate[]`. SIMAN token state is separate, in `chrome.storage.session` under `asguard.simanTokenState`.

### Sidepanel navigation

`App.tsx` manages two independent stacks plus a license gate:

- **Nadine tab** (`activeTab === "nadine"`): `view` ∈ `"home" | "summary" | "template" | "settings" | "arsiparis" | "update"`, with `subView` for the template sub-stack (`list → detail → mailmerge | manual-input`).
- **SIMAN tab** (`activeTab === "siman"`): `simanView.kind` ∈ `{ home, template-list, template-detail, daftar, evaluasi, evaluasi-detail, monitoring, monitoring-scrape, monitoring-ews, monitoring-ews-detail, run }` (see "SIMAN panel surface" above).
- A license block renders `LicenseGate` for the whole panel when the license is invalid.

### Manifest permissions

Defined programmatically in `src/manifest.config.ts` (not a static `manifest.json`). The manifest pins a **`key`** (public key derived from `dist.pem`) so the extension ID is stable across installs/unpacked-reloads — this is what lets `chrome.storage.local` (templates, settings, tokens) survive when users unzip a new release into a different folder. **Do not change the key** without accepting that every existing user loses their stored data.

Host permissions cover Nadine (`satu`/`service`/`satu-notif`/`satu-file.kemenkeu.go.id`), SIMAN (`siman`/`siman-svc.kemenkeu.go.id`), `localhost:8080` / `127.0.0.1:8080` for llama.cpp, and the license server `vps.asetpattimura.my.id`. Content scripts match `satu`, `service`, and `siman.kemenkeu.go.id`. Permissions include `downloads` and `notifications` (for mail-merge/EWS doc downloads and the watcher). **If you add a new Kemenkeu host, update BOTH `host_permissions` and the content-script `matches`.**

### Path alias

`@/…` resolves to `src/…` (configured in both `vite.config.ts` and `tsconfig.json`). Preact compat is aliased for `react`/`react-dom` imports, so libraries that import `react` work unchanged.

## Conventions

- **User-facing strings are in Indonesian** (matches the parent Python CLI). Code identifiers, comments, and console logs are in English.
- **Never persist tokens to disk or log them.** Nadine token → `chrome.storage.local` via `token-store`; SIMAN token → `chrome.storage.session` via `siman-store`. `console.log` in `page-inject.ts` deliberately logs only the origin hostname, not the bearer value.
- **Don't import Node or Chromium-privileged APIs into content scripts.** `page-inject.ts` runs in the page's realm and must stay pure DOM/Web API.
- **Adding a new message type**: add the type to `src/shared/types.ts` (or `siman-types.ts`), add a handler in the appropriate `handlers/*.ts`, and add a dispatch branch in `router.ts`. Don't add it directly to `index.ts`.
- **Adding a new streaming port**: create `ports/<name>.ts`, add a connect branch in `router.ts`, add the port name and its message union to `src/shared/types.ts`.
- **`vps.asetpattimura.my.id` is shared**: license (`/api/license`), updates (`/api/version`), and EWS notes (`/api/ews`) all live there. Keep those concerns in their own clients.
