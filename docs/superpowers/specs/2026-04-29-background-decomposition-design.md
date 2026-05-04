# Design: Decompose `background/index.ts` (2,145 → ~6 files)

**Date**: 2026-04-29
**Status**: Proposed

## Problem

`background/index.ts` is a 2,145-line God Module containing:
- 50+ message handlers in a single flat `if/return` ladder
- 5 streaming port handlers (llm-stream, template-run, mail-merge-run, arsip-run, siman-run)
- 10 domain concerns: Nadine auth, SIMAN auth, LLM, templates, arsiparis, mail merge, license, settings, PDF capture, SIMAN pengelolaan
- Shared mutable state (`llmSettings`, `_activeTab`, `_licenseStatus`, `pendingPayload`, `_capturedPenetapanBody`, `capturedPdfs`, `naskahTextCache`)

Adding any feature requires understanding the entire file. The flat handler chain means merge conflicts are likely. No individual domain can be tested in isolation.

## Design

### Principles
1. **One domain per module** — each file handles one concern
2. **Shared state via explicit dependency injection** — modules receive state accessors, not import globals
3. **Router stays thin** — `index.ts` becomes a ~200-line router that delegates
4. **Port handlers are standalone functions** — each gets its own file
5. **Zero behavioral changes** — pure structural refactor, same runtime behavior

### Target Structure

```
src/background/
├── index.ts                    # Router + shared state (~200 lines)
├── state.ts                    # Shared state module (~80 lines)
├── router.ts                   # onMessage + onConnect dispatcher (~100 lines)
├── handlers/
│   ├── nadine-auth.ts          # token/capture, page/changed, viewing/ndId, pdf/captured, naskah/created
│   ├── siman-auth.ts           # siman/token, siman/role-data
│   ├── settings.ts             # settings/get, settings/set, llm/health, cache/clear
│   ├── templates.ts            # template/* CRUD + template/units + template/pending
│   ├── arsiparis.ts            # arsip/fetch, arsip/berkas-list, arsip/berkas-create, arsip/klasifikasi-*, arsip/bulk
│   ├── siman.ts                # siman/state, siman/token-clear, siman/penetapan-body, siman/get-*, siman/set-*, siman/template-*
│   └── license.ts              # license/check, license/clear-cache
├── ports/
│   ├── llm-stream.ts           # handleSummarize + handleChat (from current index.ts lines ~1200-1440)
│   ├── template-run.ts         # handleTemplateRun
│   ├── mail-merge-run.ts       # handleMailMergeRun
│   ├── arsip-run.ts            # handleArsipRun + runAutoArsip
│   └── siman-run.ts            # siman/run, siman/upload-nd, siman/run-render + helpers
├── token-store.ts              # (unchanged)
├── siman-store.ts              # (unchanged)
├── nadine-client.ts            # (unchanged)
├── siman-client.ts             # (unchanged)
├── llama-client.ts             # (unchanged)
├── template-store.ts           # (unchanged)
├── summary-cache.ts            # (unchanged)
├── license-client.ts           # (unchanged)
├── terbilang.ts                # (unchanged)
└── pdf-extract.ts              # (unchanged)
```

### Module Responsibilities

#### `state.ts` — Shared State Access

```typescript
// Centralizes all mutable state that's currently loose in index.ts
// Other modules import and call these functions — no direct global mutation

export let llmSettings: LlmSettings;
export let pendingPayload: Record<string, unknown> | null;
export let activeTab: "nadine" | "siman";
export let licenseStatus: LicenseStatus | null;
export let capturedPenetapanBody: Record<string, unknown> | null;
export const capturedPdfs: Map<string, { base64: string; url: string; capturedAt: number }>;
export const naskahTextCache: Map<string, { body: string; meta: Record<string, string | undefined> }>;

export function loadSettings(): Promise<void>;
export function saveSettings(partial: Partial<LlmSettings>): Promise<LlmSettings>;
export function snapshot(): PanelSnapshot;
export function broadcastState(): void;
export function refreshLicense(nip: string): Promise<void>;
// ... setters for each piece of state
```

#### `router.ts` — Thin Dispatcher

Reads `raw.type`, calls the right handler function. No business logic.

```typescript
// onMessage: switches on raw.type prefix and delegates to handlers/nadine-auth.ts, etc.
// onConnect: switches on port.name and delegates to ports/*.ts
```

#### `handlers/*.ts` — Request/Response Handlers

Each exports functions matching `(raw, sendResponse) => Promise<void>`.
They import from `state.ts` for shared state and from `*-client.ts` for API calls.

#### `ports/*.ts` — Streaming Port Handlers

Each exports a function that takes the `port` and sets up `onMessage`/`onDisconnect` listeners.

### Dependency Flow

```
index.ts
  └── router.ts
        ├── handlers/nadine-auth.ts ──┐
        ├── handlers/siman-auth.ts   │
        ├── handlers/settings.ts     ├── state.ts (shared state)
        ├── handlers/templates.ts    │
        ├── handlers/arsiparis.ts    │
        ├── handlers/siman.ts        │
        ├── handlers/license.ts    ──┘
        ├── ports/llm-stream.ts    ──┐
        ├── ports/template-run.ts     │
        ├── ports/mail-merge-run.ts   ├── state.ts
        ├── ports/arsip-run.ts        │
        └── ports/siman-run.ts      ──┘
```

No circular dependencies: handlers/ports → state → stores/clients.

### Migration Strategy

1. Create `state.ts` — extract all shared mutable state + `snapshot()` + `broadcastState()`
2. Create `handlers/` one at a time — extract each handler block, verify tsc still passes after each
3. Create `ports/` one at a time — extract each port handler function
4. Create `router.ts` — wire up the dispatch
5. Slim down `index.ts` to init + router call
6. Delete 37 stale `.js` files

Each step is independently verifiable with `tsc --noEmit`.

### What Does NOT Change

- All existing `*-store.ts`, `*-client.ts` files — untouched
- `content/` scripts — untouched
- `sidepanel/` — untouched
- `manifest.config.ts` — untouched
- All message types and wire protocols — identical
- Runtime behavior — identical (pure structural refactor)

### Estimated Sizes After Refactor

| File | Lines |
|------|-------|
| `index.ts` | ~60 (init + keepalive + router call) |
| `state.ts` | ~120 |
| `router.ts` | ~100 |
| `handlers/nadine-auth.ts` | ~150 |
| `handlers/siman-auth.ts` | ~350 |
| `handlers/settings.ts` | ~40 |
| `handlers/templates.ts` | ~100 |
| `handlers/arsiparis.ts` | ~70 |
| `handlers/siman.ts` | ~200 |
| `handlers/license.ts` | ~40 |
| `ports/llm-stream.ts` | ~280 |
| `ports/template-run.ts` | ~260 |
| `ports/mail-merge-run.ts` | ~250 |
| `ports/arsip-run.ts` | ~300 |
| `ports/siman-run.ts` | ~350 |
| **Total** | **~2,270** (slight increase from imports/exports, but navigable) |

### Risks

- **Risk**: Service worker module loading order — state must be initialized before any handler runs
  - **Mitigation**: Keep the existing `_ready` promise pattern in `index.ts`, pass it through to router
- **Risk**: Circular imports if handlers import from each other
  - **Mitigation**: Enforce one-directional flow: handlers → state → stores/clients. No handler imports another handler.
- **Risk**: Breaking change if a handler accesses shared state that was moved
  - **Mitigation**: `state.ts` exports everything needed; `tsc --noEmit` catches any missed reference
