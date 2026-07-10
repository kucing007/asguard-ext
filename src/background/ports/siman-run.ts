/** SIMAN pengelolaan run port handler — variable resolution, ND upload, NP creation. */
import * as nadine from "../nadine-client";
import * as simanStore from "../siman-store";
import * as simanClient from "../siman-client";
import * as state from "../state";
import { debugLog, safeErrorMessage } from "@/shared/logging";
import type { SimanRunPortRequest, SimanRunProgressMsg } from "@/shared/siman-types";

export function setupSimanRun(port: chrome.runtime.Port): void {
  port.onMessage.addListener(async (msg: SimanRunPortRequest) => {
    function send(m: SimanRunProgressMsg) {
      try {
        port.postMessage(m);
      } catch {
        /* port closed */
      }
    }

    if (msg.type === "siman/run") {
      const { role } = simanStore.getSimanToken();
      if (!role) {
        send({ step: "error", status: "error", message: "No SIMAN role selected" });
        return;
      }
      const template = await simanStore.getSimanTemplateById(msg.templateId);
      if (!template) {
        send({ step: "error", status: "error", message: "Template tidak ditemukan" });
        return;
      }
      try {
        send({ step: "Mengambil data permohonan…", status: "running" });
        const variables = await simanClient.buildVariableMap(
          role,
          msg.idPengelolaan,
          msg.idTipePengelolaan,
        );
        const merged: Record<string, string> = { ...variables };
        const sameSatker = !!template.savedKdSatker && template.savedKdSatker === variables.kd_satker;
        if (sameSatker) {
          for (const [k, v] of Object.entries(template.savedVariables)) {
            if (v && !variables[k]) merged[k] = v;
          }
        }
        const customVarKeys = new Set(
          (template.customVars ?? [])
            .map((cv: { outputKey: string }) => cv.outputKey)
            .filter(Boolean),
        );
        for (const key of customVarKeys) {
          if (!merged[key as string]) merged[key as string] = "__custom__";
        }
        for (const [ph, varKey] of Object.entries(template.mapping)) {
          if (varKey === "__ask__") {
            const effectiveKey = ph.replace(/^\{|\}$/g, "");
            if (!variables[effectiveKey]) merged[effectiveKey] = "";
          }
        }
        const missing = Object.entries(template.mapping)
          .map(([ph, varKey]) => (varKey === "__ask__" ? ph.replace(/^\{|\}$/g, "") : varKey))
          .filter((key) => !merged[key] || merged[key] === "");
        for (const key of customVarKeys) {
          if (merged[key as string] === "__custom__") delete merged[key as string];
        }
        send({ step: "variables", status: "done", variables: merged, message: missing.join(",") });
      } catch (e) {
        send({ step: "error", status: "error", message: e instanceof Error ? e.message : String(e) });
      }
    }

    if (msg.type === "siman/upload-nd") {
      try {
        send({ step: "Menyiapkan dokumen…", status: "running" });
        const { docId } = await prepareNDForUpload(msg.ndId);

        send({ step: "Mengunggah konsep ND…", status: "running" });
        const ndBytes = Uint8Array.from(atob(msg.ndDocxBase64), (c) => c.charCodeAt(0));
        await uploadNDWithRetry(msg.ndId, msg.ndFilename, ndBytes);

        if (docId) {
          send({ step: "Sync dokumen…", status: "running" });
          await state.sleep(2000);
          for (let i = 0; i < 5; i++) {
            try {
              await nadine.syncDocKonsep(msg.ndId, docId);
              break;
            } catch {
              if (i < 4) await state.sleep(i === 0 ? 2000 : 3000);
            }
          }
        }

        debugLog("[asguard] upload-nd NP check", {
          hasNpDocx: !!msg.npDocxBase64,
          hasNpFilename: !!msg.npFilename,
          hasNpPenandatangan: !!msg.npPenandatangan,
        });
        if (msg.npDocxBase64 && msg.npFilename && msg.npPenandatangan) {
          const perihal = String(
            msg.variables.perihal_sk || msg.variables.deskripsi || msg.variables.nama_tipe_pengelolaan || "",
          );
          await handleNPUpload(msg.ndId, perihal, msg.npDocxBase64, msg.npFilename, msg.npPenandatangan, msg.templateId, send);
        }

        await simanStore.updateSimanTemplate(msg.templateId, {
          savedVariables: msg.variables,
          savedKdSatker: msg.variables.kd_satker ?? "",
        });
        send({ step: "done", status: "done", ndId: msg.ndId });
      } catch (e) {
        send({ step: "error", status: "error", message: simanErrMsg(e) });
      }
    }

    if (msg.type === "siman/run-render") {
      try {
        const template = await simanStore.getSimanTemplateById(msg.templateId);
        const basePayload = (template?.nadinePayload ?? {}) as Record<string, unknown>;

        const perihalKey = template?.perihalVarKey ?? "perihal_sk";
        const perihal = String(
          msg.variables[perihalKey] ||
          msg.variables.perihal_sk ||
          msg.variables.deskripsi ||
          msg.variables.nama_tipe_pengelolaan ||
          basePayload.Perihal ||
          msg.variables.no_tiket ||
          "",
        );
        const payload = { ...basePayload, Perihal: perihal };

        send({ step: "Membuat naskah di Nadine…", status: "running" });
        const result = await nadine.createNaskah(payload);
        if (!result.Success) {
          send({ step: "error", status: "error", message: result.Error || result.Message || "Gagal membuat naskah" });
          return;
        }
        const ndId = result.Data?.KonsepNaskah?.DataNd?.NdId;
        if (!ndId) {
          send({ step: "error", status: "error", message: "NdId tidak ditemukan dalam response" });
          return;
        }

        send({ step: "Menyiapkan dokumen…", status: "running" });
        const { docId: ndDocId } = await prepareNDForUpload(ndId);

        send({ step: "Mengunggah konsep ND…", status: "running" });
        const ndBytes = Uint8Array.from(atob(msg.ndDocxBase64), (c) => c.charCodeAt(0));
        await uploadNDWithRetry(ndId, msg.ndFilename, ndBytes);

        if (ndDocId) {
          send({ step: "Sync dokumen…", status: "running" });
          await state.sleep(2000);
          for (let i = 0; i < 5; i++) {
            try {
              await nadine.syncDocKonsep(ndId, ndDocId);
              break;
            } catch {
              if (i < 4) await state.sleep(i === 0 ? 2000 : 3000);
            }
          }
        }

        if (msg.npDocxBase64 && msg.npFilename && msg.npPenandatangan) {
          await handleNPUpload(ndId, perihal, msg.npDocxBase64, msg.npFilename, msg.npPenandatangan, msg.templateId, send);
        }

        await simanStore.updateSimanTemplate(msg.templateId, {
          savedVariables: msg.variables,
          savedKdSatker: msg.variables.kd_satker ?? "",
        });
        send({ step: "done", status: "done", ndId });
      } catch (e) {
        send({ step: "error", status: "error", message: simanErrMsg(e) });
      }
    }
  });
}

