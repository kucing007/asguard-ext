# Asguard Chrome Extension — Roadmap + Phase 1 Plan

## Context

You want to rebuild the core of the existing Asguard/Nadine CLI (`/Users/fahri/Automation/nadine`) as a Chrome extension that works directly inside the browser while you use Nadine (`satu.kemenkeu.go.id` / `service.kemenkeu.go.id`). The extension will use a local LLM (llama.cpp serving a Gemma model) to summarize naskah dinas, and — in later phases — draft replies, capture "save this naskah as a template after I submit it," and run mail-merge batches against Nadine.

**Why a browser extension beats the current CLI for this use case:**
- No more separate Playwright login flow. When you're on Nadine, you're already authenticated — the extension can reuse the session token that the SPA already holds.
- AI summary and reply drafting live right next to the naskah you're reading.
- Mail-merge from a saved template becomes a button on the Nadine create page, not a separate terminal workflow.

**Confirmed decisions (from brainstorm):**
1. **Architecture:** pure-browser Chrome extension. No Python companion server. LLM via `llama.cpp` local HTTP server.
2. **MVP (Phase 1):** read a naskah on Nadine → show AI summary in a side panel. No writing to Nadine yet.
3. **Phase 2:** capture naskah payload when user submits the create form → save as named template in IndexedDB.
4. **UI surface:** Chrome Side Panel (MV3 `chrome.sidePanel` API), professional-minimalist.
5. **Model:** start with a Gemma E4B-it GGUF (user mentioned `bartowski/google_gemma-*-E4B-it-GGUF:Q6_K`) on llama.cpp default port `8080`, OpenAI-compatible `/v1/chat/completions`. Model name is configurable in Settings so you can swap later.

---

## What the existing app gives us (reference)

From exploration of `src/nadine/`:

### Nadine API map (we reuse these exact endpoints, no discovery needed)
Base URL: `https://service.kemenkeu.go.id`.

| Purpose | Method + Path | Source |
|---|---|---|
| Inbox counts | `GET /nadine-nanas/mejaku/counts/mejaku` | `api/client.py:338` |
| Surat Masuk list | `GET /nadine-nanas/mejaku/mejaku/amplop` | `api/client.py:371` |
| Disposisi list | `GET /nadine-nanas/mejaku/mejaku/disposisi` | `api/client.py:416` |
| Konsep list | `GET /nadine-nanas/mejaku/mejaku/konsep` | `api/client.py:461` |
| Naskah detail | `GET /nadine-nanas/gateway/grid/konsepnaskah/DetailKonsepByNdId/{nd_id}?tipedata=AmplopDisposisi` | `api/client.py:704` |
| Attachments | `GET /nadine-nanas/gateway/grid/konsepnaskah/LampiranDataDukung/{nd_id}` | `api/client.py:551` |
| Disposisi detail | `GET /nadine-nanas/gateway/grid/disposisi/detail/{doc_id}/{nd_id}` | `api/client.py:565` |
| Mark read | `PATCH /nadine-nanas/gateway/grid/{type}/read/{id}/{nd_id}` | `api/client.py:725` |
| Session keep-alive | `GET /nadine-nanas/auth/now` | `api/session_keepalive.py:84` |
| Create naskah | `POST /nadine-nanas/konsepnaskah` (payload: `CreateNaskahPayload`) | `api/client.py` + `models/naskah_create.py:115` |
| Upload konsep file | `POST /nadine-nanas/konsepnaskah/UploadFileKonsep/{nd_id}` | `api/client.py:1060` |
| Sync/preview | `POST /nadine-nanas/gateway/file/upload/konsepnaskah/PreviewNaskahDinas/{nd_id}` | `api/client.py:1041` |

### What is **not** in the current CLI (future discovery needed)
- **Reply / disposisi-create** POST endpoint. Not implemented. Phase 3/4 must discover this by inspecting network traffic while replying manually on Nadine. We won't block Phase 1 on this.

### Template + mail-merge anatomy (Phase 2–3 fuel)
- Naskah templates persist at `~/.nadine/templates.json` via `cli/template_menu.py:TemplateStorage`. The payload is a full `CreateNaskahPayload` dict. **In the extension we'll store the equivalent in `chrome.storage.local` / IndexedDB.**
- Mail-merge config at `~/.nadine/mailmerge/templates.json` via `mailmerge/storage.py:MailMergeStorage`. Placeholder syntax is single-brace `{Name}`. Excel parsed with openpyxl (`mailmerge/parser.py`), docx rendered with python-docx (`mailmerge/generator.py`). For the extension we'll use **SheetJS (xlsx)** + **docxtemplater** — single-brace delimiters supported.
- Mail-merge → Nadine coupling already exists (`mailmerge/menu.py::_generate_and_run_nadine`): loops rows, generates docx, calls `create_naskah`, uploads, syncs. We port the same flow to JS in Phase 4.

