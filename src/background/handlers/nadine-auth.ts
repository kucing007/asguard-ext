/** Nadine token capture, page tracking, PDF capture, naskah creation interception, and API proxies. */
import * as store from "../token-store";
import * as nadine from "../nadine-client";
import { NadineNoTokenError, NadineHttpError } from "../nadine-client";
import * as simanClient from "../siman-client";
import * as state from "../state";

export async function handleTokenCapture(
  raw: { token: string; origin: string },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  const changed = await store.setToken(raw.token, raw.origin);
  if (changed) {
    console.log("[asguard] token captured from", new URL(raw.origin).hostname);
    state.broadcastState();
    // Fire-and-forget: extract NIP from JWT or /Auth/me, then check license
    (async () => {
      try {
        // Fast path: try JWT payload first
        const payload = simanClient.decodeJwtPayload(raw.token);
        const nipJwt = String(payload.nip ?? payload.username ?? "").trim();
        if (/^\d{9,18}$/.test(nipJwt)) {
          await store.setNipFromMe(nipJwt, String(payload.fullname ?? payload.nama ?? ""));
          await state.refreshLicense(nipJwt);
          state.broadcastState();
          return;
        }
        // Slow path: /Auth/me
        const me = await nadine.getAuthMe();
        const d = ((me as Record<string, unknown>).Data ?? {}) as Record<string, unknown>;
        const nip = String(d.Nip ?? d.nip ?? "").trim();
        const fullname = String(d.Nama ?? d.nama ?? d.Name ?? "").trim();
        if (/^\d{9,18}$/.test(nip)) {
          await store.setNipFromMe(nip, fullname);
          await state.refreshLicense(nip);
          state.broadcastState();
        }
      } catch (e) {
        console.warn("[asguard] NIP fetch failed:", e);
      }
    })();
  }
  sendResponse({ ok: true });
}

export async function handlePageChanged(
  raw: { ctx: { url: string; page: { kind: string } } },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  await store.setPage(raw.ctx as Parameters<typeof store.setPage>[0]);
  if ((raw.ctx as { page: { kind: string } }).page.kind === "siman") state.setActiveTab("siman");
  else if ((raw.ctx as { page: { kind: string } }).page.kind !== "other") state.setActiveTab("nadine");
  state.broadcastState();
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
    console.log(
      `[asguard] stored captured PDF for ndId=${currentNdId} (${raw.size} bytes from ${raw.url.slice(-60)})`,
    );
  } else {
    state.capturedPdfs.set("__latest__", {
      base64: raw.base64,
      url: raw.url,
      capturedAt: Date.now(),
    });
    console.log(`[asguard] stored captured PDF (no ndId yet, ${raw.size} bytes)`);
  }
  sendResponse({ ok: true });
}

export async function handleNaskahCreated(
  raw: { payload: Record<string, unknown>; url: string },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  state.setPendingPayload(raw.payload);
  console.log("[asguard] captured CreateNaskahPayload, notifying sidepanel");
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
