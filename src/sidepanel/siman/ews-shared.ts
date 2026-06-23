/**
 * Shared EWS (Early Warning System) types, constants, and helpers.
 * Used by BOTH SimanEwsView (list) and SimanEwsDetailView — edit here only,
 * so the two views never drift.
 */
import type { EwsRow } from "@/shared/siman-types";

export const CACHE_KEY = "ewsData";
export const NOTES_STORE_KEY = "asguard.ews-notes";
export const LEGACY_KEY = "asguard.ews-confirmations";
export const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

export interface CachedEws {
  rows: EwsRow[];
  updatedAt: number;
  kpknlId?: number;
}

export type EwsNoteChoice = "sudah_perpanjang" | "proses_perpanjangan" | "tidak" | "diperpanjang";

export interface EwsNoteLocal {
  no_tiket: string;
  kpknl_id: number;
  note: string;
  status: "confirmed" | "dismissed";
  choice?: EwsNoteChoice;
  author: string;
  updated_at?: string;
  last_synced_at?: string;
  no_tiket_perpanjangan?: string;
  surat_persetujuan?: string;
}

export interface NotesStore {
  kpknl_id: number;
  notes: Record<string, EwsNoteLocal>;
}

interface LegacyConfirmation {
  no_tiket: string;
  choice: "diperpanjang" | "tidak";
  note: string;
  author: string;
  updated_at: string;
}

/** EWS status palette (light/dark tokens defined in styles.css :root). */
export const EWS_COLORS = {
  lewat:     { border: "var(--ews-lewat)",     text: "var(--ews-lewat)",     label: "Lewat" },
  kritis:    { border: "var(--ews-kritis)",    text: "var(--ews-kritis)",    label: "Kritis" },
  perhatian: { border: "var(--ews-perhatian)", text: "var(--ews-perhatian)", label: "Perhatian" },
  aman:      { border: "var(--ews-aman)",      text: "var(--ews-aman)",      label: "Aman" },
} as const;

export function send<T>(msg: unknown): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

/**
 * Compute sisa hari/label from tgl_berakhir as of a specific frozen date.
 * Both dates must be "YYYY-MM-DD" (time portion is stripped). Returns null if invalid.
 */
export function computeFrozenSisa(tglBerakhir: string, frozenDateStr: string): { sisa_hari: number; sisa_label: string } | null {
  if (!tglBerakhir || !frozenDateStr) return null;
  const dateStr = frozenDateStr.split(" ")[0]; // strip time if present
  const a = new Date(dateStr + "T00:00:00");
  const b = new Date(tglBerakhir + "T00:00:00");
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return null;
  const sisa_hari = Math.round((b.getTime() - a.getTime()) / 86400000);
  const abs = Math.abs(sisa_hari);
  function fmt(d: number): string {
    const y = Math.floor(d / 365), r = d % 365, m = Math.floor(r / 30), dd = r % 30;
    const p: string[] = [];
    if (y > 0) p.push(`${y} Tahun`);
    if (m > 0) p.push(`${m} Bulan`);
    if (dd > 0 || p.length === 0) p.push(`${dd} Hari`);
    return p.join(" ");
  }
  const sisa_label = sisa_hari < 0 ? `Sudah Lewat ${fmt(abs)}` : sisa_hari === 0 ? "Hari Ini" : fmt(sisa_hari);
  return { sisa_hari, sisa_label };
}

export function formatCacheAge(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "baru saja";
  if (mins < 60) return `${mins} menit lalu`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} jam lalu`;
  const days = Math.floor(hrs / 24);
  return `${days} hari lalu`;
}

export function formatDate(ts: number): string {
  return new Date(ts).toLocaleString("id-ID", {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

export function formatRelative(iso?: string): string {
  if (!iso) return "Belum pernah";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return iso;
  const diff = Date.now() - t;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "baru saja";
  if (mins < 60) return `${mins} menit lalu`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} jam lalu`;
  const days = Math.floor(hrs / 24);
  return `${days} hari lalu`;
}

export function formatRupiah(n: number): string {
  if (!n) return "-";
  return "Rp " + n.toLocaleString("id-ID");
}

export async function loadNotesMap(): Promise<Map<string, EwsNoteLocal>> {
  return new Promise((resolve) => {
    chrome.storage.local.get(NOTES_STORE_KEY, (res) => {
      const store = res[NOTES_STORE_KEY] as NotesStore | undefined;
      const map = new Map<string, EwsNoteLocal>();
      if (store?.notes) {
        for (const [k, v] of Object.entries(store.notes)) map.set(k, v);
      }
      resolve(map);
    });
  });
}

/** Migrate legacy `asguard.ews-confirmations` → `asguard.ews-notes`. Idempotent. */
export async function migrateLegacy(kpknlId: number): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.get([LEGACY_KEY, NOTES_STORE_KEY], (res) => {
      const legacy = res[LEGACY_KEY] as Record<string, LegacyConfirmation> | undefined;
      if (!legacy || Object.keys(legacy).length === 0) { resolve(); return; }

      const existing = res[NOTES_STORE_KEY] as NotesStore | undefined;
      const store: NotesStore = existing && existing.kpknl_id === kpknlId
        ? existing
        : { kpknl_id: kpknlId, notes: {} };

      let migrated = 0;
      for (const [noTiket, c] of Object.entries(legacy)) {
        if (store.notes[noTiket]) continue;
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
        chrome.storage.local.set({ [NOTES_STORE_KEY]: store }, () => resolve());
      } else {
        resolve();
      }
    });
  });
}
