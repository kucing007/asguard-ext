/**
 * Persists per-source seen-IDs so the polling watcher knows what's "truly new".
 *
 * Each source has a `primed` flag — first poll just records IDs without notifying,
 * to avoid flooding the user with their entire existing inbox on install or
 * after re-enabling a previously-disabled source. FIFO cap keeps storage bounded.
 */
import type { NotifSource } from "@/shared/types";

const STORAGE_KEY = "asguard.notifSeen";
const MAX_PER_SOURCE = 500;

interface SourceState {
  primed: boolean;
  ids: string[];
}

type SeenMap = Record<NotifSource, SourceState>;

const EMPTY: SeenMap = {
  disposisi: { primed: false, ids: [] },
  amplop: { primed: false, ids: [] },
  siman: { primed: false, ids: [] },
};

let cached: SeenMap = clone(EMPTY);

function clone(m: SeenMap): SeenMap {
  return {
    disposisi: { primed: m.disposisi.primed, ids: [...m.disposisi.ids] },
    amplop: { primed: m.amplop.primed, ids: [...m.amplop.ids] },
    siman: { primed: m.siman.primed, ids: [...m.siman.ids] },
  };
}

export async function restore(): Promise<void> {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const raw = data[STORAGE_KEY] as Partial<SeenMap> | undefined;
  if (raw) {
    cached = {
      disposisi: { primed: !!raw.disposisi?.primed, ids: raw.disposisi?.ids ?? [] },
      amplop: { primed: !!raw.amplop?.primed, ids: raw.amplop?.ids ?? [] },
      siman: { primed: !!raw.siman?.primed, ids: raw.siman?.ids ?? [] },
    };
  }
}

async function persist(): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: cached });
}

export function isPrimed(source: NotifSource): boolean {
  return cached[source].primed;
}

/**
 * Returns the subset of `currentIds` that are NOT in the seen set for this source.
 * This is the "truly new" set the caller will notify on (after priming).
 */
export function diffNew(source: NotifSource, currentIds: string[]): string[] {
  const seen = new Set(cached[source].ids);
  return currentIds.filter((id) => !seen.has(id));
}

/**
 * Record `ids` as seen, marking the source as primed. Caps the list at
 * MAX_PER_SOURCE entries (FIFO eviction — drop oldest).
 */
export async function markSeen(source: NotifSource, ids: string[]): Promise<void> {
  if (ids.length === 0 && cached[source].primed) return;
  const existing = cached[source].ids;
  const merged = [...existing];
  const seen = new Set(existing);
  for (const id of ids) {
    if (!seen.has(id)) {
      merged.push(id);
      seen.add(id);
    }
  }
  // FIFO trim — keep most recent MAX_PER_SOURCE
  const trimmed = merged.length > MAX_PER_SOURCE ? merged.slice(merged.length - MAX_PER_SOURCE) : merged;
  cached[source] = { primed: true, ids: trimmed };
  await persist();
}

/** Wipe a single source's seen-set so the next poll re-primes (used on SIMAN role change). */
export async function reset(source: NotifSource): Promise<void> {
  cached[source] = { primed: false, ids: [] };
  await persist();
}

/**
 * Diagnostic helper — drop the N most recently-seen IDs (in-memory + persisted)
 * so the next poll sees them as "new" and fires a notification. Used only by
 * the asguardDebug console helper.
 */
export async function debugForgetRecent(source: NotifSource, count: number): Promise<number> {
  const before = cached[source].ids.length;
  const dropped = cached[source].ids.slice(0, Math.max(0, before - count));
  cached[source] = { primed: cached[source].primed, ids: dropped };
  await persist();
  return before - dropped.length;
}
