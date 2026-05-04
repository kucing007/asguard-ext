/** Template CRUD, pending payload, and org-units handlers. */
import * as state from "../state";
import * as templateStore from "../template-store";
import * as nadine from "../nadine-client";
import { debugLog } from "@/shared/logging";
import type { NaskahTemplate } from "@/shared/types";

export async function handleTemplateList(sendResponse: (r: unknown) => void): Promise<void> {
  sendResponse({ ok: true, data: await templateStore.getAll() });
}

export async function handleTemplateGet(
  raw: { id: string },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  const t = await templateStore.getById(raw.id);
  sendResponse(t ? { ok: true, data: t } : { ok: false, error: "Not found" });
}

export async function handleTemplateSave(
  raw: { template: Omit<NaskahTemplate, "id" | "createdAt" | "updatedAt"> },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  const saved = await templateStore.save(raw.template);
  state.setPendingPayload(null);
  state.broadcastState();
  sendResponse({ ok: true, data: saved });
}

export async function handleTemplateUpdate(
  raw: { id: string; updates: Partial<NaskahTemplate> },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  const updated = await templateStore.update(raw.id, raw.updates);
  sendResponse(updated ? { ok: true, data: updated } : { ok: false, error: "Not found" });
}

export async function handleTemplateDelete(
  raw: { id: string },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  const deleted = await templateStore.remove(raw.id);
  sendResponse({ ok: true, data: deleted });
}

export async function handleTemplatePending(sendResponse: (r: unknown) => void): Promise<void> {
  sendResponse({ ok: true, data: state.pendingPayload });
}

export async function handleTemplateUnits(
  raw: { kodeOrganisasi: string; pengirimEselon: number },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  try {
    const authMe = await nadine.getAuthMe();
    const kodeOrg = authMe.Data?.CurrentUnit?.KodeOrganisasi ?? (raw.kodeOrganisasi as string | undefined) ?? "";
    debugLog("[asguard] template/units: resolved kodeOrg", { hasKodeOrg: !!kodeOrg });

    if (!kodeOrg) {
      sendResponse({ ok: false, error: "KodeOrganisasi tidak tersedia dari Auth/me" });
      return;
    }

    const tree = await nadine.getRefUnitsTree(kodeOrg);
    const allUnits = (tree.Data ?? []) as Record<string, unknown>[];
    const pengirimEselon = raw.pengirimEselon as number;
    const targetEselon = pengirimEselon + 1;
    const preferred = allUnits.filter((u) => (u.Eselon as number | undefined) === targetEselon);
    const fallback = allUnits.filter((u) => {
      const ue = u.Eselon as number | undefined;
      return ue !== undefined && ue > pengirimEselon && ue !== targetEselon;
    });
    const units = [...preferred, ...fallback].slice(0, 15);
    debugLog("[asguard] template/units filtered", { total: allUnits.length, filtered: units.length, targetEselon });
    sendResponse({ ok: true, data: units });
  } catch (e) {
    sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
