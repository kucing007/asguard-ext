# SIMAN V2 Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add SIMAN V2 (BMN asset management) to the Asguard Chrome extension as an isolated module alongside Nadine, with a tab switcher, SIMAN token capture, Template Pengelolaan management, Daftar Pengelolaan browsing, and single-penetapan Nadine naskah generation.

**Architecture:** Isolated module approach — SIMAN lives in dedicated files (`siman-client.ts`, `siman-store.ts`, `siman-types.ts`, five new views) that integrate through the existing message bus. Nadine code is untouched. A tab switcher in `App.tsx` switches between Nadine and SIMAN contexts; `activeTab` in `BgState` auto-updates based on which website is active.

**Tech Stack:** Preact, TypeScript, Chrome MV3 (service worker + content scripts + sidepanel), `chrome.storage.session/local`, existing `docx-render.ts` + `placeholder-scan.ts` from mailmerge module.

---

## File Map

**New files:**
- `src/shared/siman-types.ts` — all SIMAN TypeScript types + `SimanRequest` message union
- `src/background/siman-store.ts` — `SimanTokenState` in `chrome.storage.session` + `SimanTemplate` CRUD in `chrome.storage.local`
- `src/background/siman-client.ts` — HTTP client for `siman-svc.kemenkeu.go.id`
- `src/background/terbilang.ts` — Indonesian number-to-words utility (port from Python CLI)
- `src/sidepanel/views/SimanHomeView.tsx` — SIMAN tab home (cards + role badge + user info)
- `src/sidepanel/views/SimanTemplateListView.tsx` — list/create/delete SIMAN templates
- `src/sidepanel/views/SimanTemplateDetailView.tsx` — create/edit template (upload .docx, map placeholders)
- `src/sidepanel/views/SimanDaftarView.tsx` — paginated penetapan list with "Buat Naskah" button
- `src/sidepanel/views/SimanRunView.tsx` — fetch → variable preview → render → create naskah progress

**Modified files:**
- `src/shared/types.ts` — add `SimanTokenState`, `simanToken` + `activeTab` to `PanelSnapshot`; add SIMAN message types to `BgMessage` and `PanelRequest`
- `src/background/index.ts` — SIMAN message router + `siman-run` port handler; restore SIMAN token on boot
- `src/content/page-inject.ts` — detect `siman.kemenkeu.go.id` domain → post `siman/token` message
- `src/content/index.ts` — forward `siman/token` postMessage to background
- `src/content/page-detector.ts` — add `siman` page kind + SIMAN URL detection
- `src/manifest.config.ts` — add `siman.kemenkeu.go.id` + `siman-svc.kemenkeu.go.id` to matches + host_permissions
- `src/sidepanel/App.tsx` — tab switcher + SIMAN view routing
- `src/sidepanel/styles.css` — tab bar styles + `--siman-accent` CSS var

---

## Task 1: Types & Manifest Foundation

**Files:**
- Create: `src/shared/siman-types.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/manifest.config.ts`

- [ ] **Step 1: Create `src/shared/siman-types.ts`**

```typescript
// src/shared/siman-types.ts

export interface SimanRole {
  id_user_detail: number;
  id_role: number;
  nama_role: string;
  nama_unit: string;
  id_kpknl?: number;
  id_kanwil?: number;
}

export interface SimanRoleContext {
  idUserDetail: number;
  idRole: number;
  namaRole: string;
  namaUnit: string;
  idKpknl: number;
  idKanwil: number;
  idStrukturTermohon: number;
}

export interface SimanTokenState {
  token: string | null;
  capturedAt: number | null;
  userId: number | null;
  nip: string | null;
  fullname: string | null;
  jabatan: string | null;
  role: SimanRoleContext | null;
}

export interface SimanTemplate {
  id: string;
  name: string;
  idTipePengelolaan: number;
  namaTipe: string;
  konsepNd?: { name: string; base64: string };
  konsepNp?: { name: string; base64: string };
  mapping: Record<string, string>;       // "{no_tiket}" → "no_tiket"
  savedVariables: Record<string, string>; // manually filled, pre-filled on next run
  nadinePayload?: Record<string, unknown>;
  createdAt: string;
}

export interface SimanPenetapan {
  no_tiket: string;
  nama_tipe_pengelolaan: string;
  id_tipe_pengelolaan: number;
  pemohon: string;
  ur_satker: string;
  deskripsi: string;
  durasi_penetapan: string;
  id_pengelolaan?: number;
  [k: string]: unknown;
}

export interface SimanTipePengelolaan {
  id_tipe_pengelolaan: number;
  nama_tipe: string;
  [k: string]: unknown;
}

// --- SIMAN message types added to BgMessage ---
export type SimanBgMessage =
  | { type: "siman/token"; token: string; origin: string };

// --- SIMAN panel requests ---
export type SimanRequest =
  | { type: "siman/state" }
  | { type: "siman/token-clear" }
  | { type: "siman/get-roles" }
  | { type: "siman/set-role"; role: SimanRole; idKpknl: number; idKanwil: number; idStrukturTermohon: number }
  | { type: "siman/tipe-pengelolaan" }
  | { type: "siman/penetapan-list"; limit: number; offset: number; statusFilter?: string; idTipe?: number }
  | { type: "siman/template-list" }
  | { type: "siman/template-get"; id: string }
  | { type: "siman/template-save"; template: Omit<SimanTemplate, "id" | "createdAt"> }
  | { type: "siman/template-update"; id: string; updates: Partial<SimanTemplate> }
  | { type: "siman/template-delete"; id: string };

// --- siman-run port messages ---
export type SimanRunPortRequest = {
  type: "siman/run";
  noTiket: string;
  idPengelolaan: number;
  idTipePengelolaan: number;
  templateId: string;
};

export type SimanRunProgressMsg =
  | { type: "siman/run-step"; step: string; done: boolean }
  | { type: "siman/run-variables"; variables: Record<string, string>; missing: string[] }
  | { type: "siman/run-done"; ndId: number }
  | { type: "siman/run-error"; error: string };
```

- [ ] **Step 2: Add SIMAN types to `src/shared/types.ts`**

After line 232 (end of file), add:

```typescript
// --- SIMAN ---

import type { SimanTokenState } from "./siman-types";
export type { SimanTokenState };

export type { SimanRole, SimanRoleContext, SimanTemplate, SimanPenetapan,
  SimanTipePengelolaan, SimanBgMessage, SimanRequest,
  SimanRunPortRequest, SimanRunProgressMsg } from "./siman-types";
```

Also extend `PanelSnapshot` (around line 226) to add:

```typescript
export interface PanelSnapshot {
  token: TokenState;
  lastPage: PageContext | null;
  currentNdId: string | null;
  pendingPayload?: boolean;
  simanToken: SimanTokenState;    // ← add this
  activeTab: "nadine" | "siman"; // ← add this
}
```

- [ ] **Step 3: Update `src/manifest.config.ts`** — add SIMAN domains to content scripts and host_permissions

Replace the `content_scripts` array and `host_permissions` with:

```typescript
content_scripts: [
  {
    matches: [
      "https://satu.kemenkeu.go.id/*",
      "https://service.kemenkeu.go.id/*",
      "https://siman.kemenkeu.go.id/*",
    ],
    js: ["src/content/page-inject.ts"],
    run_at: "document_start",
    all_frames: false,
    world: "MAIN",
  },
  {
    matches: [
      "https://satu.kemenkeu.go.id/*",
      "https://service.kemenkeu.go.id/*",
      "https://siman.kemenkeu.go.id/*",
    ],
    js: ["src/content/index.ts"],
    run_at: "document_start",
    all_frames: false,
  },
],
permissions: ["storage", "sidePanel", "scripting", "activeTab", "tabs", "alarms"],
host_permissions: [
  "https://satu.kemenkeu.go.id/*",
  "https://service.kemenkeu.go.id/*",
  "https://satu-notif.kemenkeu.go.id/*",
  "https://satu-file.kemenkeu.go.id/*",
  "https://siman.kemenkeu.go.id/*",
  "https://siman-svc.kemenkeu.go.id/*",
  "http://localhost:8080/*",
  "http://127.0.0.1:8080/*",
],
```

- [ ] **Step 4: Type-check**

```bash
cd /Users/fahri/Automation/nadine/asguard-ext && npm run typecheck
```

