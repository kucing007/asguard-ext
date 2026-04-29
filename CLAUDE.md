# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`asguard-ext` is a Manifest V3 Chrome extension that is the browser companion to the Asguard/Nadine Python CLI in `../src/nadine/`. It piggybacks on the user's live Nadine session (`satu.kemenkeu.go.id` / `service.kemenkeu.go.id`) to stream AI summaries of naskah dinas from a local `llama.cpp` server and to save/replay naskah-creation templates. Preact + Vite + `@crxjs/vite-plugin`, no backend — everything runs in the browser plus a localhost LLM.

## Commands

```bash
npm install
npm run dev          # Vite dev server with HMR (CRX plugin reloads the unpacked extension)
npm run build        # tsc --noEmit then vite build → dist/
npm run typecheck    # tsc --noEmit (no emit; same pass build does)
npm run zip          # zip dist/ → asguard-ext.zip for distribution
```

There are no lint, format, or test commands configured in this project — `tsc --noEmit` is the only static check. Load the unpacked extension from `dist/` via `chrome://extensions` → Developer mode → Load unpacked.

## Architecture

### Three execution contexts

The extension is split across three JS realms that cannot share state directly — all state flows through `chrome.runtime` messaging:

1. **Content scripts** (`src/content/`) — injected into `satu.kemenkeu.go.id` and `service.kemenkeu.go.id` at `document_start`:
   - `page-inject.ts` runs in `world: "MAIN"` (same realm as the Angular app). It monkey-patches `window.fetch` and `XMLHttpRequest` to sniff the `Authorization: Bearer …` header the first time the app calls the Nadine API, and to clone PDF response bodies for reuse. It also scrapes `ndId` from `DetailKonsepByNdId/{id}` URLs. It cannot use `chrome.*` APIs, so it posts results to the window via `window.postMessage({ __asguard: true, … })`.
   - `index.ts` runs in the ISOLATED world. It listens for those `window.postMessage` events and forwards them to the background service worker with `chrome.runtime.sendMessage`.
2. **Background service worker** (`src/background/index.ts`) — the single source of truth. Holds the captured token, current `ndId`, LLM settings, cached summaries, and saved templates. Also runs a 1-minute `chrome.alarms` keepalive that pings `/nadine-nanas/auth/now` so the token doesn't expire.
3. **Side panel** (`src/sidepanel/`) — Preact UI. Opens on action-click (`chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`). Reads snapshots from the background, subscribes to `state/changed` broadcasts, and opens a streaming `Port` for LLM output.

### Messaging patterns

- **Request/response**: `chrome.runtime.sendMessage` with `PanelRequest` / `BgMessage` unions in `src/shared/types.ts`. Every handler in `background/index.ts` returns `true` to keep the channel open for async `sendResponse`.
- **Streaming**: `chrome.runtime.connect({ name: "llm-stream" })` for summaries/chat (token-by-token via `llm/chunk`), and `{ name: "template-run" }` for template-run progress. `LlmStreamMsg` and `TemplateRunMsg` are the wire types.
- **State broadcast**: background calls `broadcastState()` which sends `{ type: "state/changed", snapshot }` — the panel's `onMessage` listener reactively updates.

### Token lifecycle

- Token is captured opportunistically by `page-inject.ts` sniffing outbound headers. There is no login flow inside the extension — the user logs in normally on `satu.kemenkeu.go.id` and the token is picked up from the first authenticated call.
- `background/token-store.ts` persists it to `chrome.storage.local`, restored on service-worker wake via `store.restore()` at boot.
- 401/403 from any Nadine call clears the token (`nadine-client.ts` → `clearToken`). The panel shows `TokenWarning` when `snap.token.token` is falsy.

### PDF extraction quirk

Service workers cannot run `pdf.js` — dynamic `import()` is blocked on `ServiceWorkerGlobalScope`, and `Worker`/`OffscreenCanvas` aren't available. So the background delegates extraction to the sidepanel: it base64-encodes the PDF and sends `{ type: "pdf/extract", base64 }` over the LLM port; the panel (`sidepanel/pdf-extract.ts`) decodes, runs pdf.js, and replies with `{ type: "pdf/text", text, ndId }`. If you add PDF handling, keep that split.

There are three PDF acquisition strategies in order of preference (see `background/index.ts` `handleSummarize`): (0) PDF captured by `page-inject.ts` from the page's own network (most reliable — freshest auth, matches what the user sees), (1) explicit download via `PathKonsep`, (2) lampiran download. Captured PDFs are kept in an in-memory `Map<ndId, …>` with a 5-minute TTL.

### Nadine API client

`background/nadine-client.ts` wraps `https://service.kemenkeu.go.id/nadine-nanas`. All requests attach `Authorization: Bearer <token>` from `token-store`. Two custom error classes (`NadineHttpError`, `NadineNoTokenError`) are unwrapped by the `runApi` helper in `background/index.ts` into the `ApiResult<T>` wire type.

**Important**: when fetching subordinate org units for the Nota Pengantar penandatangan picker, `kodeOrganisasi` MUST come from `GET /Auth/me → Data.CurrentUnit.KodeOrganisasi`, not from the pengirim fields in the captured payload — pengirim field names vary. See `template/units` handler for the filter: prefer `Eselon == pengirimEselon + 1`, fall back to any unit below, cap at 15.

### Template storage

`background/template-store.ts` stores `NaskahTemplate[]` in `chrome.storage.local` under `asguard.templates`. Each template holds the raw `CreateNaskahPayload` captured from `naskah/created` plus optional konsep `.docx` (base64) and Nota Pengantar data/docx. No schema migration logic — if the shape changes, handle it defensively at read.

### Manifest permissions

Defined programmatically in `src/manifest.config.ts` (not a static `manifest.json`). Host permissions cover the Nadine API hosts plus `localhost:8080` / `127.0.0.1:8080` for llama.cpp. The content scripts match both `satu.kemenkeu.go.id` and `service.kemenkeu.go.id`. If you add a new Kemenkeu host, update BOTH `host_permissions` and the content-script `matches`.

### Path alias

`@/…` resolves to `src/…` (configured in both `vite.config.ts` and `tsconfig.json`). Preact compat is aliased for `react`/`react-dom` imports, so libraries that import `react` work unchanged.

## Conventions

- **User-facing strings are in Indonesian** (matches the parent Python CLI). Code identifiers, comments, and console logs are in English.
- **Never persist tokens to disk or log them.** The token goes to `chrome.storage.local` via `token-store` only; `console.log` in `page-inject.ts` deliberately logs only the origin hostname, not the bearer value.
- **Don't import Node or Chromium-privileged APIs into content scripts.** `page-inject.ts` in particular runs in the page's realm and must stay pure DOM/Web API.
