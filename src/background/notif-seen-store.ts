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
  // SIMAN-only: per-noTiket last-seen status, used to detect status transitions.
  // Absent for nadine sources. Older persisted state may not have this field.
  statuses?: Record<string, string>;
}

type SeenMap = Record<NotifSource, SourceState>;

const EMPTY: SeenMap = {
  disposisi: { primed: false, ids: [] },
  amplop: { primed: false, ids: [] },
  siman: { primed: false, ids: [], statuses: {} },
};

let cached: SeenMap = clone(EMPTY);

function clone(m: SeenMap): SeenMap {
  return {
    disposisi: { primed: m.disposisi.primed, ids: [...m.disposisi.ids] },
    amplop: { primed: m.amplop.primed, ids: [...m.amplop.ids] },
    siman: {
      primed: m.siman.primed,
      ids: [...m.siman.ids],
      statuses: { ...(m.siman.statuses ?? {}) },
    },
  };
}

export async function restore(): Promise<void> {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const raw = data[STORAGE_KEY] as Partial<SeenMap> | undefined;
  if (raw) {
    cached = {
      disposisi: { primed: !!raw.disposisi?.primed, ids: raw.disposisi?.ids ?? [] },
      amplop: { primed: !!raw.amplop?.primed, ids: raw.amplop?.ids ?? [] },
      siman: {
        primed: !!raw.siman?.primed,
        ids: raw.siman?.ids ?? [],
        statuses: raw.siman?.statuses ?? {},
      },
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
  const next: SourceState = { primed: true, ids: trimmed };
  if (source === "siman") {
    // Preserve any existing status map; markSeenSiman is the canonical writer.
    next.statuses = { ...(cached.siman.statuses ?? {}) };
    pruneStatuses(next);
  }
  cached[source] = next;
  await persist();
}

/** Wipe a single source's seen-set so the next poll re-primes (used on SIMAN role change). */
export async function reset(source: NotifSource): Promise<void> {
  if (source === "siman") {
    cached.siman = { primed: false, ids: [], statuses: {} };
  } else {
    cached[source] = { primed: false, ids: [] };
  }
  await persist();
}

// --- SIMAN status tracking ---

export interface SimanCurrentItem {
  id: string;
  status: string;
}

export interface SimanDiff {
  newIds: string[];
  changed: Array<{ id: string; oldStatus: string; newStatus: string }>;
}

/**
 * Diff current siman list against the last-seen statuses.
 * - newIds: ids whose status was never recorded before (truly new tickets).
 * - changed: ids with a previously-recorded status that now differs.
 *
 * Notes:
 * - Existing users upgrading from the ID-only schema will have empty statuses.
 *   Their already-seen ids fall into neither bucket on the first cycle, so no
 *   bulk notification flood — statuses get populated by markSeenSiman, then
 *   subsequent cycles can detect transitions normally.
 * - Empty / missing status strings are treated as "no recorded status" so we
 *   don't fire a transition for "" → "Diajukan" on the first observation.
 */
export function diffSiman(current: SimanCurrentItem[]): SimanDiff {
  const statuses = cached.siman.statuses ?? {};
  const seenIds = new Set(cached.siman.ids);
  const newIds: string[] = [];
  const changed: SimanDiff["changed"] = [];
  for (const { id, status } of current) {
    const prior = statuses[id];
    if (!seenIds.has(id) && !prior) {
      newIds.push(id);
      continue;
    }
    if (prior && status && prior !== status) {
      changed.push({ id, oldStatus: prior, newStatus: status });
    }
  }
  return { newIds, changed };
}

/**
 * Record current siman ids + statuses, marking the source as primed.
 * Statuses for the same id overwrite older values; this is the canonical
 * status-update writer (the generic `markSeen` only preserves existing entries).
 */
export async function markSeenSiman(current: SimanCurrentItem[]): Promise<void> {
  if (current.length === 0 && cached.siman.primed) return;
  const existingIds = cached.siman.ids;
  const merged = [...existingIds];
  const seen = new Set(existingIds);
  const statuses = { ...(cached.siman.statuses ?? {}) };
  for (const { id, status } of current) {
    if (!seen.has(id)) {
      merged.push(id);
      seen.add(id);
    }
    if (status) statuses[id] = status;
  }
  const trimmed = merged.length > MAX_PER_SOURCE ? merged.slice(merged.length - MAX_PER_SOURCE) : merged;
  cached.siman = { primed: true, ids: trimmed, statuses };
  pruneStatuses(cached.siman);
  await persist();
}

/** Drop status entries whose id has fallen out of the FIFO id list (keeps storage bounded). */
function pruneStatuses(state: SourceState): void {
  if (!state.statuses) return;
  const idSet = new Set(state.ids);
  for (const id of Object.keys(state.statuses)) {
    if (!idSet.has(id)) delete state.statuses[id];
  }
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