Expected: no errors related to the new types (may have errors about `PanelSnapshot.simanToken` not yet provided — that's fine, fix in next task).

- [ ] **Step 5: Commit**

```bash
cd /Users/fahri/Automation/nadine/asguard-ext && rtk git add src/shared/siman-types.ts src/shared/types.ts src/manifest.config.ts && rtk git commit -m "feat(siman): add SIMAN types and manifest domains"
```

---

## Task 2: SIMAN Token Store & Content Script

**Files:**
- Create: `src/background/siman-store.ts`
- Modify: `src/content/page-inject.ts`
- Modify: `src/content/index.ts`
- Modify: `src/content/page-detector.ts`

- [ ] **Step 1: Create `src/background/siman-store.ts`**

```typescript
// src/background/siman-store.ts
import type { SimanTemplate, SimanTokenState, SimanRoleContext } from "@/shared/siman-types";

const TOKEN_KEY = "asguard.simanTokenState";
const TEMPLATES_KEY = "asguard.simanTemplates";

let simanTokenState: SimanTokenState = {
  token: null, capturedAt: null, userId: null, nip: null,
  fullname: null, jabatan: null, role: null,
};

export async function restoreSimanToken(): Promise<void> {
  const data = await chrome.storage.session.get(TOKEN_KEY);
  if (data[TOKEN_KEY]) simanTokenState = data[TOKEN_KEY] as SimanTokenState;
}

export async function setSimanToken(
  token: string,
  meta: { userId: number; nip: string; fullname: string; jabatan: string },
): Promise<boolean> {
  if (simanTokenState.token === token) return false;
  simanTokenState = { token, capturedAt: Date.now(), ...meta, role: simanTokenState.role };
  await chrome.storage.session.set({ [TOKEN_KEY]: simanTokenState });
  return true;
}

export async function setSimanRole(role: SimanRoleContext, newToken: string): Promise<void> {
  simanTokenState = { ...simanTokenState, token: newToken, role, capturedAt: Date.now() };
  await chrome.storage.session.set({ [TOKEN_KEY]: simanTokenState });
}

export async function clearSimanToken(): Promise<void> {
  simanTokenState = { token: null, capturedAt: null, userId: null, nip: null, fullname: null, jabatan: null, role: null };
  await chrome.storage.session.remove(TOKEN_KEY);
}

export function getSimanToken(): SimanTokenState {
  return simanTokenState;
}

// --- Template CRUD ---

async function loadTemplates(): Promise<SimanTemplate[]> {
  const data = await chrome.storage.local.get(TEMPLATES_KEY);
  return (data[TEMPLATES_KEY] as SimanTemplate[] | undefined) ?? [];
}

async function saveTemplates(templates: SimanTemplate[]): Promise<void> {
  await chrome.storage.local.set({ [TEMPLATES_KEY]: templates });
}

export async function getAllSimanTemplates(): Promise<SimanTemplate[]> {
  return loadTemplates();
}

export async function getSimanTemplateById(id: string): Promise<SimanTemplate | null> {
  const all = await loadTemplates();
  return all.find((t) => t.id === id) ?? null;
}

export async function saveSimanTemplate(
  partial: Omit<SimanTemplate, "id" | "createdAt">,
): Promise<SimanTemplate> {
  const template: SimanTemplate = {
    ...partial,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  const all = await loadTemplates();
  all.push(template);
  await saveTemplates(all);
  return template;
}

export async function updateSimanTemplate(
  id: string,
  updates: Partial<SimanTemplate>,
): Promise<SimanTemplate | null> {
  const all = await loadTemplates();
  const idx = all.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  all[idx] = { ...all[idx], ...updates, id };
  await saveTemplates(all);
  return all[idx];
}

export async function deleteSimanTemplate(id: string): Promise<boolean> {
  const all = await loadTemplates();
  const filtered = all.filter((t) => t.id !== id);
  if (filtered.length === all.length) return false;
  await saveTemplates(filtered);
  return true;
}
```

- [ ] **Step 2: Update `src/content/page-inject.ts`** — detect SIMAN domain and post `siman/token` message

At the top of the IIFE (after line 13), update `TARGET_HOSTS` and add SIMAN host:

```typescript
const TARGET_HOSTS = ["service.kemenkeu.go.id", "satu-notif.kemenkeu.go.id"];
const SIMAN_API_HOST = "siman-svc.kemenkeu.go.id";
```

Replace the `postToken` function and the token posting logic in the fetch intercept. After line 28, add:

```typescript
function isSimanUrl(u: string | URL): boolean {
  try {
    const url = typeof u === "string" ? new URL(u, location.href) : u;
    return url.hostname === SIMAN_API_HOST;
  } catch { return false; }
}

function postSimanToken(token: string, origin: string) {
  window.postMessage({ __asguard: true, kind: "simanToken", token, origin }, "*");
}
```

Then in the fetch intercept (around line 77), after the existing `if (isTarget)` block, add a parallel `else if` for SIMAN:

```typescript
} else if (isSimanUrl(url)) {
  try {
    let token: string | null = null;
    if (init?.headers) {
      const h = init.headers;
      if (h instanceof Headers) token = extractBearer(h.get("Authorization"));
      else if (Array.isArray(h)) {
        const pair = h.find(([k]) => k.toLowerCase() === "authorization");
        if (pair) token = extractBearer(pair[1]);
      } else {
        const rec = h as Record<string, string>;
        token = extractBearer(rec["Authorization"] ?? rec["authorization"]);
      }
    }
    if (!token && input instanceof Request) {
      token = extractBearer(input.headers.get("Authorization"));
    }
    if (token) postSimanToken(token, urlStr);
  } catch { /* never block real fetch */ }
}
```

Do the same in the XHR `setRequestHeader` intercept (around line 188), add an `else if` branch:

```typescript
} else if (name.toLowerCase() === "authorization" && this.__asguardUrl && isSimanUrl(this.__asguardUrl)) {
  const token = extractBearer(value);
  if (token) postSimanToken(token, this.__asguardUrl);
}
```

- [ ] **Step 3: Update `src/content/index.ts`** — forward `simanToken` postMessage to background

In the `window.addEventListener("message", ...)` handler (around line 35), after the existing `if (d.kind === "token" ...)` block add:

```typescript
} else if (d.kind === "simanToken" && d.token && d.origin) {
  send({ type: "siman/token", token: d.token, origin: d.origin });
}
```

Also update the `BgMessage` import — the `BgMessage` type now needs to include `SimanBgMessage`. Since `siman/token` is a new message type, the import in content script just uses the send function so no type changes needed in content/index.ts.

- [ ] **Step 4: Update `src/content/page-detector.ts`** — add SIMAN page detection

Replace the entire file:

```typescript
import type { PageKind } from "@/shared/types";

export function classifyUrl(urlStr: string): PageKind {
  let url: URL;
  try { url = new URL(urlStr); } catch { return { kind: "other" }; }

  // SIMAN web app
  if (url.hostname === "siman.kemenkeu.go.id") {
    return { kind: "siman" as "other" }; // cast until PageKind gets siman variant
  }

  if (url.hostname !== "satu.kemenkeu.go.id") return { kind: "other" };

  const path = url.pathname.replace(/\/+$/, "");
  const tab = url.searchParams.get("tab") ?? "";

  if (path === "/nadine/mejaku") {
    const known = ["amplop", "disposisi", "konsep"] as const;
    const norm = (known as readonly string[]).includes(tab)
      ? (tab as (typeof known)[number])
      : "unknown";
    return { kind: "inbox", tab: norm };
  }

  if (path.startsWith("/nadine/preview") || /\/nadine\/.*(detail|view|baca|preview)/.test(path)) {
    const ndIdQuery = url.searchParams.get("ndId") ?? url.searchParams.get("id");
    return { kind: "detail", ndId: ndIdQuery && /^\d+$/.test(ndIdQuery) ? ndIdQuery : "" };
  }

  const ndIdQuery = url.searchParams.get("ndId") ?? url.searchParams.get("id");
  if (ndIdQuery && /^\d+$/.test(ndIdQuery)) return { kind: "detail", ndId: ndIdQuery };

  if (/^\/nadine\/.*\/(buat|baru|new|create)/.test(path)) return { kind: "create" };
  if (path === "/beranda" || path === "") return { kind: "beranda" };

  return { kind: "other" };
}

export function isSimanPage(urlStr: string): boolean {
  try { return new URL(urlStr).hostname === "siman.kemenkeu.go.id"; }
  catch { return false; }
}
```

Also update `PageKind` in `src/shared/types.ts` line 1–6 to add the siman kind:

```typescript
export type PageKind =
  | { kind: "inbox"; tab: "amplop" | "disposisi" | "konsep" | "unknown" }
  | { kind: "detail"; ndId: string }
  | { kind: "create" }
  | { kind: "beranda" }
  | { kind: "siman" }
  | { kind: "other" };
```

- [ ] **Step 5: Type-check**

```bash
cd /Users/fahri/Automation/nadine/asguard-ext && npm run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/fahri/Automation/nadine/asguard-ext && rtk git add src/background/siman-store.ts src/content/page-inject.ts src/content/index.ts src/content/page-detector.ts src/shared/types.ts && rtk git commit -m "feat(siman): token store + content script intercept for siman domain"
```

---

## Task 3: SIMAN HTTP Client

**Files:**
- Create: `src/background/siman-client.ts`
- Create: `src/background/terbilang.ts`

- [ ] **Step 1: Create `src/background/terbilang.ts`** — Indonesian number-to-words

```typescript
// src/background/terbilang.ts

const SATUAN = ["", "satu", "dua", "tiga", "empat", "lima", "enam", "tujuh", "delapan", "sembilan",
  "sepuluh", "sebelas", "dua belas", "tiga belas", "empat belas", "lima belas", "enam belas",
  "tujuh belas", "delapan belas", "sembilan belas"];
const PULUHAN = ["", "", "dua puluh", "tiga puluh", "empat puluh", "lima puluh",
  "enam puluh", "tujuh puluh", "delapan puluh", "sembilan puluh"];

function terbilangRatusan(n: number): string {
  if (n === 0) return "";
  if (n < 20) return SATUAN[n];
  if (n < 100) {
    const r = n % 10;
    return PULUHAN[Math.floor(n / 10)] + (r ? " " + SATUAN[r] : "");
  }
  const r = n % 100;
  const ratus = Math.floor(n / 100);
  const prefix = ratus === 1 ? "seratus" : SATUAN[ratus] + " ratus";
  return prefix + (r ? " " + terbilangRatusan(r) : "");
}

export function terbilang(amount: number): string {
  if (amount === 0) return "nol";
  const parts: string[] = [];
  const units = [
    { value: 1_000_000_000_000, name: "triliun" },
    { value: 1_000_000_000, name: "miliar" },
    { value: 1_000_000, name: "juta" },
    { value: 1_000, name: "ribu" },
    { value: 1, name: "" },
  ];
  let remaining = Math.floor(Math.abs(amount));
  for (const { value, name } of units) {
    const chunk = Math.floor(remaining / value);
    if (chunk > 0) {
      const words = chunk === 1 && value === 1000
        ? "seribu"
        : terbilangRatusan(chunk) + (name ? " " + name : "");
      parts.push(words.trim());
      remaining -= chunk * value;
    }
  }
  return parts.join(" ").trim();
}

export function terbilangRupiah(amount: number): string {
  return terbilang(amount) + " rupiah";
}
```

- [ ] **Step 2: Verify terbilang manually** — open browser console or node and check:

```
terbilang(2500000000) // → "dua miliar lima ratus juta"
terbilang(1000)       // → "seribu"
terbilang(150000)     // → "seratus lima puluh ribu"
```

- [ ] **Step 3: Create `src/background/siman-client.ts`**

```typescript
// src/background/siman-client.ts
import type { SimanRole, SimanRoleContext, SimanPenetapan, SimanTipePengelolaan } from "@/shared/siman-types";
import { getSimanToken } from "./siman-store";
import { terbilangRupiah } from "./terbilang";

const SIMAN_BASE = "https://siman-svc.kemenkeu.go.id";

export class SimanHttpError extends Error {
  constructor(public status: number, public path: string, public body: string) {
    super(`SIMAN ${status} ${path}`);
    this.name = "SimanHttpError";
  }
}

export class SimanNoTokenError extends Error {
  constructor() {
    super("Token SIMAN belum tertangkap. Buka/refresh siman.kemenkeu.go.id.");
    this.name = "SimanNoTokenError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { token } = getSimanToken();
  if (!token) throw new SimanNoTokenError();
  const url = `${SIMAN_BASE}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...init?.headers,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new SimanHttpError(res.status, path, body);
  }
  return (await res.json()) as T;
}