---

## Architecture — pure browser

```
Chrome window (on satu.kemenkeu.go.id / service.kemenkeu.go.id)
 │
 ├── Content script (runs in Nadine's page context)
 │     - Detects which page you're on (inbox / naskah detail / create-naskah)
 │     - Reads session token from the SPA (localStorage / sessionStorage)
 │     - Sends page-context events to the service worker
 │
 ├── Service worker (background)
 │     - Owns the Nadine API client (fetch wrapper with Authorization header)
 │     - Owns the llama.cpp client (OpenAI-compatible fetch, streaming SSE)
 │     - Owns chrome.storage for settings + cached summaries
 │
 └── Side panel (UI, chrome.sidePanel.setOptions)
       - Minimal React/Preact or plain TS + CSS
       - Shows current-naskah summary, settings, (later) template list, batch runner
       - Talks to service worker via chrome.runtime messaging
```

**External dependencies the extension talks to:**
- `https://service.kemenkeu.go.id/*` — Nadine API (host permission required)
- `http://localhost:8080/*` — llama.cpp server (host permission required; user runs llama.cpp themselves, doc'd in README)

**No Python. No native messaging. No companion server.**

---

## Full roadmap

Each phase is its own buildable unit and gets its own detailed spec when we start it.

### Phase 1 — Scaffold + Read & Summarize  ← **we build this first**
Extension scaffold, session-token capture, naskah-detail detection, llama.cpp streaming summary in the side panel. Ship when you can open a real naskah on Nadine and see a streamed Indonesian summary + bullet points in the side panel.

### Phase 2 — Save-as-Template after create
Content script watches the 11-step create-naskah form; on submit it serializes the final `CreateNaskahPayload` (matches `models/naskah_create.py:CreateNaskahPayload`) and shows a "Save as template?" prompt. Templates live in IndexedDB. A Templates tab in the side panel lists saved templates with "Replay" (fills the create form for you) and "Delete."

### Phase 3 — AI-drafted reply (disposisi)
Two sub-parts:
- **3a. Endpoint discovery** — observe network calls while replying manually on Nadine, capture the request, build a typed payload model. This is research work; deliver a small doc first.
- **3b. Draft flow** — side panel adds "Draft reply" button on naskah detail → sends body + context to llama.cpp → returns editable draft → user clicks Send → extension POSTs to the discovered endpoint.

### Phase 4 — Mail-merge + batch create
- Upload .docx template + .xlsx data in the side panel.
- SheetJS reads rows; docxtemplater renders per-row .docx blobs.
- Pick a saved template (from Phase 2) as the "naskah envelope."
- "Run batch" loops rows: generate docx → `POST /konsepnaskah` with template payload + row overrides → upload docx → sync.
- Mirrors `mailmerge/menu.py::_generate_and_run_nadine`.

### Phase 5 — Polish
Multiple LLM profiles, prompt library per naskah type, download summaries as markdown, rate-limit + retry UX, keyboard shortcuts, empty / error / offline states, basic telemetry toggle.

---

## Phase 1 — detailed plan

### Deliverable
When you open a naskah detail page on Nadine and click the Asguard extension icon, the side panel opens, fetches that naskah's body, streams an AI summary from your local llama.cpp, and shows it alongside the body's key metadata. Minimalist UI. Nothing written to Nadine.

### Tech choices
- **Manifest V3**, TypeScript, Vite (`@crxjs/vite-plugin`) for HMR and bundling.
- **UI:** Preact + vanilla CSS (tiny bundle, professional minimalism is CSS not a framework). No Tailwind, no component library — we control type, spacing, color tokens directly.
- **Messaging:** `chrome.runtime.sendMessage` + long-lived `chrome.runtime.connect` port for streaming LLM tokens from service worker → side panel.
- **Storage:** `chrome.storage.local` for settings (LLM URL, model name, system prompt). IndexedDB (via `idb` lib) reserved for Phase 2 templates.
- **LLM client:** plain `fetch` with `ReadableStream` to parse SSE from llama.cpp `/v1/chat/completions` (`stream: true`).

### File layout (new repo, sibling to existing)
```
asguard-ext/
├── manifest.json              (MV3)
├── package.json
├── vite.config.ts
├── tsconfig.json
├── src/
│   ├── background/
│   │   ├── index.ts           entry, wires messaging
│   │   ├── nadine-client.ts   fetch wrapper for service.kemenkeu.go.id
│   │   ├── llama-client.ts    OpenAI-compat streaming client
│   │   └── token-store.ts     holds last seen bearer token
│   ├── content/
│   │   ├── index.ts           entry on satu.kemenkeu.go.id
│   │   ├── page-detector.ts   URL → page-kind (inbox | detail | create | other)
│   │   ├── token-sniffer.ts   reads localStorage / sessionStorage / cookies
│   │   └── naskah-context.ts  extracts ndId from URL on detail pages
│   ├── sidepanel/
│   │   ├── index.html
│   │   ├── main.tsx           Preact mount
│   │   ├── App.tsx            router + current-page branching
│   │   ├── views/
│   │   │   ├── EmptyView.tsx       when not on a naskah
│   │   │   ├── SummaryView.tsx     Phase 1 main view
│   │   │   └── SettingsView.tsx    llama URL, model, prompt
│   │   ├── components/
│   │   │   ├── StreamingText.tsx
│   │   │   ├── Metadata.tsx
│   │   │   └── Button.tsx
│   │   └── styles.css
│   ├── shared/
│   │   ├── types.ts           Naskah, Message discriminated union
│   │   ├── prompts.ts         summary system prompt (Indonesian)
│   │   └── messaging.ts       typed wrappers over chrome.runtime
│   └── icons/                 16/32/48/128 png
├── README.md                  setup: llama.cpp install + model + run
└── tests/
    └── prompts.test.ts        snapshot test on summary prompt
```

### Step-by-step build order

**S1 — Scaffold and "hello world" side panel** *(half day)*
- `npm create vite` + add `@crxjs/vite-plugin`.
- `manifest.json`: `manifest_version: 3`, `side_panel.default_path`, `action.default_title`, `permissions: ["storage", "sidePanel", "scripting", "activeTab"]`, `host_permissions: ["https://satu.kemenkeu.go.id/*", "https://service.kemenkeu.go.id/*", "http://localhost:8080/*"]`.
- Verify: load unpacked, click icon, side panel opens.

**S2 — Content script: detect page + sniff token** *(1 day)*
- Register content script matching `https://satu.kemenkeu.go.id/*`.
- `page-detector.ts`: classify URL — detail pages usually contain an `ndId` in the path or query. Do a one-time manual walk on Nadine with devtools open to confirm the exact URL pattern before coding.
- `token-sniffer.ts`: at content-script start, scan `localStorage`, `sessionStorage`, and a few common keys (`access_token`, `token`, `nadineToken`). If not found, fall back to listening for `fetch` / `XMLHttpRequest` via a page-world injected script and capture the `Authorization: Bearer` from the first outgoing request to `service.kemenkeu.go.id`. Send the token to the service worker via `chrome.runtime.sendMessage`.
- Service worker stores token in-memory + `chrome.storage.session` (cleared when Chrome closes).
- Verify: log from service worker shows captured token on any Nadine page.

**S3 — Background: Nadine API client** *(half day)*
- `nadine-client.ts`: one `fetch` wrapper that sets `Authorization: Bearer <token>`, `Accept: application/json`. Mirror `api/client.py` shapes.
- Implement only what Phase 1 needs:
  - `getNaskahDetail(ndId)` → `GET /nadine-nanas/gateway/grid/konsepnaskah/DetailKonsepByNdId/${ndId}?tipedata=AmplopDisposisi`
  - `getAttachments(ndId)` → `GET /nadine-nanas/gateway/grid/konsepnaskah/LampiranDataDukung/${ndId}` *(optional for summary; nice for UI)*
- Handle 401 → clear stored token, prompt user to refresh Nadine tab.
- Verify: from side panel, "Fetch current naskah" button pulls real data into console.

**S4 — Background: llama.cpp streaming client** *(half day)*
- `llama-client.ts`: POST to `${llamaBaseUrl}/v1/chat/completions` with `stream: true`. Parse SSE `data:` lines, yield deltas via an async generator. Port to a `chrome.runtime.Port` so the side panel gets tokens live.
- Verify: a "test prompt" button in Settings streams a reply token-by-token.

**S5 — Summary prompt + view wiring** *(1 day)*
- `shared/prompts.ts`: system prompt in Indonesian that asks for (a) 2-sentence ringkasan, (b) bullet list of poin penting, (c) tindakan yang disarankan (if any). Keep it short — the model is small.
- `SummaryView.tsx`: on mount, read current tab's ndId → background fetches naskah → streams `[naskah body + metadata]` through llama.cpp → renders into a `<StreamingText>` component that appends tokens as they arrive.
- Cache by `ndId` in `chrome.storage.local` so re-opening a previously summarized naskah is instant.
- Verify: open a real naskah, open side panel, see streamed summary in under 30s on CPU-only llama.cpp.

**S6 — Settings + minimalism pass** *(1 day)*
- `SettingsView.tsx`: llama URL (default `http://localhost:8080`), model name (default gemma E4B variant), max tokens, custom system-prompt override. Persist to `chrome.storage.local`.
- Styling: 1 typeface (Inter or system-ui), 8pt grid, neutral grays with a single accent, no shadows, no borders except 1px divider lines. Dark-mode via `prefers-color-scheme`.
- Empty / loading / error states for: no token captured yet, not on a naskah page, llama.cpp unreachable, 401 from Nadine.

**S7 — README + manual QA** *(half day)*
- README: how to install llama.cpp (`brew install llama.cpp` on mac), download gemma GGUF via Hugging Face CLI, run `llama-server -m <model.gguf> -c 8192 --port 8080`, load unpacked extension, open Nadine, done.
- Manual test matrix: inbox page (side panel shows "open a naskah"), detail page (summary streams), llama server off (clean error), expired token (clean re-auth prompt).

### Critical files to create
- `asguard-ext/manifest.json` — everything flows from this
- `asguard-ext/src/background/token-store.ts` — the one place token lifecycle lives
- `asguard-ext/src/content/token-sniffer.ts` — **the riskiest file;** needs real Nadine inspection to know where the SPA stashes its bearer token
- `asguard-ext/src/shared/prompts.ts` — summary quality = this file

### Existing code we mirror (read, don't copy, since it's Python)
- `src/nadine/config.py` `APIConfig` — endpoint constants
- `src/nadine/api/client.py::APIClient.get_naskah_detail` — response shape
- `src/nadine/models/nadine.py::NaskahDinas` — fields to surface in UI
- `src/nadine/api/session_keepalive.py` — if token TTL is short we add the same 60s ping

### Risks and how we defuse them
1. **Token is not in localStorage.** Fallback: page-world script hooks `fetch` + `XMLHttpRequest.send` and reads the `Authorization` header as the SPA makes its own API calls. First request will leak the token within seconds of page load. Confirm location before writing the sniffer — start with 15 minutes in devtools on `satu.kemenkeu.go.id`.
2. **CORS on `service.kemenkeu.go.id`.** Extensions with `host_permissions` bypass CORS for the service worker's `fetch`. Confirmed MV3 behavior. If it misbehaves, we move API calls out of the side panel (which is origin `chrome-extension://…`) and only do them from the service worker — already the plan.
3. **llama.cpp streaming quirks.** Some llama.cpp builds require `--api-key` or return SSE with different framing. The `llama-client.ts` has to tolerate missing `data: [DONE]` and handle JSON-delta chunks. Write one test against a real running server before wiring the UI.
4. **Model quality on E4B.** Gemma E4B quantized to Q6_K will produce decent Indonesian summaries but may hallucinate names. Keep the system prompt strict, show the source text side-by-side, never auto-send anything based on its output (we're not replying in Phase 1 anyway).

### Verification (end-to-end, before declaring Phase 1 done)
1. `llama-server -m gemma-*-E4B-it-Q6_K.gguf --port 8080 -c 8192` runs and responds to a curl to `/v1/chat/completions`.
2. Load unpacked extension in Chrome. Open `https://satu.kemenkeu.go.id`, log in normally. Extension icon lights up.
3. Open any naskah detail page. Click extension icon → side panel opens.
4. Within 2 seconds, side panel shows naskah metadata (No ND, Pengirim, Tanggal, Perihal) from real data.
5. Summary begins streaming within 3 seconds and completes in < 45s on a typical laptop.
6. Open a second naskah: metadata updates immediately, new summary streams.
7. Reopen the first naskah: summary appears instantly from cache.
8. Stop llama-server. Refresh side panel. Error state reads: "llama.cpp tidak terdeteksi di http://localhost:8080 — pastikan servernya berjalan."
9. Revoke token (log out from Nadine in the tab). Side panel reads: "Sesi Nadine kadaluarsa — buka ulang Nadine lalu refresh."
10. Manifest passes `chrome://extensions` warnings clean.

---

## Open questions (to answer before Phase 2)

1. Confirm the exact URL pattern for "naskah detail" page on Nadine (path format and where the `ndId` appears). Needs 15 min of real observation.
2. Confirm where the SPA stores the bearer token (`localStorage` key name, or only-in-memory). Needs 15 min of devtools.
3. Model choice: you mentioned `bartowski/google_gemma-4-E4B-it-GGUF:Q6_K` — that looks like a typo for the Gemma 3 E4B family. Pick the exact Hugging Face repo before S7 so the README links to it.
4. Language of the UI: Indonesian labels, English code/comments (same convention as the existing CLI)?
