/**
 * EWS Notes Sync Client
 * Primary: chrome.storage.local (always works)
 * Secondary: sync to nadine-license-server when available
 */
import { debugLog } from "@/shared/logging";

const EWS_API_BASE = "https://vps.asetpattimura.my.id/api/ews";
const NOTES_STORE_KEY = "asguard.ews-notes";
const LEGACY_CONFIRMATIONS_KEY = "asguard.ews-confirmations";

export type EwsNoteStatus = "confirmed" | "dismissed";
export type EwsNoteChoice = "diperpanjang" | "tidak";

export interface EwsNoteData {
  no_tiket: string;
  kpknl_id: number;
  note: string;
  status: EwsNoteStatus;
  /** User-facing choice; preserved alongside `status`. */
  choice?: EwsNoteChoice;
  author: string;
  updated_at?: string;
  /** Set by client whenever a successful server sync completes. */
  last_synced_at?: string;
}

interface NotesStore {
  kpknl_id: number;
  notes: Record<string, EwsNoteData>; // keyed by no_tiket
}

// --- Local storage (primary, always works) ---

async function getLocalStore(kpknlId: number): Promise<NotesStore> {
  const data = await chrome.storage.local.get(NOTES_STORE_KEY);
  const store = data[NOTES_STORE_KEY] as NotesStore | undefined;
  if (store && store.kpknl_id === kpknlId) return store;
  return { kpknl_id: kpknlId, notes: {} };
}

async function saveLocalStore(store: NotesStore): Promise<void> {
  await chrome.storage.local.set({ [NOTES_STORE_KEY]: store });
}

/** Get all notes from local storage */
export async function getLocalNotes(kpknlId: number): Promise<EwsNoteData[]> {
  const store = await getLocalStore(kpknlId);
  return Object.values(store.notes);
}

/** Get a single local note */
export async function getLocalNote(noTiket: string, kpknlId: number): Promise<EwsNoteData | null> {
  const store = await getLocalStore(kpknlId);
  return store.notes[noTiket] ?? null;
}

/** Save a note locally */
export async function saveNoteLocal(note: EwsNoteData): Promise<void> {
  const store = await getLocalStore(note.kpknl_id);
  store.notes[note.no_tiket] = note;
  await saveLocalStore(store);
  debugLog("[ews-notes] saved locally:", note.no_tiket);
}

/** Delete a note locally */
export async function deleteNoteLocal(noTiket: string, kpknlId: number): Promise<void> {
  const store = await getLocalStore(kpknlId);
  delete store.notes[noTiket];
  await saveLocalStore(store);
  debugLog("[ews-notes] deleted locally:", noTiket);
}

// --- One-shot legacy migration: asguard.ews-confirmations -> asguard.ews-notes ---

interface LegacyConfirmation {
  no_tiket: string;
  choice: EwsNoteChoice;
  note: string;
  author: string;
  updated_at: string;
}

/**
 * Migrate legacy `asguard.ews-confirmations` (flat record keyed by no_tiket) into
 * the new per-KPKNL `asguard.ews-notes` store. Idempotent. Legacy key is preserved
 * for one release as a safety net.
 */
export async function migrateLegacyConfirmationsIfNeeded(kpknlId: number): Promise<number> {
  const data = await chrome.storage.local.get(LEGACY_CONFIRMATIONS_KEY);
  const legacy = data[LEGACY_CONFIRMATIONS_KEY] as Record<string, LegacyConfirmation> | undefined;
  if (!legacy || Object.keys(legacy).length === 0) return 0;

  const store = await getLocalStore(kpknlId);
  let migrated = 0;
  for (const [noTiket, c] of Object.entries(legacy)) {
    if (store.notes[noTiket]) continue; // don't overwrite
    store.notes[noTiket] = {
      no_tiket: noTiket,
      kpknl_id: kpknlId,
      note: c.note ?? "",
      status: c.choice === "diperpanjang" ? "confirmed" : "dismissed",
      choice: c.choice,
      author: c.author ?? "",
      updated_at: c.updated_at,
    };
    migrated++;
  }
  if (migrated > 0) {
    await saveLocalStore(store);
    debugLog("[ews-notes] migrated legacy confirmations:", migrated);
  }
  return migrated;
}

// --- Server sync (secondary, best-effort) ---

/** Push a single note to server */
export async function pushNoteToServer(note: Omit<EwsNoteData, "updated_at" | "last_synced_at">): Promise<boolean> {
  try {
    const res = await fetch(`${EWS_API_BASE}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(note),
    });
    debugLog("[ews-notes] server push:", res.ok ? "ok" : res.status);
    return res.ok;
  } catch (e) {
    debugLog("[ews-notes] server push failed:", e);
    return false;
  }
}

/** Delete a note from server */
export async function deleteNoteFromServer(noTiket: string, kpknlId: number): Promise<boolean> {
  try {
    const res = await fetch(`${EWS_API_BASE}/notes`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ no_tiket: noTiket, kpknl_id: kpknlId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Pull all notes from server and merge with local.
 * If `author` is supplied, server returns only notes authored by that user.
 */
export async function syncFromServer(kpknlId: number, author?: string): Promise<EwsNoteData[]> {
  try {
    const url = new URL(`${EWS_API_BASE}/notes`);
    url.searchParams.set("kpknl_id", String(kpknlId));
    if (author) url.searchParams.set("author", author);
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`${res.status}`);
    const serverNotes = (await res.json()) as EwsNoteData[];

    const store = await getLocalStore(kpknlId);
    const nowIso = new Date().toISOString();
    for (const n of serverNotes) {
      store.notes[n.no_tiket] = { ...n, last_synced_at: nowIso };
    }
    await saveLocalStore(store);
    debugLog("[ews-notes] synced from server:", serverNotes.length, "notes");
    return Object.values(store.notes);
  } catch (e) {
    debugLog("[ews-notes] server sync failed, using local:", e);
    return getLocalNotes(kpknlId);
  }
}

/**
 * Sync a single ticket bidirectionally with the server using POST /notes/sync.
 * Sends the local copy with its `updated_at`; server applies last-write-wins
 * and returns the authoritative version, which we then store locally and
 * stamp with `last_synced_at`.
 */
export async function syncSingleTicket(
  noTiket: string,
  kpknlId: number,
): Promise<{ ok: true; note: EwsNoteData } | { ok: false; error: string }> {
  try {
    const local = await getLocalNote(noTiket, kpknlId);
    const body: Record<string, unknown> = {
      no_tiket: noTiket,
      kpknl_id: kpknlId,
    };
    if (local) {
      body.note = local.note;
      body.status = local.status;
      body.choice = local.choice;
      body.author = local.author;
      body.updated_at = local.updated_at;
    }

    const res = await fetch(`${EWS_API_BASE}/notes/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (res.status === 404) {
      // Server has no record AND client had nothing — nothing to sync.
      return { ok: false, error: "Tidak ada catatan untuk tiket ini di server maupun lokal." };
    }
    if (!res.ok) {
      return { ok: false, error: `Server ${res.status}` };
    }

    const authoritative = (await res.json()) as EwsNoteData;
    const merged: EwsNoteData = {
      ...authoritative,
      last_synced_at: new Date().toISOString(),
    };
    await saveNoteLocal(merged);
    return { ok: true, note: merged };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