/** Decode user info from JWT payload (base64url middle segment) */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const part = token.split(".")[1];
    const padded = part + "=".repeat((4 - (part.length % 4)) % 4);
    return JSON.parse(atob(padded.replace(/-/g, "+").replace(/_/g, "/")));
  } catch { return {}; }
}

export async function getRoles(userId: number): Promise<SimanRole[]> {
  const res = await request<{ data?: unknown[] }>(
    `/smaset/api/get-list-role-active-new/${userId}/0/0`,
    { method: "POST", body: JSON.stringify({}) },
  );
  return (res.data ?? []) as SimanRole[];
}

export async function getRoleFilter(idUserDetail: number): Promise<Record<string, unknown>> {
  return request(`/smaset/api/user-detail-filter/${idUserDetail}`, {
    method: "POST", body: JSON.stringify({}),
  });
}

export async function setRole(
  role: SimanRole,
  filterData: Record<string, unknown>,
  userlogin: string,
): Promise<{ token: string; context: SimanRoleContext }> {
  const payload = { role, filterData, userlogin };
  const res = await request<{ token?: string; data?: Record<string, unknown> }>(
    "/swkf/auth/v1/jwt-roles",
    { method: "POST", body: JSON.stringify(payload) },
  );
  const newToken = res.token ?? (res.data as Record<string, string>)?.token ?? "";
  // Extract role context from filter data
  const context: SimanRoleContext = {
    idUserDetail: role.id_user_detail,
    idRole: role.id_role,
    namaRole: role.nama_role,
    namaUnit: role.nama_unit,
    idKpknl: (filterData.id_kpknl as number) ?? 0,
    idKanwil: (filterData.id_kanwil as number) ?? 0,
    idStrukturTermohon: (filterData.id_struktur_termohon as number) ?? 0,
  };
  return { token: newToken, context };
}

export async function getTipePengelolaan(): Promise<SimanTipePengelolaan[]> {
  const res = await request<{ data?: unknown[] }>(
    "/skel/api/referensi-pengelolaan/tipe-pengelolaan/get-all",
  );
  return (res.data ?? []) as SimanTipePengelolaan[];
}

export async function getPenetapanList(
  role: SimanRoleContext,
  limit: number,
  offset: number,
  statusFilter?: string,
  idTipe?: number,
): Promise<{ data: SimanPenetapan[]; total: number }> {
  const body: Record<string, unknown> = {
    id_kpknl: role.idKpknl,
    id_kanwil: role.idKanwil,
    limit,
    offset,
  };
  if (statusFilter) body.status = statusFilter;
  if (idTipe) body.id_tipe_pengelolaan = idTipe;
  const res = await request<{ data?: unknown[]; total?: number }>(
    `/skel/api/pengelolaan/penetapan-pengelolaan/get-data/${limit}/${offset}`,
    { method: "POST", body: JSON.stringify(body) },
  );
  return { data: (res.data ?? []) as SimanPenetapan[], total: res.total ?? 0 };
}

export async function getPermohonanDetail(noTiket: string): Promise<Record<string, unknown>> {
  const res = await request<{ data?: unknown }>(
    "/skel/api/pengelolaan/permohonan-pengelolaan-detail/by-no-tiket",
    { method: "POST", body: JSON.stringify({ no_tiket: noTiket }) },
  );
  return (res.data ?? {}) as Record<string, unknown>;
}

export async function getDaftarAset(
  role: SimanRoleContext,
  idPengelolaan: number,
  idTipe: number,
  limit = 100,
): Promise<{ data: Record<string, unknown>[]; total: number }> {
  const res = await request<{ data?: unknown[]; total?: number }>(
    `/skel/api/pengelolaan/permohonan-pengelolaan-detail/get-aset-by-no-tiket/${limit}/0`,
    { method: "POST", body: JSON.stringify({ id_pengelolaan: idPengelolaan, id_tipe_pengelolaan: idTipe, id_kpknl: role.idKpknl }) },
  );
  return { data: (res.data ?? []) as Record<string, unknown>[], total: res.total ?? 0 };
}

export async function getSkByTiket(
  idPengelolaan: number,
  limit = 10,
): Promise<Record<string, unknown>[]> {
  const res = await request<{ data?: unknown[] }>(
    `/skel/api/pengelolaan/surat-keputusan/get-sk-by-no-tiket/${idPengelolaan}/${limit}/0`,
    { method: "POST", body: JSON.stringify({}) },
  );
  return (res.data ?? []) as Record<string, unknown>[];
}

export async function getKelengkapanDokumen(
  idPengelolaan: number,
  limit = 20,
): Promise<Record<string, unknown>[]> {
  const res = await request<{ data?: unknown[] }>(
    `/skel/api/pengelolaan/kelengkapan-dokumen-per-tiket/${idPengelolaan}/${limit}/0`,
    { method: "POST", body: JSON.stringify({}) },
  );
  return (res.data ?? []) as Record<string, unknown>[];
}

/** Build the full variable map for a penetapan (mirrors PengelolaanService.get_all_mapping_variables) */
export async function buildVariableMap(
  role: SimanRoleContext,
  noTiket: string,
  idPengelolaan: number,
  idTipePengelolaan: number,
): Promise<Record<string, string>> {
  const [detail, asetResult, skList, dokList] = await Promise.all([
    getPermohonanDetail(noTiket),
    getDaftarAset(role, idPengelolaan, idTipePengelolaan),
    getSkByTiket(idPengelolaan),
    getKelengkapanDokumen(idPengelolaan),
  ]);

  const vars: Record<string, string> = {};

  // From permohonan detail
  for (const key of ["no_tiket","kd_satker","ur_satker","nm_jns_bmn","pemohon","ur_kl",
    "nama_tipe_pengelolaan","nama_jenis_pengelolaan","termohon","deskripsi","durasi_penetapan"]) {
    vars[key] = String(detail[key] ?? "");
  }

  // From aset aggregation
  const aset = asetResult.data;
  vars.jumlah_aset = String(aset.length);
  const sumPermohonan = aset.reduce((s, a) => s + (Number(a.nilai_permohonan) || 0), 0);
  const sumBuku = aset.reduce((s, a) => s + (Number(a.nilai_buku) || 0), 0);
  const sumPerolehan = aset.reduce((s, a) => s + (Number(a.nilai_perolehan) || 0), 0);
  const sumPersetujuan = aset.reduce((s, a) => s + (Number(a.nilai_persetujuan) || 0), 0);
  const sumProporsional = aset.reduce((s, a) => s + (Number(a.nilai_perolehan_proporsional) || 0), 0);
  const sumSewa = aset.reduce((s, a) => s +
    (Number(a.nilai_sewa_setuju_tahun) || 0) +
    (Number(a.nilai_sewa_setuju_bulan) || 0) * 12, 0);
  vars.sum_total_permohonan = String(sumPermohonan);
  vars.sum_total_buku = String(sumBuku);
  vars.sum_total_perolehan = String(sumPerolehan);
  vars.sum_nilai_persetujuan = String(sumPersetujuan);
  vars.sum_nilai_perolehan_proporsional = String(sumProporsional);
  vars.nilai_persetujuan_sewa = String(sumSewa);
  vars.pembilang_total_permohonan = terbilangRupiah(sumPermohonan);
  vars.pembilang_total_buku = terbilangRupiah(sumBuku);
  vars.pembilang_total_perolehan = terbilangRupiah(sumPerolehan);
  vars.pembilang_nilai_persetujuan = terbilangRupiah(sumPersetujuan);
  vars.pembilang_nilai_perolehan_proporsional = terbilangRupiah(sumProporsional);
  vars.pembilang_nilai_sewa = terbilangRupiah(sumSewa);

  // From SK (first SK)
  if (skList.length > 0) {
    const sk = skList[0];
    for (const key of ["no_surat","tgl_surat","id_nadine","perihal_sk","nama_penandatangan_sk","jabatan_penandatangan_sk"]) {
      vars[key] = String(sk[key] ?? "");
    }
  }

  // From dokumen BA
  const ba = dokList.find((d) => String(d.nm_dok ?? "").toLowerCase().includes("berita acara"));
  if (ba) {
    vars.nm_dok_ba = String(ba.nm_dok ?? "");
    vars.no_dok_ba = String(ba.no_dok ?? "");
    vars.tgl_dokumen_ba = String(ba.tgl_dokumen ?? "");
  }

  return vars;
}
```

- [ ] **Step 4: Type-check**

```bash
cd /Users/fahri/Automation/nadine/asguard-ext && npm run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/fahri/Automation/nadine/asguard-ext && rtk git add src/background/siman-client.ts src/background/terbilang.ts && rtk git commit -m "feat(siman): HTTP client + terbilang utility"
```

---

## Task 4: Background Message Router

**Files:**
- Modify: `src/background/index.ts`

- [ ] **Step 1: Add imports to `src/background/index.ts`**

After the existing imports (around line 27), add:

```typescript
import * as simanStore from "./siman-store";
import * as simanClient from "./siman-client";
import { SimanHttpError, SimanNoTokenError } from "./siman-client";
import type { SimanRequest, SimanRunPortRequest, SimanRunProgressMsg } from "@/shared/siman-types";
```

- [ ] **Step 2: Update `snapshot()` function** (around line 104) to include SIMAN state

```typescript
function snapshot(): PanelSnapshot {
  return {
    token: store.getToken(),
    lastPage: store.getPage(),
    currentNdId: store.getCurrentNdId(),
    pendingPayload: !!pendingPayload,
    simanToken: simanStore.getSimanToken(),
    activeTab: resolveActiveTab(),
  };
}
```

Add `resolveActiveTab()` helper before `snapshot()`:

```typescript
let _activeTab: "nadine" | "siman" = "nadine";

