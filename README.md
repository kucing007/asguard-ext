# Asguard — Nadine Chrome Extension

Companion browser extension to the Asguard/Nadine Python CLI in `../src/nadine/`.
Pure browser, Manifest V3, Preact + Vite, talks to a local `llama.cpp` server for
on-device AI summaries of naskah dinas.

## Status

**Phase 1 — complete.** Open a naskah detail page on Nadine, open the side panel,
and get a streamed AI summary from your local llama.cpp.

## Prerequisites

- Node.js ≥ 18
- Chrome 114+ (for `chrome.sidePanel`)
- `llama.cpp` server on `http://localhost:8080` (configurable in Settings)
- A Gemma GGUF model (recommended: `bartowski/google_gemma-3-4B-it-GGUF` Q6_K)

## Setup llama.cpp

```bash
# Install (macOS)
brew install llama.cpp

# Download model (pick one from Hugging Face)
huggingface-cli download bartowski/google_gemma-3-4B-it-GGUF \
  --include "google_gemma-3-4B-it-Q6_K.gguf" \
  --local-dir ./models

# Start server
llama-server -m models/google_gemma-3-4B-it-Q6_K.gguf -c 8192 --port 8080
```

Verify it works: `curl http://localhost:8080/health` should return `{"status":"ok"}`.

## Setup Extension

```bash
cd asguard-ext
npm install
npm run build
```

## Load into Chrome

1. Open `chrome://extensions`
2. Toggle **Developer mode**
3. Click **Load unpacked** → select `asguard-ext/dist`
4. Pin the extension; click its icon on any tab — the side panel opens

## Usage

1. Open `https://satu.kemenkeu.go.id`, log in normally
2. Navigate to a naskah detail page
3. Click the Asguard extension icon — side panel opens
4. The extension auto-captures your session token and fetches naskah metadata
5. AI summary streams from your local llama.cpp

**Settings** — click the ⚙ icon to configure:
- llama.cpp URL (default `http://localhost:8080`)
- Model name
- Max tokens
- Custom system prompt

## Development

```bash
npm run dev     # Vite dev server with HMR
npm run build   # Production build → dist/
npm run zip     # Package dist/ for distribution
```

## Layout

```
src/
  manifest.config.ts          ← MV3 manifest
  background/
    index.ts                  ← service worker (messaging, API, LLM streaming)
    nadine-client.ts          ← Nadine API fetch wrapper
    llama-client.ts           ← llama.cpp OpenAI-compat streaming client
    token-store.ts            ← token lifecycle management
    summary-cache.ts          ← ndId-keyed summary cache
  content/
    index.ts                  ← injected into satu.kemenkeu.go.id
    page-detector.ts          ← URL → page kind classification
    page-inject.ts            ← MAIN world script, hooks fetch/XHR for token
  sidepanel/
    index.html / main.tsx     ← Preact mount
    App.tsx                   ← router (Summary / Empty / Settings / TokenWarning)
    views/
      SummaryView.tsx         ← main Phase 1 view (metadata + streaming summary)
      EmptyView.tsx           ← guidance when not on a naskah
      SettingsView.tsx        ← LLM configuration + cache management
    components/
      StreamingText.tsx       ← text renderer with blinking cursor
      Metadata.tsx            ← naskah metadata card
    styles.css                ← design system (Inter, 8pt grid, dark mode)
  shared/
    types.ts                  ← all TypeScript types + message unions
    prompts.ts                ← Indonesian summary system prompt
  icons/                      ← PNGs (16/32/48/128)
```
