/**
 * Background service worker entry point.
 * Initializes state, sets up keepalive, and delegates to the router.
 */
import * as store from "./token-store";
import * as simanStore from "./siman-store";
import * as licenseClient from "./license-client";
import * as updateClient from "./update-client";
import * as state from "./state";
import * as notifStore from "./notif-store";
import * as seenStore from "./notif-seen-store";
import * as notifications from "./handlers/notifications";
import { setupRouter } from "./router";
import { debugLog, safeErrorMessage } from "@/shared/logging";

// --- Periodic alarms ---

const KEEPALIVE_ALARM = "asguard.keepalive";
const POLL_ALARM = "asguard.poll-watcher";

function setupAlarms() {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: 1 });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  // Critical: wait for store.restore() / seenStore.restore() / notifStore.restore() to complete
  // before dispatching. On a cold SW wake-up, the alarm event can fire before _ready resolves,
  // and a poll that runs against the empty in-memory seen-set would re-prime (and silently lose
  // every "new item" notification on every browser restart).
  await _ready;
  if (alarm.name === KEEPALIVE_ALARM) {
    const { token } = store.getToken();
    if (!token) return;
    fetch("https://service.kemenkeu.go.id/nadine-nanas/auth/now", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    }).catch(() => {});
    return;
  }
  if (alarm.name === POLL_ALARM) {
    notifications.runPollCycle().catch(() => {});
    return;
  }
});

notifications.setupNotificationListeners();

// --- Init ---

chrome.runtime.onInstalled.addListener(() => {
  console.log("[asguard] installed");
  setupAlarms();
});

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("[asguard] setPanelBehavior failed", safeErrorMessage(err)));

const _ready = (async () => {
  await store.restore();
  await simanStore.restoreSimanToken();
  await state.loadSettings();
  await notifStore.restore();
  await seenStore.restore();
  setupAlarms();
  // Restore cached license and re-check if NIP is known
  state.setLicenseStatus(await licenseClient.restoreCachedLicense());
  const knownNip = store.getToken().nip ?? simanStore.getSimanToken().nip;
  debugLog("[asguard] boot", { hasKnownNip: !!knownNip, cachedLicense: state.licenseStatus?.status ?? "none" });
  if (knownNip) {
    const knownName = store.getToken().fullname ?? simanStore.getSimanToken().fullname ?? undefined;
    state.refreshLicense(knownNip, knownName).then(() => state.broadcastState()).catch(() => {});
  }
  // Check for extension updates (fire-and-forget)
  updateClient.shouldCheck().then((yes) => { if (yes) updateClient.checkForUpdate(); });
})();

// Wire up the router
setupRouter(_ready);

export {};
