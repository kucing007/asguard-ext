/**
 * Background service worker entry point.
 * Initializes state, sets up keepalive, and delegates to the router.
 */
import * as store from "./token-store";
import * as simanStore from "./siman-store";
import * as licenseClient from "./license-client";
import * as updateClient from "./update-client";
import * as state from "./state";
import { setupRouter } from "./router";
import { debugLog, safeErrorMessage } from "@/shared/logging";

// --- Session keepalive via chrome.alarms ---

const KEEPALIVE_ALARM = "asguard.keepalive";

function setupKeepalive() {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  const { token } = store.getToken();
  if (!token) return;
  fetch("https://service.kemenkeu.go.id/nadine-nanas/auth/now", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  }).catch(() => {});
});

// --- Init ---

chrome.runtime.onInstalled.addListener(() => {
  console.log("[asguard] installed");
  setupKeepalive();
});

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("[asguard] setPanelBehavior failed", safeErrorMessage(err)));

const _ready = (async () => {
  await store.restore();
  await simanStore.restoreSimanToken();
  await state.loadSettings();
  setupKeepalive();
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
