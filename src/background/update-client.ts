/**
 * Extension update checker.
 * Calls GET /api/version on the license server and compares with current version.
 */

const VERSION_URL = "https://vps.asetpattimura.my.id/api/version";
const CACHE_KEY = "asguard.updateCheck";
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

export interface UpdateInfo {
  available: boolean;
  currentVersion: string;
  latestVersion: string;
  downloadUrl: string | null;
  changelog: string | null;
  checkedAt: number;
}

function getCurrentVersion(): string {
  return chrome.runtime.getManifest().version;
}

/** Compare semver strings. Returns true if remote > local. */
function isNewer(remote: string, local: string): boolean {
  const r = remote.split(".").map(Number);
  const l = local.split(".").map(Number);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const rv = r[i] ?? 0;
    const lv = l[i] ?? 0;
    if (rv > lv) return true;
    if (rv < lv) return false;
  }
  return false;
}

export async function checkForUpdate(): Promise<UpdateInfo> {
  const current = getCurrentVersion();
  try {
    const res = await fetch(VERSION_URL, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as Record<string, unknown>;
    const latest = String(data.ext_version ?? data.version ?? "0");
    const rawUrl = (data.ext_download_url ?? data.download_url ?? null) as string | null;
    // Make relative URLs absolute
    const downloadUrl = rawUrl && rawUrl.startsWith("/") ? `https://vps.asetpattimura.my.id${rawUrl}` : rawUrl;
    const info: UpdateInfo = {
      available: isNewer(latest, current),
      currentVersion: current,
      latestVersion: latest,
      downloadUrl,
      changelog: (data.ext_changelog ?? data.changelog ?? null) as string | null,
      checkedAt: Date.now(),
    };
    await chrome.storage.local.set({ [CACHE_KEY]: info });
    return info;
  } catch {
    // Return cached if available
    const cached = await getCachedUpdate();
    return cached ?? {
      available: false,
      currentVersion: current,
      latestVersion: current,
      downloadUrl: null,
      changelog: null,
      checkedAt: 0,
    };
  }
}

export async function getCachedUpdate(): Promise<UpdateInfo | null> {
  const data = await chrome.storage.local.get(CACHE_KEY);
  return (data[CACHE_KEY] as UpdateInfo) ?? null;
}

/** Check if enough time has passed since last check. */
export async function shouldCheck(): Promise<boolean> {
  const cached = await getCachedUpdate();
  if (!cached) return true;
  return Date.now() - cached.checkedAt > CHECK_INTERVAL_MS;
}