// --- Internal helpers ---

/** Prepare an ND for upload by getting detail and generating edit link. */
async function prepareNDForUpload(ndId: number): Promise<{ docId: string | null; editPayload: Record<string, unknown> }> {
  let docId: string | null = null;
  let editPayload: Record<string, unknown> = {};

  for (const tipedata of ["Konsep", "", "KonsepNaskah"]) {
    try {
      const detail = await nadine.getNaskahDetail(ndId, tipedata);
      const d = ((detail as { Data?: unknown }).Data as Record<string, unknown>) ?? {};
      const raw = String(d.Id ?? d.id ?? "");
      if (raw && raw !== "undefined" && raw !== "null") {
        docId = raw;
        editPayload = d;
        break;
      }
    } catch {
      /* try next tipedata */
    }
  }

  if (docId) {
    for (let retry = 0; retry < 5; retry++) {
      try {
        const res = await nadine.generateEditLink(ndId, docId, editPayload);
        if ((res as { Success?: boolean }).Success) break;
      } catch {
        /* retry */
      }
      if (retry < 4) await new Promise<void>((r) => setTimeout(r, 2000));
    }
    await new Promise<void>((r) => setTimeout(r, 1000));
  }

  return { docId, editPayload };
}

/** Upload ND docx with 5-retry logic. */
async function uploadNDWithRetry(ndId: number, filename: string, bytes: Uint8Array): Promise<void> {
  let lastErr: unknown;
  for (let retry = 0; retry < 5; retry++) {
    if (retry > 0) await new Promise<void>((r) => setTimeout(r, 2000));
    try {
      const res = await nadine.uploadKonsepFile(ndId, filename, bytes);
      if ((res as { Success?: boolean }).Success !== false) return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("Upload ND gagal setelah 5 percobaan");
}

/**
 * Pull the E3 atasan unit out of a `DetailKonsepByNdId` response Data.
 * The naskah's *signer* — `Data.DataNd.PengirimND.Penandatangan` — is the Kepala Kantor
 * (E3) the nota dinas is addressed to, i.e. exactly the unit the NP `Tujuan` must be.
 */
function extractTujuan(raw: unknown): Record<string, unknown> | null {
  const d = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | undefined;
  const pengirimND = (d?.DataNd as Record<string, unknown> | undefined)?.PengirimND as
    | Record<string, unknown>
    | undefined;
  const t = (pengirimND?.Penandatangan ?? d?.Tujuan) as Record<string, unknown> | undefined;
  return t && Number(t.IdOrganisasi ?? 0) > 0 ? t : null;
}

/**
 * Resolve the Nota Pengantar `Tujuan` = the E3 atasan the nota dinas is addressed to.
 *
 * The naskah's *own* Tujuan lives in the `?tipedata=Konsep` konsep detail — it is the
 * authoritative E3 unit (IdOrganisasi, NamaOrganisasiFull, KdSatker, …). We fetch that
 * tipedata explicitly because `prepareNDForUpload` breaks its loop on the first tipedata
 * that yields a docId, which is often NOT `Konsep` and carries an empty `Tujuan: {}`.
 */
async function resolveNpTujuan(
  ndId: number,
  penandatanganUnit: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  // Primary: the naskah's own Tujuan from the Konsep detail.
  for (const tipedata of ["Konsep", "KonsepNaskah"]) {
    try {
      const detail = await nadine.getNaskahDetail(ndId, tipedata);
      const t = extractTujuan((detail as { Data?: unknown }).Data);
      if (t) return t;
    } catch {
      /* try next tipedata */
    }
  }

  // Fallback: look the induk (E3 parent) up in the RefUnits tree by penandatangan's
  // KodeIndukorganisasi (works only when the acting role can see it).
  const indukKode = String(penandatanganUnit.KodeIndukorganisasi ?? "").trim();
  if (!indukKode) return null;
  const findByKode = (
    nodes: Record<string, unknown>[] | undefined,
  ): Record<string, unknown> | null => {
    for (const n of nodes ?? []) {
      if (String(n.KodeOrganisasi ?? "") === indukKode) return n;
      const child = findByKode(n.Children as Record<string, unknown>[] | undefined);
      if (child) return child;
    }
    return null;
  };
  try {
    const tree = await nadine.getRefUnitsTree(indukKode);
    const hit = findByKode(tree.Data as Record<string, unknown>[] | undefined);
    if (hit && Number(hit.IdOrganisasi ?? 0) > 0) return hit;
  } catch {
    /* give up */
  }
  return null;
}

/** Full NP create + upload flow. */
async function handleNPUpload(
  ndId: number,
  perihal: string,
  npDocxBase64: string,
  npFilename: string,
  penandatanganUnit: Record<string, unknown>,
  templateId: string,
  send: (m: SimanRunProgressMsg) => void,
): Promise<void> {
  let npId: string | null = null;
  try {
    const npResponse = await nadine.getNotaPengantar(ndId);
    const npRaw = (npResponse as { Data?: unknown }).Data;
    const npData = Array.isArray(npRaw) ? npRaw[0] : npRaw;
    npId = ((npData as Record<string, unknown> | undefined)?.Id as string | undefined) ?? null;
  } catch {
    /* no existing NP */
  }

  if (!npId) {
    // NP Tujuan = the E3 atasan of the naskah (its konsep signer). Resolve it from the
    // Konsep detail; if it can't be found, ABORT rather than POST an empty `Tujuan: {}`
    // (which Nadine silently drops, leaving an NP with no addressee).
    const tujuan = await resolveNpTujuan(ndId, penandatanganUnit);
    debugLog("[asguard] SIMAN NP resolved Tujuan:", tujuan);
    if (!tujuan || Number(tujuan.IdOrganisasi ?? 0) <= 0) {
      throw new Error(
        "Tujuan Nota Pengantar belum dipilih — penandatangan (atasan) naskah dinas tidak ditemukan. " +
          "Isi penandatangan naskah di Nadine lalu ulangi.",
      );
    }

    await simanStore.updateSimanTemplate(templateId, { npPenandatangan: penandatanganUnit });

    const npPayload = {
      Perihal: perihal,
      Penandatangan: [penandatanganUnit],
      Pengirim: penandatanganUnit,
      Tujuan: tujuan,
    };

    debugLog("[asguard] SIMAN NP payload:", npPayload);
    send({ step: "Membuat Nota Pengantar…", status: "running" });
    try {
      const createResp = await nadine.createNotaPengantar(ndId, npPayload);
      debugLog("[asguard] SIMAN NP create response:", createResp);
    } catch (e) {
      console.warn("[asguard] createNotaPengantar warn:", simanErrMsg(e));
    }

    for (let attempt = 0; attempt < 15; attempt++) {
      await new Promise<void>((r) => setTimeout(r, 3000));
      try {
        const npResponse = await nadine.getNotaPengantar(ndId);
        const npRaw = (npResponse as { Data?: unknown }).Data;
        const npData = Array.isArray(npRaw) ? npRaw[0] : npRaw;
        npId = ((npData as Record<string, unknown> | undefined)?.Id as string | undefined) ?? null;
        if (npId) break;
      } catch {
        /* retry */
      }
    }
  }

  if (!npId) throw new Error("Nota Pengantar gagal dibuat: ID tidak muncul dalam 45s");
  send({ step: "Mengunggah Nota Pengantar…", status: "running" });
  const npBytes = Uint8Array.from(atob(npDocxBase64), (c) => c.charCodeAt(0));
  await nadine.uploadNotaPengantarFile(ndId, npId, npFilename, npBytes);
}

function simanErrMsg(e: unknown): string {
  if (e && typeof e === "object" && "body" in e && "message" in e) {
    const body = String((e as Record<string, unknown>).body ?? "");
    const msg = String((e as Record<string, unknown>).message ?? "");
    return `${msg}${body ? ` — ${body.slice(0, 200)}` : ""}`;
  }
  return safeErrorMessage(e);
}