function resolveActiveTab(): "nadine" | "siman" {
  return _activeTab;
}
```

- [ ] **Step 3: Add SIMAN token restore to boot sequence** (around line 93)

```typescript
void (async () => {
  await store.restore();
  await simanStore.restoreSimanToken();  // ← add this line
  await loadSettings();
  setupKeepalive();
})();
```

- [ ] **Step 4: Add `siman/token` handler to the message listener**

In `chrome.runtime.onMessage.addListener` (around line 127), after the `token/capture` handler, add:

```typescript
if (raw.type === "siman/token") {
  // Decode JWT to get user info
  const payload = simanClient.decodeJwtPayload(raw.token);
  const changed = await simanStore.setSimanToken(raw.token, {
    userId: Number(payload.user_id ?? payload.sub ?? 0),
    nip: String(payload.nip ?? ""),
    fullname: String(payload.fullname ?? payload.name ?? ""),
    jabatan: String(payload.jabatan ?? ""),
  });
  if (changed) {
    console.log("[asguard] SIMAN token captured from", new URL(raw.origin).hostname);
    _activeTab = "siman";
    broadcastState();
  }
  sendResponse({ ok: true });
  return;
}
```

Also handle `page/changed` for SIMAN auto-tab switch — in the `page/changed` handler (around line 136), after `broadcastState()`, add:

```typescript
if (raw.type === "page/changed") {
  await store.setPage(raw.ctx);
  // Auto-switch tab based on page
  if (raw.ctx.page.kind === "siman") _activeTab = "siman";
  else if (raw.ctx.page.kind !== "other") _activeTab = "nadine";
  broadcastState();
  sendResponse({ ok: true });
  return;
}
```

- [ ] **Step 5: Add SIMAN panel request handlers**

After the existing `template/delete` handler, add the SIMAN handlers:

```typescript
// --- SIMAN panel requests ---
if (raw.type === "siman/state") {
  sendResponse(snapshot());
  return;
}
if (raw.type === "siman/token-clear") {
  await simanStore.clearSimanToken();
  sendResponse(snapshot());
  return;
}
if (raw.type === "siman/get-roles") {
  const { userId } = simanStore.getSimanToken();
  if (!userId) { sendResponse({ ok: false, error: "No SIMAN token" }); return; }
  try {
    const roles = await simanClient.getRoles(userId);
    sendResponse({ ok: true, data: roles });
  } catch (e) {
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
  return;
}
if (raw.type === "siman/set-role") {
  const { fullname } = simanStore.getSimanToken();
  try {
    const filterData = await simanClient.getRoleFilter(raw.role.id_user_detail);
    const { token, context } = await simanClient.setRole(raw.role, filterData, fullname ?? "");
    await simanStore.setSimanRole(context, token);
    sendResponse(snapshot());
  } catch (e) {
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
  return;
}
if (raw.type === "siman/tipe-pengelolaan") {
  try {
    const data = await simanClient.getTipePengelolaan();
    sendResponse({ ok: true, data });
  } catch (e) {
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
  return;
}
if (raw.type === "siman/penetapan-list") {
  const { role } = simanStore.getSimanToken();
  if (!role) { sendResponse({ ok: false, error: "No SIMAN role selected" }); return; }
  try {
    const data = await simanClient.getPenetapanList(role, raw.limit, raw.offset, raw.statusFilter, raw.idTipe);
    sendResponse({ ok: true, data });
  } catch (e) {
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
  return;
}
// Template CRUD
if (raw.type === "siman/template-list") {
  sendResponse({ ok: true, data: await simanStore.getAllSimanTemplates() });
  return;
}
if (raw.type === "siman/template-get") {
  sendResponse({ ok: true, data: await simanStore.getSimanTemplateById(raw.id) });
  return;
}
if (raw.type === "siman/template-save") {
  sendResponse({ ok: true, data: await simanStore.saveSimanTemplate(raw.template) });
  return;
}
if (raw.type === "siman/template-update") {
  sendResponse({ ok: true, data: await simanStore.updateSimanTemplate(raw.id, raw.updates) });
  return;
}
if (raw.type === "siman/template-delete") {
  sendResponse({ ok: true, data: await simanStore.deleteSimanTemplate(raw.id) });
  return;
}
```

- [ ] **Step 6: Add `siman-run` port handler**

In the port connect handler section, after the existing `arsip-run` port handler, add:

```typescript
if (port.name === "siman-run") {
  port.onMessage.addListener(async (msg: SimanRunPortRequest) => {
    if (msg.type !== "siman/run") return;

    function send(m: SimanRunProgressMsg) { port.postMessage(m); }

    const { role } = simanStore.getSimanToken();
    if (!role) { send({ type: "siman/run-error", error: "No SIMAN role selected" }); return; }

    const template = await simanStore.getSimanTemplateById(msg.templateId);
    if (!template) { send({ type: "siman/run-error", error: "Template tidak ditemukan" }); return; }

    try {
      send({ type: "siman/run-step", step: "Mengambil data permohonan…", done: false });
      const variables = await simanClient.buildVariableMap(
        role, msg.noTiket, msg.idPengelolaan, msg.idTipePengelolaan,
      );
      // Merge saved variables from template (but don't override API values with empty strings)
      const merged: Record<string, string> = { ...variables };
      for (const [k, v] of Object.entries(template.savedVariables)) {
        if (v) merged[k] = v;
      }
      // Find which placeholder keys have no value
      const missing = Object.values(template.mapping)
        .filter((key) => !merged[key] || merged[key] === "");
      send({ type: "siman/run-variables", variables: merged, missing });
      // Panel will fill missing vars and call siman/run-render (handled below)
    } catch (e) {
      send({ type: "siman/run-error", error: e instanceof Error ? e.message : String(e) });
    }
  });
  return;
}
```

Note: The render + Nadine creation step is triggered from the panel after the user fills missing vars. Add a second message handler on the same port for the render step:

```typescript
// Inside the siman-run port onMessage listener, add another type check:
if (msg.type === "siman/run-render") {
  // msg: { type, templateId, variables, noTiket }
  // Panel has already rendered the DOCX and sends back base64 files
  // Background creates the Nadine naskah
  // This is handled in Task 7 (SimanRunView integration)
}
```

- [ ] **Step 7: Type-check**

```bash
cd /Users/fahri/Automation/nadine/asguard-ext && npm run typecheck
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
cd /Users/fahri/Automation/nadine/asguard-ext && rtk git add src/background/index.ts && rtk git commit -m "feat(siman): background message router + siman-run port"
```

---

## Task 5: Tab Switcher + SIMAN Home View

**Files:**
- Modify: `src/sidepanel/App.tsx`
- Modify: `src/sidepanel/styles.css`
- Create: `src/sidepanel/views/SimanHomeView.tsx`

- [ ] **Step 1: Add tab bar styles to `src/sidepanel/styles.css`**

Append to the end of the file:

```css
/* ---- Tab Switcher ---- */
:root {
  --siman-accent: #2a5a8a;
  --siman-accent-hover: #1e4a78;
}

.tab-bar {
  display: flex;
  border-bottom: 2px solid var(--line);
  background: var(--surface);
  flex-shrink: 0;
}

.tab-bar__tab {
  flex: 1;
  padding: var(--sp-2) var(--sp-3);
  font-size: 12px;
  font-weight: 600;
  text-align: center;
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -2px;
  transition: color 0.15s, border-color 0.15s;
}

.tab-bar__tab--active-nadine {
  color: var(--color-primary);
  border-bottom-color: var(--color-primary);
}

.tab-bar__tab--active-siman {
  color: var(--siman-accent);
  border-bottom-color: var(--siman-accent);
}

/* ---- User info strip ---- */
.user-strip {
  padding: var(--sp-2) var(--sp-3);
  background: var(--surface-2);
  border-bottom: 1px solid var(--line);
  font-size: 12px;
}

.user-strip__name {
  font-weight: 600;
  color: var(--text-primary);
}

.user-strip__role {
  color: var(--muted);
  font-size: 11px;
  margin-top: 1px;
}

/* ---- Role badge ---- */
.role-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  padding: 3px var(--sp-2);
  background: color-mix(in srgb, var(--siman-accent) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--siman-accent) 30%, transparent);
  border-radius: var(--radius-sm);
  color: var(--siman-accent);
  font-size: 11px;
  font-weight: 600;
  margin-top: var(--sp-1);
}
```

- [ ] **Step 2: Create `src/sidepanel/views/SimanHomeView.tsx`**

```tsx
// src/sidepanel/views/SimanHomeView.tsx
import type { PanelSnapshot } from "@/shared/types";

interface Props {
  snap: PanelSnapshot;
  onGoTemplates: () => void;
  onGoDaftar: () => void;
  onGantiRole: () => void;
}

export function SimanHomeView({ snap, onGoTemplates, onGoDaftar, onGantiRole }: Props) {
  const { simanToken } = snap;
  const hasToken = !!simanToken.token;
  const hasRole = !!simanToken.role;

  if (!hasToken) {
    return (
      <section class="card card--warn fade-in">
        <div class="row">
          <span class="row__label">Sesi SIMAN</span>
          <span class="row__value"><span class="dot dot--warn" /> menunggu</span>
        </div>
        <p class="hint">
          Buka/refresh <code>siman.kemenkeu.go.id</code> — token tertangkap otomatis.
        </p>
      </section>
    );
  }

  if (!hasRole) {
    return <RolePicker snap={snap} />;
  }

  return (
    <div>
      <div class="user-strip">
        <div class="user-strip__name">{simanToken.fullname}</div>
        <div class="user-strip__role">{simanToken.jabatan}</div>
        <div class="role-badge">🏛 {simanToken.role!.namaRole} · {simanToken.role!.namaUnit}</div>
      </div>
      <div class="action-cards" style="padding: 12px">
        <button class="action-card" onClick={onGoTemplates}>
          <div class="action-card__icon">📋</div>
          <div class="action-card__body">
            <div class="action-card__label">Template Pengelolaan</div>
            <div class="action-card__desc">Kelola template dokumen pengelolaan BMN</div>
          </div>
          <span class="action-card__arrow">›</span>
        </button>
        <button class="action-card" onClick={onGoDaftar}>
          <div class="action-card__icon">📜</div>
          <div class="action-card__body">
            <div class="action-card__label">Daftar Pengelolaan</div>
            <div class="action-card__desc">Lihat penetapan &amp; buat naskah otomatis</div>
          </div>
          <span class="action-card__arrow">›</span>
        </button>
      </div>
      <div style="padding: 0 12px">
        <button class="btn btn--ghost" style="width:100%;font-size:12px" onClick={onGantiRole}>
          Ganti Role
        </button>
      </div>
    </div>
  );
}

function RolePicker({ snap }: { snap: PanelSnapshot }) {
  // Role selection is handled inline when no role is set
  // This component just shows a prompt — actual role fetching is done in SimanHomeView parent
  return (
    <section class="card fade-in" style="margin:12px">
      <p class="hint">Token SIMAN berhasil ditangkap. Pilih role untuk melanjutkan.</p>
      <RolePickerInner snap={snap} />
    </section>
  );
}

function RolePickerInner({ snap }: { snap: PanelSnapshot }) {
  const { useState, useEffect } = await import("preact/hooks");
  // This is a workaround — use a proper component below
  return null;
}
```

Wait — the `RolePickerInner` above uses a dynamic import inside a component which is wrong. Rewrite `SimanHomeView.tsx` properly:

```tsx
// src/sidepanel/views/SimanHomeView.tsx
import { useState, useEffect } from "preact/hooks";
import type { PanelSnapshot, SimanRole } from "@/shared/types";

function send<T>(msg: unknown): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

interface Props {
  snap: PanelSnapshot;
  onGoTemplates: () => void;
  onGoDaftar: () => void;
  onGantiRole: () => void;
}

export function SimanHomeView({ snap, onGoTemplates, onGoDaftar, onGantiRole }: Props) {
  const { simanToken } = snap;
  const hasToken = !!simanToken.token;
  const hasRole = !!simanToken.role;

  if (!hasToken) {
    return (
      <section class="card card--warn fade-in">
        <div class="row">
          <span class="row__label">Sesi SIMAN</span>
          <span class="row__value"><span class="dot dot--warn" /> menunggu</span>
        </div>
        <p class="hint">
          Buka/refresh <code>siman.kemenkeu.go.id</code> — token tertangkap otomatis.
        </p>
      </section>
    );
  }

  if (!hasRole) {
    return <RolePicker />;
  }

  return (
    <div>
      <div class="user-strip">
        <div class="user-strip__name">{simanToken.fullname}</div>
        <div class="user-strip__role">{simanToken.jabatan}</div>
        <div class="role-badge">🏛 {simanToken.role!.namaRole} · {simanToken.role!.namaUnit}</div>
      </div>
      <div class="action-cards" style="padding: 12px">
        <button class="action-card" onClick={onGoTemplates}>
          <div class="action-card__icon">📋</div>
          <div class="action-card__body">
            <div class="action-card__label">Template Pengelolaan</div>
            <div class="action-card__desc">Kelola template dokumen pengelolaan BMN</div>
          </div>
          <span class="action-card__arrow">›</span>
        </button>
        <button class="action-card" onClick={onGoDaftar}>
          <div class="action-card__icon">📜</div>
          <div class="action-card__body">
            <div class="action-card__label">Daftar Pengelolaan</div>
            <div class="action-card__desc">Lihat penetapan &amp; buat naskah otomatis</div>
          </div>
          <span class="action-card__arrow">›</span>
        </button>
      </div>
      <div style="padding: 0 12px 12px">
        <button class="btn btn--ghost" style="width:100%;font-size:12px" onClick={onGantiRole}>
          Ganti Role
        </button>
      </div>
    </div>
  );
}

function RolePicker() {
  const [roles, setRoles] = useState<SimanRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    send<{ ok: boolean; data?: SimanRole[]; error?: string }>({ type: "siman/get-roles" })
      .then((r) => { if (r.ok) setRoles(r.data ?? []); else setError(r.error ?? "Error"); })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  async function pickRole(role: SimanRole) {
    setLoading(true);
    // Background will call getRoleFilter + setRole and return updated snapshot
    await send({ type: "siman/set-role", role, idKpknl: 0, idKanwil: 0, idStrukturTermohon: 0 });
    setLoading(false);
  }

  if (loading) return <p class="hint" style="padding:12px">Memuat daftar role…</p>;
  if (error) return <p class="hint" style="padding:12px;color:var(--error)">{error}</p>;

  return (
    <section class="card fade-in" style="margin:12px">
      <p class="hint" style="margin-bottom:8px">Pilih role SIMAN:</p>
      {roles.map((r) => (
        <button key={r.id_user_detail} class="btn btn--ghost" style="width:100%;margin-bottom:6px;text-align:left" onClick={() => pickRole(r)}>
          <strong>{r.nama_role}</strong><br />
          <small style="color:var(--muted)">{r.nama_unit}</small>
        </button>
      ))}
    </section>
  );
}
```

- [ ] **Step 3: Update `src/sidepanel/App.tsx`** — add tab switcher and SIMAN routing

Replace the `ActiveView` type and the App component:

```tsx
// At the top, add new imports:
import { SimanHomeView } from "./views/SimanHomeView";
import { SimanTemplateListView } from "./views/SimanTemplateListView";
import { SimanTemplateDetailView } from "./views/SimanTemplateDetailView";
import { SimanDaftarView } from "./views/SimanDaftarView";
import { SimanRunView } from "./views/SimanRunView";

// Replace types:
type ActiveView = "home" | "summary" | "template" | "settings" | "arsiparis";
type SimanView =
  | { kind: "home" }
  | { kind: "template-list" }
  | { kind: "template-detail"; templateId: string }
  | { kind: "daftar" }
  | { kind: "run"; noTiket: string; idPengelolaan: number; idTipePengelolaan: number; templateId: string };
```

In the `App` function, add new state and tab logic after existing state:

```tsx
const [activeTab, setActiveTab] = useState<"nadine" | "siman">("nadine");
const [simanView, setSimanView] = useState<SimanView>({ kind: "home" });
```

Update the `useEffect` to sync `activeTab` from snapshot:

```tsx
useEffect(() => {
  send<PanelSnapshot>({ type: "state/get" }).then((s) => {
    setSnap(s);
    setActiveTab(s.activeTab ?? "nadine");
  }).catch(console.error);

  const onMsg = (msg: { type?: string; snapshot?: PanelSnapshot }) => {
    if (msg?.type === "state/changed" && msg.snapshot) {
      setSnap(msg.snapshot);
      setActiveTab(msg.snapshot.activeTab ?? "nadine");
      if (msg.snapshot.pendingPayload) setView("home");
    }
  };
  chrome.runtime.onMessage.addListener(onMsg);
  return () => chrome.runtime.onMessage.removeListener(onMsg);
}, []);
```

Before the routing `if` blocks, add the SIMAN tab rendering:

```tsx
// Tab bar (always shown)
const tabBar = (
  <div class="tab-bar">
    <button
      class={`tab-bar__tab${activeTab === "nadine" ? " tab-bar__tab--active-nadine" : ""}`}
      onClick={() => setActiveTab("nadine")}
    >📄 Nadine</button>
    <button
      class={`tab-bar__tab${activeTab === "siman" ? " tab-bar__tab--active-siman" : ""}`}
      onClick={() => setActiveTab("siman")}
    >🏛 SIMAN</button>
  </div>
);

// SIMAN tab routing
if (activeTab === "siman") {
  if (simanView.kind === "template-list") {
    return (
      <div class="panel">
        {tabBar}
        <BackHeader title="Template Pengelolaan" onBack={() => setSimanView({ kind: "home" })} />
        <main class="panel__main">
          <SimanTemplateListView
            snap={snap!}
            onEdit={(id) => setSimanView({ kind: "template-detail", templateId: id })}
            onBack={() => setSimanView({ kind: "home" })}
          />
        </main>
      </div>
    );
  }
  if (simanView.kind === "template-detail") {
    return (
      <div class="panel">
        {tabBar}
        <BackHeader title="Detail Template" onBack={() => setSimanView({ kind: "template-list" })} />
        <main class="panel__main">
          <SimanTemplateDetailView
            templateId={simanView.templateId}
            onBack={() => setSimanView({ kind: "template-list" })}
          />
        </main>
      </div>
    );
  }
  if (simanView.kind === "daftar") {
    return (
      <div class="panel">
        {tabBar}
        <BackHeader title="Daftar Pengelolaan" onBack={() => setSimanView({ kind: "home" })} />
        <main class="panel__main">
          <SimanDaftarView
            snap={snap!}
            onRun={(noTiket, idPengelolaan, idTipePengelolaan, templateId) =>
              setSimanView({ kind: "run", noTiket, idPengelolaan, idTipePengelolaan, templateId })}
            onBack={() => setSimanView({ kind: "home" })}
          />
        </main>
      </div>
    );
  }
  if (simanView.kind === "run") {
    return (
      <div class="panel">
        {tabBar}
        <BackHeader title="Buat Naskah" onBack={() => setSimanView({ kind: "daftar" })} />
        <main class="panel__main">
          <SimanRunView
            noTiket={simanView.noTiket}
            idPengelolaan={simanView.idPengelolaan}
            idTipePengelolaan={simanView.idTipePengelolaan}
            templateId={simanView.templateId}
            onDone={() => setSimanView({ kind: "daftar" })}
            onBack={() => setSimanView({ kind: "daftar" })}
          />
        </main>
      </div>
    );
  }
  // SIMAN home
  return (
    <div class="panel">
      {tabBar}
      <main class="panel__main">
        <SimanHomeView
          snap={snap ?? { token: { token: null, capturedAt: null, origin: null }, lastPage: null, currentNdId: null, simanToken: { token: null, capturedAt: null, userId: null, nip: null, fullname: null, jabatan: null, role: null }, activeTab: "siman" }}
          onGoTemplates={() => setSimanView({ kind: "template-list" })}
          onGoDaftar={() => setSimanView({ kind: "daftar" })}
          onGantiRole={() => {/* clear role and re-show picker — send siman/token-clear not needed, just clear role */
            send({ type: "siman/token-clear" });
          }}
        />
      </main>
      <footer class="panel__footer">Asguard · v0.2.0</footer>
    </div>
  );
}
```

Also wrap the existing Nadine home panel header area with the tab bar — add `{tabBar}` after the opening `<div class="panel">` in the home view return.

- [ ] **Step 4: Create placeholder stub files for views not yet implemented** (so typecheck passes):

`src/sidepanel/views/SimanTemplateListView.tsx`:
```tsx
import type { PanelSnapshot } from "@/shared/types";
export function SimanTemplateListView(_: { snap: PanelSnapshot; onEdit: (id: string) => void; onBack: () => void }) {
  return <div class="hint" style="padding:12px">Template list — coming in next task</div>;
}
```

`src/sidepanel/views/SimanTemplateDetailView.tsx`:
```tsx
export function SimanTemplateDetailView(_: { templateId: string; onBack: () => void }) {
  return <div class="hint" style="padding:12px">Template detail — coming in next task</div>;
}
```

`src/sidepanel/views/SimanDaftarView.tsx`:
```tsx
import type { PanelSnapshot } from "@/shared/types";
export function SimanDaftarView(_: { snap: PanelSnapshot; onRun: (noTiket: string, idPengelolaan: number, idTipePengelolaan: number, templateId: string) => void; onBack: () => void }) {
  return <div class="hint" style="padding:12px">Daftar Pengelolaan — coming in next task</div>;
}
```

`src/sidepanel/views/SimanRunView.tsx`:
```tsx
export function SimanRunView(_: { noTiket: string; idPengelolaan: number; idTipePengelolaan: number; templateId: string; onDone: () => void; onBack: () => void }) {
  return <div class="hint" style="padding:12px">Run view — coming in next task</div>;
}
```

- [ ] **Step 5: Build to verify**

```bash
cd /Users/fahri/Automation/nadine/asguard-ext && npm run build 2>&1 | tail -20
```

Expected: successful build with `dist/` output.

- [ ] **Step 6: Load extension and verify tab bar appears**

Load unpacked from `dist/` in `chrome://extensions`. Open the side panel. Verify two tabs appear at top: "📄 Nadine" and "🏛 SIMAN". Clicking SIMAN tab shows the token warning if not logged in to SIMAN.

- [ ] **Step 7: Commit**

```bash
cd /Users/fahri/Automation/nadine/asguard-ext && rtk git add src/sidepanel/App.tsx src/sidepanel/styles.css src/sidepanel/views/SimanHomeView.tsx src/sidepanel/views/SimanTemplateListView.tsx src/sidepanel/views/SimanTemplateDetailView.tsx src/sidepanel/views/SimanDaftarView.tsx src/sidepanel/views/SimanRunView.tsx && rtk git commit -m "feat(siman): tab switcher + SIMAN home view with role picker"
```

---

## Task 6: Template Pengelolaan Views

**Files:**
- Modify: `src/sidepanel/views/SimanTemplateListView.tsx` (replace stub)
- Modify: `src/sidepanel/views/SimanTemplateDetailView.tsx` (replace stub)

- [ ] **Step 1: Replace `src/sidepanel/views/SimanTemplateListView.tsx`**

```tsx
// src/sidepanel/views/SimanTemplateListView.tsx
import { useState, useEffect } from "preact/hooks";
import type { PanelSnapshot, SimanTemplate, SimanTipePengelolaan } from "@/shared/types";

function send<T>(msg: unknown): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

interface Props {
  snap: PanelSnapshot;
  onEdit: (id: string) => void;
  onBack: () => void;
}

export function SimanTemplateListView({ onEdit }: Props) {
  const [templates, setTemplates] = useState<SimanTemplate[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const r = await send<{ ok: boolean; data?: SimanTemplate[] }>({ type: "siman/template-list" });
    if (r.ok) setTemplates(r.data ?? []);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function del(id: string) {
    if (!confirm("Hapus template ini?")) return;
    await send({ type: "siman/template-delete", id });
    await load();
  }

  if (loading) return <p class="hint" style="padding:12px">Memuat…</p>;

  return (
    <div style="padding:12px">
      <button class="btn" style="width:100%;margin-bottom:12px" onClick={() => onEdit("new")}>
        + Template Baru
      </button>
      {templates.length === 0 && <p class="hint">Belum ada template. Buat template baru untuk memulai.</p>}
      {templates.map((t) => (
        <div key={t.id} class="card" style="margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;align-items:flex-start">
            <div>
              <div style="font-weight:600;font-size:13px">{t.name}</div>
              <div class="hint" style="margin-top:2px">{t.namaTipe} · {Object.keys(t.mapping).length} variabel</div>
              <div class="hint" style="margin-top:2px">
                {t.konsepNd ? "ND ✓" : "ND —"} · {t.konsepNp ? "NP ✓" : "NP —"}
              </div>
            </div>
            <div style="display:flex;gap:6px">
              <button class="btn btn--ghost" style="font-size:11px;padding:4px 8px" onClick={() => onEdit(t.id)}>Edit</button>
              <button class="btn btn--ghost" style="font-size:11px;padding:4px 8px;color:var(--error)" onClick={() => del(t.id)}>Hapus</button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Replace `src/sidepanel/views/SimanTemplateDetailView.tsx`**

```tsx
// src/sidepanel/views/SimanTemplateDetailView.tsx
import { useState, useEffect } from "preact/hooks";
import type { SimanTemplate, SimanTipePengelolaan } from "@/shared/types";
import { scanPlaceholders } from "@/sidepanel/mailmerge/placeholder-scan";

function send<T>(msg: unknown): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

const SIMAN_VARIABLE_KEYS = [
  "no_tiket","kd_satker","ur_satker","nm_jns_bmn","pemohon","ur_kl",
  "nama_tipe_pengelolaan","nama_jenis_pengelolaan","termohon","deskripsi","durasi_penetapan",
  "jumlah_aset","sum_total_permohonan","sum_total_buku","sum_total_perolehan",
  "sum_nilai_persetujuan","sum_nilai_perolehan_proporsional","nilai_persetujuan_sewa",
  "pembilang_total_permohonan","pembilang_total_buku","pembilang_total_perolehan",
  "pembilang_nilai_persetujuan","pembilang_nilai_perolehan_proporsional","pembilang_nilai_sewa",
  "no_surat","tgl_surat","perihal_sk","nama_penandatangan_sk","jabatan_penandatangan_sk",
  "nm_dok_ba","no_dok_ba","tgl_dokumen_ba","alamat_satker","nm_kab_kota","alamat_lengkap",
  "pimpinan_satker","jabatan_pimpinan",
];

interface Props {
  templateId: string; // "new" for creation
  onBack: () => void;
}

export function SimanTemplateDetailView({ templateId, onBack }: Props) {
  const isNew = templateId === "new";
  const [tipes, setTipes] = useState<SimanTipePengelolaan[]>([]);
  const [name, setName] = useState("");
  const [idTipe, setIdTipe] = useState(0);
  const [namaTipe, setNamaTipe] = useState("");
  const [konsepNd, setKonsepNd] = useState<{ name: string; base64: string } | undefined>();
  const [konsepNp, setKonsepNp] = useState<{ name: string; base64: string } | undefined>();
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    send<{ ok: boolean; data?: SimanTipePengelolaan[] }>({ type: "siman/tipe-pengelolaan" })
      .then((r) => { if (r.ok) setTipes(r.data ?? []); });
    if (!isNew) {
      send<{ ok: boolean; data?: SimanTemplate }>({ type: "siman/template-get", id: templateId })
        .then((r) => {
          if (r.ok && r.data) {
            const t = r.data;
            setName(t.name);
            setIdTipe(t.idTipePengelolaan);
            setNamaTipe(t.namaTipe);
            setKonsepNd(t.konsepNd);
            setKonsepNp(t.konsepNp);
            setMapping(t.mapping);
          }
        });
    }
  }, [templateId]);

  async function readDocx(file: File): Promise<{ name: string; base64: string }> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(",")[1];
        resolve({ name: file.name, base64 });
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function handleNdUpload(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const docx = await readDocx(file);
    setKonsepNd(docx);
    // Auto-detect placeholders
    const placeholders = await scanPlaceholders(docx.base64);
    const newMapping: Record<string, string> = {};
    for (const ph of placeholders) {
      newMapping[ph] = mapping[ph] ?? "";
    }
    if (konsepNp) {
      const npPh = await scanPlaceholders(konsepNp.base64);
      for (const ph of npPh) newMapping[ph] = mapping[ph] ?? "";
    }
    setMapping(newMapping);
  }

  async function handleNpUpload(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const docx = await readDocx(file);
    setKonsepNp(docx);
    const npPh = await scanPlaceholders(docx.base64);
    const newMapping = { ...mapping };
    for (const ph of npPh) { if (!newMapping[ph]) newMapping[ph] = ""; }
    setMapping(newMapping);
  }

  async function save() {
    if (!name || !idTipe || !konsepNd) return alert("Nama, tipe, dan konsep ND wajib diisi.");
    setSaving(true);
    const partial: Omit<SimanTemplate, "id" | "createdAt"> = {
      name, idTipePengelolaan: idTipe, namaTipe,
      konsepNd, konsepNp, mapping, savedVariables: {},
    };
    if (isNew) {
      await send({ type: "siman/template-save", template: partial });
    } else {
      await send({ type: "siman/template-update", id: templateId, updates: partial });
    }
    setSaving(false);
    onBack();
  }

  return (
    <div style="padding:12px;display:flex;flex-direction:column;gap:12px">
      <div class="field">
        <label class="field__label">Nama Template</label>
        <input class="field__input" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="cth: Template PSP Standar" />
      </div>

      <div class="field">
        <label class="field__label">Tipe Pengelolaan</label>
        <select class="field__input" value={idTipe} onChange={(e) => {
          const v = Number((e.target as HTMLSelectElement).value);
          setIdTipe(v);
          setNamaTipe(tipes.find((t) => t.id_tipe_pengelolaan === v)?.nama_tipe ?? "");
        }}>
          <option value={0}>— Pilih tipe —</option>
          {tipes.map((t) => <option key={t.id_tipe_pengelolaan} value={t.id_tipe_pengelolaan}>{t.nama_tipe}</option>)}
        </select>
      </div>

      <div class="card">
        <div class="row">
          <span class="row__label">Konsep ND (.docx)</span>
          {konsepNd && <span class="row__value" style="font-size:11px;color:var(--color-primary)">✓ {konsepNd.name}</span>}
        </div>
        <input type="file" accept=".docx" onChange={handleNdUpload} style="margin-top:6px;font-size:12px" />
      </div>

      <div class="card">
        <div class="row">
          <span class="row__label">Konsep NP (.docx) <span class="hint">(opsional)</span></span>
          {konsepNp && <span class="row__value" style="font-size:11px;color:var(--color-primary)">✓ {konsepNp.name}</span>}
        </div>
        <input type="file" accept=".docx" onChange={handleNpUpload} style="margin-top:6px;font-size:12px" />
      </div>

      {Object.keys(mapping).length > 0 && (
        <div class="card">
          <div style="font-weight:600;font-size:12px;margin-bottom:8px">Pemetaan Placeholder → Variabel SIMAN</div>
          {Object.entries(mapping).map(([ph, varKey]) => (
            <div key={ph} style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
              <code style="flex:0 0 140px;font-size:11px;color:var(--color-primary)">{ph}</code>
              <select
                style="flex:1;font-size:11px;padding:3px 6px;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-sm);color:var(--text-primary)"
                value={varKey}
                onChange={(e) => setMapping({ ...mapping, [ph]: (e.target as HTMLSelectElement).value })}
              >
                <option value="">— pilih variabel —</option>
                {SIMAN_VARIABLE_KEYS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </div>
          ))}
        </div>
      )}

      <button class="btn" onClick={save} disabled={saving}>
        {saving ? "Menyimpan…" : isNew ? "Simpan Template" : "Update Template"}
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Verify `scanPlaceholders` import path**

Check that `src/sidepanel/mailmerge/placeholder-scan.ts` exports a `scanPlaceholders` function:

```bash
cd /Users/fahri/Automation/nadine/asguard-ext && grep -n "export" src/sidepanel/mailmerge/placeholder-scan.ts | head -5
```

If the function name differs, update the import accordingly.

- [ ] **Step 4: Build**

```bash
cd /Users/fahri/Automation/nadine/asguard-ext && npm run build 2>&1 | tail -20
```

Expected: successful build.

- [ ] **Step 5: Manual smoke test**

Load extension → SIMAN tab → Template Pengelolaan → Create new template → Upload a `.docx` with `{no_tiket}` placeholder → Verify placeholder appears in the mapping section → Map to `no_tiket` → Save → Verify template appears in list.

- [ ] **Step 6: Commit**

```bash
cd /Users/fahri/Automation/nadine/asguard-ext && rtk git add src/sidepanel/views/SimanTemplateListView.tsx src/sidepanel/views/SimanTemplateDetailView.tsx && rtk git commit -m "feat(siman): Template Pengelolaan list + create/edit views"
```

---

## Task 7: Daftar Pengelolaan View

**Files:**
- Modify: `src/sidepanel/views/SimanDaftarView.tsx` (replace stub)

- [ ] **Step 1: Replace `src/sidepanel/views/SimanDaftarView.tsx`**

```tsx
// src/sidepanel/views/SimanDaftarView.tsx
import { useState, useEffect } from "preact/hooks";
import type { PanelSnapshot, SimanTemplate, SimanPenetapan, SimanTipePengelolaan } from "@/shared/types";

function send<T>(msg: unknown): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

const STATUS_OPTIONS = ["", "Selesai", "Proses", "Draft"];
const LIMIT = 10;

interface Props {
  snap: PanelSnapshot;
  onRun: (noTiket: string, idPengelolaan: number, idTipePengelolaan: number, templateId: string) => void;
  onBack: () => void;
}

export function SimanDaftarView({ onRun }: Props) {
  const [items, setItems] = useState<SimanPenetapan[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState("");
  const [idTipe, setIdTipe] = useState(0);
  const [tipes, setTipes] = useState<SimanTipePengelolaan[]>([]);
  const [templates, setTemplates] = useState<SimanTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    send<{ ok: boolean; data?: SimanTipePengelolaan[] }>({ type: "siman/tipe-pengelolaan" })
      .then((r) => { if (r.ok) setTipes(r.data ?? []); });
    send<{ ok: boolean; data?: SimanTemplate[] }>({ type: "siman/template-list" })
      .then((r) => { if (r.ok) setTemplates(r.data ?? []); });
  }, []);

  useEffect(() => { fetchPage(0); }, [statusFilter, idTipe]);

  async function fetchPage(p: number) {
    setLoading(true);
    setError(null);
    try {
      const r = await send<{ ok: boolean; data?: { data: SimanPenetapan[]; total: number }; error?: string }>({
        type: "siman/penetapan-list",
        limit: LIMIT,
        offset: p * LIMIT,
        statusFilter: statusFilter || undefined,
        idTipe: idTipe || undefined,
      });
      if (r.ok && r.data) {
        setItems(r.data.data);
        setTotal(r.data.total);
        setPage(p);
      } else {
        setError(r.error ?? "Gagal memuat data");
      }
    } catch (e) {
      setError(String(e));
    }
    setLoading(false);
  }

  function templatesForTipe(idTipePengelolaan: number) {
    return templates.filter((t) => t.idTipePengelolaan === idTipePengelolaan);
  }

  const totalPages = Math.ceil(total / LIMIT);

  return (
    <div style="padding:8px;display:flex;flex-direction:column;gap:8px">
      {/* Filters */}
      <div style="display:flex;gap:6px">
        <select
          style="flex:1;font-size:11px;padding:4px 6px;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-sm);color:var(--text-primary)"
          value={statusFilter}
          onChange={(e) => setStatusFilter((e.target as HTMLSelectElement).value)}
        >
          {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s || "Semua status"}</option>)}
        </select>
        <select
          style="flex:1;font-size:11px;padding:4px 6px;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-sm);color:var(--text-primary)"
          value={idTipe}
          onChange={(e) => setIdTipe(Number((e.target as HTMLSelectElement).value))}
        >
          <option value={0}>Semua tipe</option>
          {tipes.map((t) => <option key={t.id_tipe_pengelolaan} value={t.id_tipe_pengelolaan}>{t.nama_tipe}</option>)}
        </select>
      </div>

      {loading && <p class="hint">Memuat…</p>}
      {error && <p class="hint" style="color:var(--error)">{error}</p>}

      {!loading && items.map((item) => {
        const availableTemplates = templatesForTipe(item.id_tipe_pengelolaan);
        return (
          <PenetapanCard
            key={item.no_tiket}
            item={item}
            templates={availableTemplates}
            onRun={onRun}
          />
        );
      })}

      {!loading && items.length === 0 && !error && (
        <p class="hint">Tidak ada data pengelolaan.</p>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px">
          <button class="btn btn--ghost" style="font-size:11px;padding:4px 10px" disabled={page === 0} onClick={() => fetchPage(page - 1)}>◀ Prev</button>
          <span class="hint">Hal {page + 1} / {totalPages} ({total} data)</span>
          <button class="btn btn--ghost" style="font-size:11px;padding:4px 10px" disabled={page >= totalPages - 1} onClick={() => fetchPage(page + 1)}>Next ▶</button>
        </div>
      )}
    </div>
  );
}

function PenetapanCard({ item, templates, onRun }: {
  item: SimanPenetapan;
  templates: SimanTemplate[];
  onRun: (noTiket: string, idPengelolaan: number, idTipePengelolaan: number, templateId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState(templates[0]?.id ?? "");
  const statusColor = item.deskripsi?.toLowerCase().includes("selesai") ? "var(--color-primary)" :
    item.deskripsi?.toLowerCase().includes("proses") ? "#2a5a8a" : "var(--muted)";

  return (
    <div class="card" style="padding:10px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:12px;color:var(--color-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{item.no_tiket}</div>
          <div style="font-size:11px;color:var(--text-primary);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{item.ur_satker || item.pemohon}</div>
          <div style="font-size:11px;color:var(--muted);margin-top:1px">{item.nama_tipe_pengelolaan}</div>
        </div>
        <div style="text-align:right;flex-shrink:0;margin-left:8px">
          <div style={`font-size:10px;padding:2px 6px;border-radius:10px;background:color-mix(in srgb, ${statusColor} 12%, transparent);color:${statusColor};font-weight:600`}>
            {item.deskripsi}
          </div>
          {item.durasi_penetapan && <div class="hint" style="margin-top:3px">{item.durasi_penetapan}</div>}
        </div>
      </div>

      <div style="display:flex;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid var(--line)">
        {templates.length > 0 ? (
          <>
            <select
              style="flex:1;font-size:11px;padding:3px 6px;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-sm);color:var(--text-primary)"
              value={selectedTemplate}
              onChange={(e) => setSelectedTemplate((e.target as HTMLSelectElement).value)}
            >
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <button
              class="btn"
              style="flex-shrink:0;font-size:11px;padding:4px 10px"
              onClick={() => onRun(item.no_tiket, item.id_pengelolaan ?? 0, item.id_tipe_pengelolaan, selectedTemplate)}
            >
              📄 Buat
            </button>
          </>
        ) : (
          <span class="hint" style="font-size:10px">Buat template {item.nama_tipe_pengelolaan} terlebih dahulu</span>
        )}
        <button class="btn btn--ghost" style="font-size:11px;padding:4px 8px;flex-shrink:0" onClick={() => setExpanded(!expanded)}>
          {expanded ? "▲" : "▼"}
        </button>
      </div>

      {expanded && (
        <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--line);font-size:11px;color:var(--muted)">
          <div><strong>Pemohon:</strong> {item.pemohon}</div>
          <div><strong>Deskripsi:</strong> {item.deskripsi}</div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Build**

```bash
cd /Users/fahri/Automation/nadine/asguard-ext && npm run build 2>&1 | tail -20
```

Expected: successful build.

- [ ] **Step 3: Manual smoke test**

Load extension → SIMAN tab → ensure role is set → Daftar Pengelolaan → Verify list loads with real SIMAN data. Filter by status. Verify "Buat" button appears for rows where a template exists for that tipe.

- [ ] **Step 4: Commit**

```bash
cd /Users/fahri/Automation/nadine/asguard-ext && rtk git add src/sidepanel/views/SimanDaftarView.tsx && rtk git commit -m "feat(siman): Daftar Pengelolaan view with filter + Buat Naskah trigger"
```

---

## Task 8: SimanRunView — Variable Preview & Naskah Generation

**Files:**
- Modify: `src/sidepanel/views/SimanRunView.tsx` (replace stub)
- Modify: `src/shared/siman-types.ts` — add render message type
- Modify: `src/background/index.ts` — add siman-run render step handler

- [ ] **Step 1: Add `siman/run-render` message type to `src/shared/siman-types.ts`**

Extend `SimanRunPortRequest` to a union:

```typescript
export type SimanRunPortRequest =
  | { type: "siman/run"; noTiket: string; idPengelolaan: number; idTipePengelolaan: number; templateId: string }
  | { type: "siman/run-render"; templateId: string; variables: Record<string, string>; ndDocxBase64: string; ndFilename: string; npDocxBase64?: string; npFilename?: string };
```

- [ ] **Step 2: Add render step handler in `src/background/index.ts`**

Inside the `siman-run` port `onMessage` listener (after the existing `siman/run` handler), add:

```typescript
if (msg.type === "siman/run-render") {
  try {
    send({ type: "siman/run-step", step: "Membuat naskah di Nadine…", done: false });
    const template = await simanStore.getSimanTemplateById(msg.templateId);
    const payload = template?.nadinePayload ?? {};
    const ndId = await nadine.createNaskah(payload as Parameters<typeof nadine.createNaskah>[0]);
    send({ type: "siman/run-step", step: "Mengunggah konsep ND…", done: false });
    const ndBytes = Uint8Array.from(atob(msg.ndDocxBase64), (c) => c.charCodeAt(0));
    await nadine.uploadKonsepFile(String(ndId), msg.ndFilename, ndBytes);
    if (msg.npDocxBase64 && msg.npFilename) {
      send({ type: "siman/run-step", step: "Membuat Nota Pengantar…", done: false });
      const npPayload = template?.nadinePayload ?? {};
      const npId = await nadine.createNotaPengantar(String(ndId), npPayload as Parameters<typeof nadine.createNotaPengantar>[1]);
      const npBytes = Uint8Array.from(atob(msg.npDocxBase64), (c) => c.charCodeAt(0));
      await nadine.uploadNotaPengantarFile(String(ndId), String(npId), msg.npFilename, npBytes);
    }
    // Save filled variables back to template for next run
    await simanStore.updateSimanTemplate(msg.templateId, { savedVariables: msg.variables });
    send({ type: "siman/run-done", ndId });
  } catch (e) {
    send({ type: "siman/run-error", error: e instanceof Error ? e.message : String(e) });
  }
}
```

- [ ] **Step 3: Replace `src/sidepanel/views/SimanRunView.tsx`**

```tsx
// src/sidepanel/views/SimanRunView.tsx
import { useState, useEffect } from "preact/hooks";
import type { SimanTemplate, SimanRunProgressMsg } from "@/shared/types";
import { renderDocx } from "@/sidepanel/mailmerge/docx-render";

function send<T>(msg: unknown): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

interface Props {
  noTiket: string;
  idPengelolaan: number;
  idTipePengelolaan: number;
  templateId: string;
  onDone: () => void;
  onBack: () => void;
}

type Phase = "fetching" | "preview" | "rendering" | "done" | "error";

export function SimanRunView({ noTiket, idPengelolaan, idTipePengelolaan, templateId, onDone }: Props) {
  const [phase, setPhase] = useState<Phase>("fetching");
  const [steps, setSteps] = useState<string[]>([]);
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [missingKeys, setMissingKeys] = useState<string[]>([]);
  const [template, setTemplate] = useState<SimanTemplate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ndId, setNdId] = useState<number | null>(null);

  useEffect(() => {
    // Load template
    send<{ ok: boolean; data?: SimanTemplate }>({ type: "siman/template-get", id: templateId })
      .then((r) => { if (r.ok) setTemplate(r.data ?? null); });

    // Open siman-run port
    const port = chrome.runtime.connect({ name: "siman-run" });
    port.onMessage.addListener((msg: SimanRunProgressMsg) => {
      if (msg.type === "siman/run-step") {
        setSteps((s) => [...s, msg.step]);
      } else if (msg.type === "siman/run-variables") {
        setVariables({ ...msg.variables, ...Object.fromEntries(missingKeys.map((k) => [k, ""])) });
        setMissingKeys(msg.missing);
        setPhase("preview");
      } else if (msg.type === "siman/run-done") {
        setNdId(msg.ndId);
        setPhase("done");
      } else if (msg.type === "siman/run-error") {
        setError(msg.error);
        setPhase("error");
      }
    });
    port.postMessage({ type: "siman/run", noTiket, idPengelolaan, idTipePengelolaan, templateId });
    return () => port.disconnect();
  }, []);

  async function handleRender() {
    if (!template) return;
    // Check all missing keys are filled
    const stillMissing = missingKeys.filter((k) => !variables[k]);
    if (stillMissing.length > 0) {
      alert(`Isi variabel yang kosong: ${stillMissing.join(", ")}`);
      return;
    }
    setPhase("rendering");
    setSteps([]);
    try {
      // Render ND docx in panel
      const ndBytes = await renderDocx(template.konsepNd!.base64, variables);
      const ndBase64 = btoa(String.fromCharCode(...ndBytes));
      let npBase64: string | undefined;
      let npFilename: string | undefined;
      if (template.konsepNp) {
        const npBytes = await renderDocx(template.konsepNp.base64, variables);
        npBase64 = btoa(String.fromCharCode(...npBytes));
        npFilename = template.konsepNp.name;
      }
      // Send to background for Nadine API calls
      const port = chrome.runtime.connect({ name: "siman-run" });
      port.onMessage.addListener((msg: SimanRunProgressMsg) => {
        if (msg.type === "siman/run-step") setSteps((s) => [...s, msg.step]);
        else if (msg.type === "siman/run-done") { setNdId(msg.ndId); setPhase("done"); port.disconnect(); }
        else if (msg.type === "siman/run-error") { setError(msg.error); setPhase("error"); port.disconnect(); }
      });
      port.postMessage({
        type: "siman/run-render",
        templateId,
        variables,
        ndDocxBase64: ndBase64,
        ndFilename: template.konsepNd!.name,
        npDocxBase64: npBase64,
        npFilename,
      });
    } catch (e) {
      setError(String(e));
      setPhase("error");
    }
  }

  if (phase === "fetching") {
    return (
      <div style="padding:12px">
        <p class="hint">Mengambil data SIMAN…</p>
        {steps.map((s, i) => <div key={i} style="font-size:12px;color:var(--muted);margin-bottom:4px">⏳ {s}</div>)}
      </div>
    );
  }

  if (phase === "preview") {
    return (
      <div style="padding:12px">
        <div style="font-weight:600;font-size:13px;margin-bottom:8px">Preview Variabel — {noTiket}</div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:10px">
          {Object.keys(variables).length} variabel · {missingKeys.length} perlu diisi
        </div>

        <div style="display:flex;flex-direction:column;gap:4px;max-height:60vh;overflow-y:auto;margin-bottom:12px">
          {/* Missing first */}
          {missingKeys.map((k) => (
            <div key={k} style="display:flex;gap:6px;align-items:center;padding:5px 8px;background:color-mix(in srgb, var(--error) 8%, transparent);border:1px solid color-mix(in srgb, var(--error) 25%, transparent);border-radius:var(--radius-sm)">
              <span style="color:var(--error);font-size:11px;width:12px">!</span>
              <code style="flex:0 0 130px;font-size:10px;color:var(--error)">{k}</code>
              <input
                style="flex:1;font-size:11px;padding:2px 6px;background:var(--surface);border:1px solid var(--error);border-radius:var(--radius-sm);color:var(--text-primary)"
                value={variables[k] ?? ""}
                placeholder={`Isi ${k}…`}
                onInput={(e) => setVariables({ ...variables, [k]: (e.target as HTMLInputElement).value })}
              />
            </div>
          ))}
          {/* Resolved */}
          {Object.entries(variables)
            .filter(([k]) => !missingKeys.includes(k))
            .map(([k, v]) => (
              <div key={k} style="display:flex;gap:6px;align-items:center;padding:5px 8px;background:color-mix(in srgb, var(--color-primary) 6%, transparent);border-radius:var(--radius-sm)">
                <span style="color:var(--color-primary);font-size:11px;width:12px">✓</span>
                <code style="flex:0 0 130px;font-size:10px;color:var(--color-primary)">{k}</code>
                <input
                  style="flex:1;font-size:11px;padding:2px 6px;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-sm);color:var(--text-primary)"
                  value={v}
                  onInput={(e) => setVariables({ ...variables, [k]: (e.target as HTMLInputElement).value })}
                />
              </div>
            ))}
        </div>

        <button class="btn" style="width:100%" onClick={handleRender}>
          ▶ Render Dokumen
        </button>
      </div>
    );
  }

  if (phase === "rendering") {
    return (
      <div style="padding:12px">
        <p class="hint">Membuat naskah…</p>
        {steps.map((s, i) => <div key={i} style="font-size:12px;color:var(--muted);margin-bottom:4px">⏳ {s}</div>)}
      </div>
    );
  }

  if (phase === "done") {
    return (
      <div style="padding:12px;text-align:center">
        <div style="font-size:32px;margin-bottom:8px">✅</div>
        <div style="font-weight:600;margin-bottom:4px">Naskah berhasil dibuat!</div>
        <div class="hint">ND ID: {ndId}</div>
        <button class="btn" style="margin-top:16px;width:100%" onClick={onDone}>Kembali ke Daftar</button>
      </div>
    );
  }

  return (
    <div style="padding:12px">
      <div style="color:var(--error);margin-bottom:8px">❌ Error: {error}</div>
      <button class="btn btn--ghost" style="width:100%">Coba Lagi</button>
    </div>
  );
}
```

- [ ] **Step 4: Verify `renderDocx` import**

```bash
cd /Users/fahri/Automation/nadine/asguard-ext && grep -n "export" src/sidepanel/mailmerge/docx-render.ts | head -5
```

If the exported function name is different, update the import in `SimanRunView.tsx`.

- [ ] **Step 5: Build**

```bash
cd /Users/fahri/Automation/nadine/asguard-ext && npm run build 2>&1 | tail -20
```

Expected: successful build.

- [ ] **Step 6: End-to-end smoke test**

1. Visit `siman.kemenkeu.go.id` → SIMAN tab shows role picker → pick a role → user info strip shows
2. Create a template with a `.docx` containing `{no_tiket}` and `{pimpinan_satker}` placeholders, map them
3. Go to Daftar Pengelolaan → find a penetapan → click "Buat" with the new template
4. Variable preview shows: `no_tiket` green ✓ with value, `pimpinan_satker` red ! with input
5. Fill in `pimpinan_satker` → click "Render Dokumen"
6. Progress steps show → success screen with ND ID
7. Visit Nadine web app → verify naskah was created with the correct konsep file

- [ ] **Step 7: Commit**

```bash
cd /Users/fahri/Automation/nadine/asguard-ext && rtk git add src/sidepanel/views/SimanRunView.tsx src/shared/siman-types.ts src/background/index.ts && rtk git commit -m "feat(siman): SimanRunView — variable preview, fill, render, create naskah"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| SIMAN token capture from siman.kemenkeu.go.id | Task 2 (page-inject + content/index) |
| Role selection auto-prompted after token capture | Task 5 (SimanHomeView RolePicker) |
| Tab switcher with auto-detection | Task 5 (App.tsx + page-detector) |
| User info strip per tab | Task 5 (SimanHomeView user-strip) |
| Template Pengelolaan — create/edit/delete | Task 6 (SimanTemplateListView + DetailView) |
| Daftar Pengelolaan — browse + filter | Task 7 (SimanDaftarView) |
| Variable preview + manual fill | Task 8 (SimanRunView preview phase) |
| savedVariables auto-save | Task 8 (siman-run-render handler) |
| Single-penetapan ND + NP generation | Task 8 (siman-run-render + nadine-client) |
| terbilang calculation | Task 3 (terbilang.ts) |
| Ganti Role button | Task 5 (SimanHomeView) |

**Placeholder scan:** None found.

**Type consistency check:**
- `SimanRoleContext` defined in Task 1, used in Tasks 2, 3, 4 ✓
- `SimanTemplate` defined in Task 1, used in Tasks 2, 6, 7, 8 ✓
- `SimanRunPortRequest` union extended in Task 8 to match Task 4 handler ✓
- `renderDocx` from `docx-render.ts` — verify exact export name in Task 8 Step 4 ✓
- `scanPlaceholders` from `placeholder-scan.ts` — verify exact export name in Task 6 Step 3 ✓
- `nadine.createNaskah`, `nadine.uploadKonsepFile`, `nadine.createNotaPengantar`, `nadine.uploadNotaPengantarFile` — all exist in `nadine-client.ts` per exploration ✓
