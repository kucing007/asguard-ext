# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`asguard-ext` is a Manifest V3 Chrome extension that is the browser companion to the Asguard/Nadine Python CLI in `../src/nadine/`. It piggybacks on the user's live Nadine session (`satu.kemenkeu.go.id` / `service.kemenkeu.go.id`) to stream AI summaries of naskah dinas from a local `llama.cpp` server, save/replay naskah-creation templates, run mail merge batches, file E-Arsip records, and manage SIMAN (BMN asset) templates. Preact + Vite + `@crxjs/vite-plugin`, no backend — everything runs in the browser plus a localhost LLM.

## Commands

```bash
npm install
npm run dev          # Vite dev server with HMR (CRX plugin reloads the unpacked extension)
npm run build        # tsc --noEmit then vite build → dist/
npm run typecheck    # tsc --noEmit (no emit; same pass build does)
npm run zip          # zip dist/ → asguard-ext.zip for distribution
npm run dist         # bash build-dist.sh — produces dist.crx + dist.pem for signed distribution
```

There are no lint, format, or test commands configured in this project — `tsc --noEmit` is the only static check. Load the unpacked extension from `dist/` via `chrome://extensions` → Developer mode → Load unpacked.

## Architecture

### Three execution contexts

The extension is split across three JS realms that cannot share state directly — all state flows through `chrome.runtime` messaging:

1. **Content scripts** (`src/content/`) — injected into `satu.kemenkeu.go.id` and `service.kemenkeu.go.id` at `document_start`:
   - `page-inject.ts` runs in `world: "MAIN"` (same realm as the Angular app). It monkey-patches `window.fetch` and `XMLHttpRequest` to sniff the `Authorization: Bearer …` header the first time the app calls the Nadine API, and to clone PDF response bodies for reuse. It also scrapes `ndId` from `DetailKonsepByNdId/{id}` URLs. It cannot use `chrome.*` APIs, so it posts results to the window via `window.postMessage({ __asguard: true, … })`.
   - `index.ts` runs in the ISOLATED world. It listens for those `window.postMessage` events and forwards them to the background service worker with `chrome.runtime.sendMessage`.
2. **Background service worker** (`src/background/`) — the single source of truth. Holds the captured token, current `ndId`, LLM settings, cached summaries, and saved templates. Also runs a 1-minute `chrome.alarms` keepalive that pings `/nadine-nanas/auth/now` so the token doesn't expire.
3. **Side panel** (`src/sidepanel/`) — Preact UI. Opens on action-click (`chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`). Reads snapshots from the background, subscribes to `state/changed` broadcasts, and opens a streaming `Port` for LLM output.

### Background module layout

The background is split into focused modules — don't collapse them back into `index.ts`:

- **`index.ts`** — boot only: restore stores, load settings, restore/refresh license, call `setupRouter()`.
- **`state.ts`** — shared mutable state (`llmSettings`, `pendingPayload`, `activeTab`, `licenseStatus`, `capturedPdfs`, `naskahTextCache`) plus utilities: `snapshot()`, `broadcastState()`, `runApi<T>()`, `sleep()`, and typed setters. All handlers import from here instead of sharing closures.
- **`router.ts`** — thin dispatcher: `chrome.runtime.onMessage` delegates to domain handlers; `chrome.runtime.onConnect` delegates to port modules.
- **`handlers/`** — one file per domain:
  - `nadine-auth.ts` — token capture, page changed, ndId, PDF captured, naskah created, API calls
  - `siman-auth.ts` — SIMAN token/role data capture from content scripts
  - `settings.ts` — LLM settings get/set, health check, cache clear
  - `templates.ts` — Nadine naskah template CRUD + unit picker
  - `arsiparis.ts` — E-Arsip fetch, berkas list/create, klasifikasi, bulk archival
  - `siman.ts` — SIMAN panel requests (state, token clear, penetapan body, roles, templates CRUD)
  - `license.ts` — license check and cache clear
- **`ports/`** — one file per streaming port:
  - `llm-stream.ts` — `llm-stream` port: AI summary + chat streaming from llama.cpp
  - `template-run.ts` — `template-run` port: replay a saved naskah template
  - `mail-merge-run.ts` — `mail-merge-run` port: batch docx mail-merge generation
  - `arsip-run.ts` — `arsip-run` port: streaming E-Arsip bulk submission
  - `siman-run.ts` — `siman-run` port: SIMAN template execution (generate + upload naskah)

### Messaging patterns

- **Request/response**: `chrome.runtime.sendMessage` with `PanelRequest` / `BgMessage` unions in `src/shared/types.ts`. Every handler returns `true` to keep the channel open for async `sendResponse`.
- **Streaming**: `chrome.runtime.connect({ name: "<port-name>" })`. Active ports: `llm-stream`, `template-run`, `mail-merge-run`, `arsip-run`, `siman-run`. `LlmStreamMsg`, `TemplateRunMsg`, `MailMergeRunMsg`, `ArsipPortMsg`, `SimanRunMsg` are the wire types.
- **State broadcast**: background calls `broadcastState()` which sends `{ type: "state/changed", snapshot }` — the panel's `onMessage` listener reactively updates.

### Token lifecycle

