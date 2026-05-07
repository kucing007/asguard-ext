/**
 * Background-watcher notifications for Nadine disposisi/amplop and SIMAN tickets.
 *
 * One alarm fires runPollCycle() every 5 min. Each per-source poller:
 *   1. Skips if disabled, no token, or (SIMAN) no role context selected
 *   2. Fetches the latest list page
 *   3. Diffs returned IDs against the persisted seen-set
 *   4. On first run for a source, just records IDs (priming) without notifying
 *   5. On subsequent runs, fires a chrome.notification per truly-new item
 *      (batching when 2+ arrive in the same cycle)
 *
 * Click → opens the user's Nadine/SIMAN inbox in a new tab.
 */
import * as nadineClient from "../nadine-client";
import * as simanClient from "../siman-client";
import * as tokenStore from "../token-store";
import * as simanStore from "../siman-store";
import * as state from "../state";
import * as notifStore from "../notif-store";
import * as seenStore from "../notif-seen-store";
import type { NotifSource, NotificationSettings } from "@/shared/types";
import type { SimanPenetapan } from "@/shared/siman-types";
import { debugLog, safeErrorMessage } from "@/shared/logging";

const ICON_URL = chrome.runtime.getURL("src/icons/icon-128.png");

const NADINE_INBOX_URL = "https://satu.kemenkeu.go.id/nadine/";
const SIMAN_DAFTAR_URL = "https://siman.kemenkeu.go.id/pengelolaan/penetapan-permohonan";

interface NewItem {
  id: string;
  title: string;     // perihal / deskripsi
  context?: string;  // noNd / noTiket
}

// --- Public: orchestrator called by the alarm ---

export async function runPollCycle(): Promise<void> {
  const settings = notifStore.get();
  const nadineToken = !!tokenStore.getToken().token;
  const simanRole = !!simanStore.getSimanToken().role;
  console.log("[asguard][notif] cycle start", {
    settings,
    nadineToken,
    simanRole,
  });
  await Promise.allSettled([
    settings.disposisi ? pollDisposisi() : Promise.resolve(),
    settings.amplop ? pollAmplop() : Promise.resolve(),
    settings.siman ? pollSiman() : Promise.resolve(),
  ]);
  console.log("[asguard][notif] cycle end");
}

// --- Per-source pollers ---

async function pollDisposisi(): Promise<void> {
  if (!tokenStore.getToken().token) {
    console.log("[asguard][notif] disposisi: skipped (no Nadine token)");
    return;
  }
  try {
    const raw = await nadineClient.getMejakuDisposisi(50);
    const items = raw.map(toNadineNewItem).filter((i): i is NewItem => i !== null);
    console.log("[asguard][notif] disposisi: fetched", { rawLen: raw.length, parsedLen: items.length, sampleKeys: raw[0] ? Object.keys(raw[0]) : null });
    await emit("disposisi", items, "Disposisi baru");
  } catch (e) {
    console.error("[asguard][notif] disposisi error", safeErrorMessage(e));
  }
}

async function pollAmplop(): Promise<void> {
  if (!tokenStore.getToken().token) {
    console.log("[asguard][notif] amplop: skipped (no Nadine token)");
    return;
  }
  try {
    const raw = await nadineClient.getMejakuAmplop(50);
    const items = raw.map(toNadineNewItem).filter((i): i is NewItem => i !== null);
    console.log("[asguard][notif] amplop: fetched", { rawLen: raw.length, parsedLen: items.length, sampleKeys: raw[0] ? Object.keys(raw[0]) : null });
    await emit("amplop", items, "Amplop baru");
  } catch (e) {
    console.error("[asguard][notif] amplop error", safeErrorMessage(e));
  }
}

async function pollSiman(): Promise<void> {
  const { role } = simanStore.getSimanToken();
  if (!role) {
    console.log("[asguard][notif] siman: skipped (no role context)");
    return;
  }
  try {
    const { data } = await simanClient.getPenetapanList(
      role,
      20,
      0,
      undefined,
      undefined,
      state.capturedPenetapanBody ?? undefined,
    );
    const items = data.map(toSimanNewItem).filter((i): i is NewItem => i !== null);
    console.log("[asguard][notif] siman: fetched", { rawLen: data.length, parsedLen: items.length });
    await emit("siman", items, "Tiket SIMAN baru");
  } catch (e) {
    console.error("[asguard][notif] siman error", safeErrorMessage(e));
  }
}

// --- Item shape adapters ---

function toNadineNewItem(raw: nadineClient.MejakuItem): NewItem | null {
  const id = raw.NdId == null ? "" : String(raw.NdId);
  if (!id) return null;
  return {
    id,
    title: typeof raw.Perihal === "string" && raw.Perihal.trim() ? raw.Perihal.trim() : "(tanpa perihal)",
    context: typeof raw.NoNd === "string" ? raw.NoNd : undefined,
  };
}

function toSimanNewItem(raw: SimanPenetapan): NewItem | null {
  const id = raw.noTiket;
  if (!id) return null;
  const desc = (raw.deskripsi ?? "").trim() || raw.tipe || "(tanpa deskripsi)";
  return { id, title: desc, context: raw.noTiket };
}

// --- Diff + notify (priming on first run) ---

