import type { LicenseStatus } from "@/shared/types";

const LICENSE_URL = "https://vps.asetpattimura.my.id/api/license/check";
const CACHE_KEY = "asguard.license";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type { LicenseStatus };

export async function checkLicense(nip: string, name?: string): Promise<LicenseStatus> {
  const cached = await getCached(nip);
  try {
    const res = await fetch(LICENSE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(name ? { nip, name } : { nip }),
    });
    if (res.ok) {
      const data = await res.json() as LicenseStatus;
      await setCache(nip, data);
      return data;
    }
    return cached ?? { valid: false, status: "error", message: `Server error (${res.status})`, days_remaining: 0 };
  } catch {
    if (cached && isCacheValid(cached)) return cached;
    return { valid: false, status: "offline", message: "Tidak dapat terhubung ke server lisensi.", days_remaining: 0 };
  }
}

export async function clearLicenseCache(): Promise<void> {
  await chrome.storage.local.remove(CACHE_KEY);
}

export async function restoreCachedLicense(): Promise<LicenseStatus | null> {
  const data = await chrome.storage.local.get(CACHE_KEY);
  const entry = data[CACHE_KEY] as { nip: string; status: LicenseStatus } | undefined;
  if (!entry) return null;
  return entry.status;
}

async function getCached(nip: string): Promise<LicenseStatus | null> {
  const data = await chrome.storage.local.get(CACHE_KEY);
  const entry = data[CACHE_KEY] as { nip: string; status: LicenseStatus } | undefined;
  if (!entry || entry.nip !== nip) return null;
  return entry.status;
}

async function setCache(nip: string, status: LicenseStatus): Promise<void> {
  await chrome.storage.local.set({
    [CACHE_KEY]: { nip, status: { ...status, cachedAt: Date.now() } },
  });
}

function isCacheValid(s: LicenseStatus): boolean {
  if (!s.cachedAt || Date.now() - s.cachedAt > CACHE_TTL_MS) return false;
  if (s.expires && Date.now() > new Date(s.expires).getTime()) return false;
  if (s.status === "expired" || s.status === "blocked") return false;
  return true;
}