- **Nadine token** — captured by `page-inject.ts` sniffing outbound headers. Persisted to `chrome.storage.local` via `token-store.ts`. Cleared on 401/403. Panel shows `TokenWarning` when `snap.token.token` is falsy.
- **SIMAN token** — captured from SIMAN API calls by `page-inject.ts`. Stored in `chrome.storage.session` via `siman-store.ts` (clears when the browser closes). Includes NIP, userId, fullname, jabatan, and selected role context.
- **NIP** is available from both stores (`store.getToken().nip` or `simanStore.getSimanToken().nip`). The background uses whichever is non-null to drive license checks.

### License system

`background/license-client.ts` validates the user's NIP against `https://vps.asetpattimura.my.id/api/license/check`. Results are cached in `chrome.storage.local` under `asguard.license` for 24 hours. On boot, the cached result is restored immediately; a fresh check fires in the background if a NIP is known. License status flows into `state.licenseStatus` and is included in every `PanelSnapshot`.

### PDF extraction quirk

Service workers cannot run `pdf.js` — dynamic `import()` is blocked on `ServiceWorkerGlobalScope`, and `Worker`/`OffscreenCanvas` aren't available. So the background delegates extraction to the sidepanel: it base64-encodes the PDF and sends `{ type: "pdf/extract", base64 }` over the LLM port; the panel (`sidepanel/pdf-extract.ts`) decodes, runs pdf.js, and replies with `{ type: "pdf/text", text, ndId }`. If you add PDF handling, keep that split.

There are three PDF acquisition strategies in order of preference (see `handlers/nadine-auth.ts` `handleSummarize`): (0) PDF captured by `page-inject.ts` from the page's own network (most reliable — freshest auth, matches what the user sees), (1) explicit download via `PathKonsep`, (2) lampiran download. Captured PDFs are kept in an in-memory `Map<ndId, …>` with a 5-minute TTL.

### Nadine API client

`background/nadine-client.ts` wraps `https://service.kemenkeu.go.id/nadine-nanas`. All requests attach `Authorization: Bearer <token>` from `token-store`. Two custom error classes (`NadineHttpError`, `NadineNoTokenError`) are unwrapped by `state.runApi()` into the `ApiResult<T>` wire type.

**Important**: when fetching subordinate org units for the Nota Pengantar penandatangan picker, `kodeOrganisasi` MUST come from `GET /Auth/me → Data.CurrentUnit.KodeOrganisasi`, not from the pengirim fields in the captured payload — pengirim field names vary. See `handlers/templates.ts` `handleTemplateUnits` for the filter: prefer `Eselon == pengirimEselon + 1`, fall back to any unit below, cap at 15.

### Mail Merge

`src/sidepanel/mailmerge/` contains three utility modules run entirely in the panel:
- `placeholder-scan.ts` — detects `{{VAR}}` placeholders in a `.docx` template
- `excel-parser.ts` — reads an Excel file (`.xlsx`) into rows using the `xlsx` library
- `docx-render.ts` — fills placeholders in a `.docx` template using `docxtemplater` + `pizzip`

The `mail-merge-run` port streams per-document progress from the background to the panel. Rendered documents are offered as browser downloads from the sidepanel.

### Template storage

`background/template-store.ts` stores `NaskahTemplate[]` in `chrome.storage.local` under `asguard.templates`. Each template holds the raw `CreateNaskahPayload` captured from `naskah/created` plus optional konsep `.docx` (base64) and Nota Pengantar data/docx. No schema migration logic — if the shape changes, handle it defensively at read.

`background/siman-store.ts` stores `SimanTemplate[]` in `chrome.storage.local` under `asguard.simanTemplates`. SIMAN token state is stored separately in `chrome.storage.session` under `asguard.simanTokenState`.

### Sidepanel navigation

`App.tsx` manages two independent navigation stacks:

- **Nadine tab** (`activeTab === "nadine"`): `view` ∈ `"home" | "summary" | "template" | "settings" | "arsiparis"`, with `subView` for the template sub-stack (`list → detail → mailmerge`).
- **SIMAN tab** (`activeTab === "siman"`): `simanView` ∈ `{ kind: "home" | "template-list" | "template-detail" | "daftar" | "run" }`.

### Manifest permissions

Defined programmatically in `src/manifest.config.ts` (not a static `manifest.json`). Host permissions cover the Nadine API hosts plus `localhost:8080` / `127.0.0.1:8080` for llama.cpp. The content scripts match both `satu.kemenkeu.go.id` and `service.kemenkeu.go.id`. If you add a new Kemenkeu host, update BOTH `host_permissions` and the content-script `matches`.

### Path alias

`@/…` resolves to `src/…` (configured in both `vite.config.ts` and `tsconfig.json`). Preact compat is aliased for `react`/`react-dom` imports, so libraries that import `react` work unchanged.

## Conventions

- **User-facing strings are in Indonesian** (matches the parent Python CLI). Code identifiers, comments, and console logs are in English.
- **Never persist tokens to disk or log them.** Nadine token goes to `chrome.storage.local` via `token-store`; SIMAN token to `chrome.storage.session` via `siman-store`. `console.log` in `page-inject.ts` deliberately logs only the origin hostname, not the bearer value.
- **Don't import Node or Chromium-privileged APIs into content scripts.** `page-inject.ts` in particular runs in the page's realm and must stay pure DOM/Web API.
- **Adding a new message type**: add the type to `src/shared/types.ts`, add a handler in the appropriate `handlers/*.ts` file, and add a dispatch branch in `router.ts`. Don't add it directly to `index.ts`.
- **Adding a new streaming port**: create `ports/<name>.ts`, add a connect branch in `router.ts`, add the port name and its message union to `src/shared/types.ts`.
