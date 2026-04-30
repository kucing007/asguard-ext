/** SIMAN panel request handlers — roles, penetapan, templates, state management. */
import * as simanStore from "../siman-store";
import * as simanClient from "../siman-client";
import * as state from "../state";
import type { SimanRole } from "@/shared/siman-types";

export async function handleSimanState(sendResponse: (r: unknown) => void): Promise<void> {
  sendResponse(state.snapshot());
}

export async function handleSimanTokenClear(sendResponse: (r: unknown) => void): Promise<void> {
  await simanStore.clearSimanToken();
  state.setCapturedPenetapanBody(null);
  state.broadcastState();
  sendResponse(state.snapshot());
}

export async function handleSimanPenetapanBody(
  raw: { body: Record<string, unknown> },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  state.setCapturedPenetapanBody(raw.body as Record<string, unknown>);
  console.log("[asguard] stored captured penetapan body, kpknl:", state.capturedPenetapanBody?.filter_id);
  sendResponse({ ok: true });
}

export async function handleSimanGetRoles(sendResponse: (r: unknown) => void): Promise<void> {
  const { userId } = simanStore.getSimanToken();
  if (!userId) {
    sendResponse({ ok: false, error: "No SIMAN token" });
    return;
  }
  try {
    const roles = await simanClient.getRoles(userId);
    sendResponse({ ok: true, data: roles });
  } catch (e) {
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function handleSimanSetRole(
  raw: { role: SimanRole; idKpknl: string; idKanwil: string },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  const { fullname, userId } = simanStore.getSimanToken();
  if (!userId) {
    sendResponse({ ok: false, error: "No SIMAN token" });
    return;
  }
  try {
    const idUserDetail = String(raw.role.id_user_detail ?? userId ?? "");
    const filterData = await simanClient.getRoleFilter(idUserDetail);
    const { token, context } = await simanClient.setRole(raw.role, filterData, fullname ?? "");
    await simanStore.setSimanRole(context, token);
    state.broadcastState();
    sendResponse(state.snapshot());
  } catch (e) {
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function handleSimanGetTipePengelolaan(sendResponse: (r: unknown) => void): Promise<void> {
  try {
    const data = await simanClient.getTipePengelolaan();
    sendResponse({ ok: true, data });
  } catch (e) {
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function handleSimanGetPenetapanList(
  raw: { limit: number; offset: number; statusFilter?: string; idTipe?: string },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  const { role } = simanStore.getSimanToken();
  if (!role) {
    sendResponse({ ok: false, error: "No SIMAN role selected" });
    return;
  }
  console.log("[asguard] penetapan role context:", JSON.stringify(role));
  console.log("[asguard] captured body available:", !!state.capturedPenetapanBody);
  try {
    const data = await simanClient.getPenetapanList(
      role,
      raw.limit,
      raw.offset,
      raw.statusFilter,
      raw.idTipe,
      state.capturedPenetapanBody ?? undefined,
    );
    sendResponse({ ok: true, data });
  } catch (e) {
    console.error("[asguard] penetapan error:", e);
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function handleSimanGetPenetapanDetail(
  raw: { noTiket: string; idPengelolaan?: string },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  try {
    const id = raw.idPengelolaan ?? raw.noTiket;
    const data = await simanClient.getPermohonanDetail(id);
    sendResponse({ ok: true, data });
  } catch (e) {
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function handleSimanGetKelengkapan(
  raw: { idPengelolaan: string },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  try {
    const data = await simanClient.getKelengkapanDokumen(raw.idPengelolaan);
    sendResponse({ ok: true, data });
  } catch (e) {
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function handleSimanGetDownloadToken(
  raw: { idPengelolaanDok: number; nmFile: string },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  try {
    const token = await simanClient.getDownloadToken(raw.idPengelolaanDok, raw.nmFile);
    const url = simanClient.getFileStreamUrl(token, raw.nmFile);
    sendResponse({ ok: true, token, url });
  } catch (e) {
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function handleSimanGetTemplates(sendResponse: (r: unknown) => void): Promise<void> {
  sendResponse({ ok: true, data: await simanStore.getAllSimanTemplates() });
}

export async function handleSimanSaveTemplate(
  raw: { template: Record<string, unknown> },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  sendResponse({ ok: true, data: await simanStore.saveSimanTemplate(raw.template as Parameters<typeof simanStore.saveSimanTemplate>[0]) });
}

export async function handleSimanTemplateUpdate(
  raw: { id: string; updates: Record<string, unknown> },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  sendResponse({ ok: true, data: await simanStore.updateSimanTemplate(raw.id, raw.updates as Parameters<typeof simanStore.updateSimanTemplate>[1]) });
}

export async function handleSimanDeleteTemplate(
  raw: { id: string },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  sendResponse({ ok: true, data: await simanStore.deleteSimanTemplate(raw.id) });
}

export async function handleSimanGetKanwilList(sendResponse: (r: unknown) => void): Promise<void> {
  try {
    sendResponse({ ok: true, data: await simanClient.getKanwilList() });
  } catch (e) {
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

export async function handleSimanGetKpknlList(sendResponse: (r: unknown) => void): Promise<void> {
  try {
    sendResponse({ ok: true, data: await simanClient.getKpknlList() });
  } catch (e) {
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
