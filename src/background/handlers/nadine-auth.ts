/** Nadine token capture, page tracking, PDF capture, naskah creation interception, and API proxies. */
import * as store from "../token-store";
import * as nadine from "../nadine-client";
import { NadineNoTokenError, NadineHttpError } from "../nadine-client";
import * as simanClient from "../siman-client";
import * as state from "../state";
import { debugLog, safeErrorMessage } from "@/shared/logging";

export async function handleTokenCapture(
  raw: { token: string; origin: string },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  const changed = await store.setToken(raw.token, raw.origin);
  if (changed) {
    debugLog("[asguard] Nadine token captured", { host: new URL(raw.origin).hostname });
    state.broadcastState();
    // Fire-and-forget: extract NIP + Nama from /Auth/me, then check license
    (async () => {
      try {
        const me = await nadine.getAuthMe();
        const d = ((me as Record<string, unknown>).Data ?? {}) as Record<string, unknown>;
        const nip = String(d.Nip ?? d.nip ?? "").trim();
        const fullname = String(d.Nama ?? d.nama ?? d.Name ?? "").trim();
        if (/^\d{9,18}$/.test(nip)) {
          await store.setNipFromMe(nip, fullname);
          await state.refreshLicense(nip, fullname);
          state.broadcastState();
        }
      } catch (e) {
        // Fallback: try JWT payload
        try {
          const payload = simanClient.decodeJwtPayload(raw.token);
          const nipJwt = String(payload.nip ?? payload.username ?? "").trim();
          if (/^\d{9,18}$/.test(nipJwt)) {
            const nameJwt = String(payload.fullname ?? payload.nama ?? "");
            await store.setNipFromMe(nipJwt, nameJwt);
            await state.refreshLicense(nipJwt, nameJwt);
            state.broadcastState();
          }
        } catch { /* ignore */ }
        console.warn("[asguard] Auth/me failed, used JWT fallback:", safeErrorMessage(e));
      }
    })();
  }
  sendResponse({ ok: true });
}

export async function handlePageChanged(
  raw: { ctx: { url: string; page: { kind: string } } },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  const pageChanged = await store.setPage(raw.ctx as Parameters<typeof store.setPage>[0]);
  // NOTE: We intentionally do NOT auto-switch activeTab based on which website
  // the user browses. Doing so caused the sidepanel to forcibly switch tabs and
  // abort in-progress SIMAN operations whenever the user refreshed Nadine.
  // The active tab is purely user-controlled via tab bar clicks.
  if (pageChanged) state.broadcastState();
  sendResponse({ ok: true });
}

export async function handleViewingNdId(
  raw: { ndId: string },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  const changed = await store.setCurrentNdId(raw.ndId);
  if (changed) state.broadcastState();
  sendResponse({ ok: true });
}

export async function handlePdfCaptured(
  raw: { base64: string; url: string; size: number },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  const currentNdId = store.getCurrentNdId();
  if (currentNdId) {
    state.capturedPdfs.set(currentNdId, {
      base64: raw.base64,
      url: raw.url,
      capturedAt: Date.now(),
    });
    debugLog("[asguard] stored captured PDF", { hasNdId: true, size: raw.size });
  } else {
    state.capturedPdfs.set("__latest__", {
      base64: raw.base64,
      url: raw.url,
      capturedAt: Date.now(),
    });
    debugLog("[asguard] stored captured PDF", { hasNdId: false, size: raw.size });
  }
  sendResponse({ ok: true });
}

export async function handleNaskahCreated(
  raw: { payload: Record<string, unknown>; url: string },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  state.setPendingPayload(raw.payload);
  debugLog("[asguard] captured CreateNaskahPayload, notifying sidepanel");
  state.broadcastState();
  sendResponse({ ok: true });
}

export async function handleTokenClear(sendResponse: (r: unknown) => void): Promise<void> {
  await store.clearToken();
  sendResponse(state.snapshot());
}

export async function handleApiCounts(sendResponse: (r: unknown) => void): Promise<void> {
  sendResponse(await state.runApi(() => nadine.getCounts()));
}

export async function handleApiNaskah(
  raw: { ndId: string },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  sendResponse(await state.runApi(() => nadine.getNaskahDetail(raw.ndId)));
}

export async function handleApiMe(sendResponse: (r: unknown) => void): Promise<void> {
  sendResponse(await state.runApi(() => nadine.getAuthMe()));
}

export async function handleSwitchRole(
  raw: { unitData: Record<string, unknown> },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  sendResponse(await state.runApi(() => nadine.switchRole(raw.unitData)));
}

/** Build Nadine error message for port handlers. */
export function nadineErrMsg(e: unknown): string {
  if (e instanceof NadineNoTokenError) {
    return "Sesi Nadine kadaluarsa — buka ulang Nadine lalu refresh.";
  }
  if (e instanceof NadineHttpError) {
    return `Gagal: ${e.message}`;
  }
  return `Error: ${e instanceof Error ? e.message : String(e)}`;
}
