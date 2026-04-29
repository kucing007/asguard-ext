/**
 * Simple ndId-keyed summary cache in chrome.storage.local.
 * Stores completed summary text so re-opening the same naskah is instant.
 */

const CACHE_PREFIX = "asguard.summary.";
const MAX_CACHE_ENTRIES = 50;

export async function getCached(ndId: string): Promise<string | null> {
  const key = CACHE_PREFIX + ndId;
  const data = await chrome.storage.local.get(key);
  return (data[key] as string) ?? null;
}

export async function setCached(ndId: string, summary: string): Promise<void> {
  const key = CACHE_PREFIX + ndId;
  await chrome.storage.local.set({ [key]: summary });
  // Best-effort prune
  pruneOldEntries().catch(() => {});
}

async function pruneOldEntries(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const cacheKeys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
  if (cacheKeys.length <= MAX_CACHE_ENTRIES) return;
  const toRemove = cacheKeys.slice(0, cacheKeys.length - MAX_CACHE_ENTRIES);
  await chrome.storage.local.remove(toRemove);
}

export async function clearCache(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const cacheKeys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
  if (cacheKeys.length) await chrome.storage.local.remove(cacheKeys);
}