async function emit(source: NotifSource, items: NewItem[], sourceLabel: string): Promise<void> {
  const ids = items.map((i) => i.id);

  if (!seenStore.isPrimed(source)) {
    // First run for this source — record everything as seen, fire nothing
    await seenStore.markSeen(source, ids);
    console.log("[asguard][notif] primed", { source, count: ids.length });
    return;
  }

  const newIds = seenStore.diffNew(source, ids);
  console.log("[asguard][notif] diff", { source, current: ids.length, new: newIds.length });
  if (newIds.length === 0) return;

  const newItems = items.filter((i) => newIds.includes(i.id));
  await fire(source, newItems, sourceLabel);
  await seenStore.markSeen(source, newIds);
}

async function fire(source: NotifSource, items: NewItem[], sourceLabel: string): Promise<void> {
  if (items.length === 1) {
    const it = items[0];
    await createNotification(`${source}:${it.id}`, {
      title: sourceLabel,
      message: it.title,
      contextMessage: it.context ?? "",
    });
    return;
  }

  // 2+ items — collapse to one notification to avoid OS notification spam
  const previewTitles = items.slice(0, 2).map((i) => i.title).join("; ");
  const message = items.length > 2 ? `${previewTitles}…` : previewTitles;
  const id = `${source}:batch:${Date.now()}`;
  await createNotification(id, {
    title: `${items.length} ${sourceLabel.toLowerCase()}`,
    message,
  });
}

function createNotification(
  notificationId: string,
  opts: { title: string; message: string; contextMessage?: string },
): Promise<void> {
  return new Promise((resolve) => {
    chrome.notifications.create(
      notificationId,
      {
        type: "basic",
        iconUrl: ICON_URL,
        title: opts.title,
        message: opts.message,
        contextMessage: opts.contextMessage,
        priority: 2,
        requireInteraction: true,
      },
      (id) => {
        const err = chrome.runtime.lastError;
        if (err) {
          console.error("[asguard][notif] create FAILED", { notificationId, err: err.message, iconUrl: ICON_URL });
        } else {
          console.log("[asguard][notif] created", { id });
        }
        resolve();
      },
    );
  });
}

// --- Click → open inbox ---

function urlForNotificationId(id: string): string | null {
  if (id.startsWith("disposisi:") || id.startsWith("amplop:")) return NADINE_INBOX_URL;
  if (id.startsWith("siman:")) return SIMAN_DAFTAR_URL;
  return null;
}

let _clickListenerWired = false;

export function setupNotificationListeners(): void {
  if (_clickListenerWired) return;
  _clickListenerWired = true;
  chrome.notifications.onClicked.addListener((notificationId) => {
    const url = urlForNotificationId(notificationId);
    if (!url) return;
    chrome.tabs.create({ url, active: true }).catch(() => {});
    chrome.notifications.clear(notificationId);
  });

  // Diagnostic helpers — call from the service-worker DevTools console.
  // Usage:
  //   asguardDebug.poll()                          → trigger one cycle now
  //   asguardDebug.testNotification()              → fire a test notification immediately
  //   asguardDebug.resetSeen("disposisi"|"amplop"|"siman")  → re-prime that source
  //   asguardDebug.simulateNew("disposisi", 1)     → drop N most recent seen IDs so the next poll fires
  (globalThis as unknown as { asguardDebug: unknown }).asguardDebug = {
    poll: () => runPollCycle(),
    testNotification: () =>
      createNotification("debug:test", {
        title: "Asguard test",
        message: "Notifikasi berfungsi!",
        contextMessage: "diagnostic",
      }),
    resetSeen: (source: NotifSource) => seenStore.reset(source),
    simulateNew: async (source: NotifSource, count = 1) => {
      const dropped = await seenStore.debugForgetRecent(source, count);
      console.log(`[asguard][notif] simulateNew dropped ${dropped} from ${source}; run asguardDebug.poll() to fire`);
    },
  };
}

// --- Router handlers (notif/settings/get|set) ---

export async function handleNotifSettingsGet(sendResponse: (r: unknown) => void): Promise<void> {
  sendResponse({ ok: true, data: notifStore.get() });
}

export async function handleNotifSettingsSet(
  raw: { settings: Partial<NotificationSettings> },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  const before = notifStore.get();
  const after = await notifStore.save(raw.settings);

  // When a source toggles off→on, reset its seen-set so the next poll
  // re-primes (preventing flood-notification of items that arrived while disabled).
  await maybeResetOnReenable(before, after, "disposisi");
  await maybeResetOnReenable(before, after, "amplop");
  await maybeResetOnReenable(before, after, "siman");

  sendResponse({ ok: true, data: after });
}

async function maybeResetOnReenable(
  before: NotificationSettings,
  after: NotificationSettings,
  source: NotifSource,
): Promise<void> {
  if (!before[source] && after[source]) {
    await seenStore.reset(source);
    debugLog("[asguard] notif source re-enabled, seen-set reset", { source });
  }
}

// --- External: backup/import reload hook ---

export async function reloadSettings(): Promise<void> {
  await notifStore.restore();
}

// --- External: SIMAN role-change reset hook ---

export async function onSimanRoleChanged(): Promise<void> {
  // Different role = different ticket scope. Reset so the next poll re-primes.
  await seenStore.reset("siman");
  debugLog("[asguard] siman role changed, notif seen-set reset");
}
