/**
 * Persistent user identity cache.
 *
 * `fullname` and `nip` flow into the extension from two sources:
 *   1. Nadine `/Auth/me`     → token-store.setNipFromMe()
 *   2. SIMAN  `/swkf/auth/v1/me` → siman-store.setSimanToken()
 *
 * Both originally write to `chrome.storage.session`, which is wiped on browser
 * restart. That's why downstream features (e.g. EWS note `author`) fall back
 * to "Anonim" on the first opening of the side panel after a fresh launch.
 *
 * This module mirrors the latest known identity to `chrome.storage.local` so
 * it survives restarts. Last-write wins; SIMAN overrides Nadine if both fire,
 * because SIMAN's `fullname` is typically the more user-facing display name.
 */

const KEY = "asguard.userIdentity";

export interface UserIdentity {
  fullname: string;
  nip: string;
  /** Where the identity came from, for diagnostics. */
  source: "nadine" | "siman";
  updatedAt: number;
}

export async function setIdentity(
  fullname: string | null | undefined,
  nip: string | null | undefined,
  source: "nadine" | "siman",
): Promise<void> {
  const fn = (fullname ?? "").trim();
  const n = (nip ?? "").trim();
  if (!fn && !n) return; // nothing useful to persist
  const next: UserIdentity = { fullname: fn, nip: n, source, updatedAt: Date.now() };
  await chrome.storage.local.set({ [KEY]: next });
}

export async function getIdentity(): Promise<UserIdentity | null> {
  const data = await chrome.storage.local.get(KEY);
  return (data[KEY] as UserIdentity | undefined) ?? null;
}

export async function clearIdentity(): Promise<void> {
  await chrome.storage.local.remove(KEY);
}
