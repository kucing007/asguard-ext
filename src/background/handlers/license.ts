/** License check and cache handlers. */
import * as state from "../state";
import * as store from "../token-store";
import * as simanStore from "../siman-store";
import * as licenseClient from "../license-client";

export async function handleLicenseCheck(sendResponse: (r: unknown) => void): Promise<void> {
  const nip = store.getToken().nip ?? simanStore.getSimanToken().nip;
  if (!nip) {
    sendResponse({ ok: false, error: "NIP tidak diketahui" });
    return;
  }
  await state.refreshLicense(nip);
  state.broadcastState();
  sendResponse({ ok: true, data: state.licenseStatus });
}

export async function handleLicenseClearCache(sendResponse: (r: unknown) => void): Promise<void> {
  await licenseClient.clearLicenseCache();
  state.setLicenseStatus(null);
  state.broadcastState();
  sendResponse({ ok: true });
}
