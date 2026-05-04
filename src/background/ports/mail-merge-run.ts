/** Mail merge batch runner port handler. */
import * as nadine from "../nadine-client";
import { NadineNoTokenError, NadineHttpError } from "../nadine-client";
import * as templateStore from "../template-store";
import * as state from "../state";
import { debugLog, safeErrorMessage } from "@/shared/logging";
import type { MailMergeRowMsg, MailMergeProgressMsg } from "@/shared/types";

export function setupMailMergeRun(port: chrome.runtime.Port): void {
  handleMailMergeRun(port);
}

async function handleMailMergeRun(port: chrome.runtime.Port): Promise<void> {
  const sendProgress = (m: MailMergeProgressMsg) => {
    try {
      port.postMessage(m);
    } catch {
      /* port closed */
    }
  };

  let templateId: string | null = null;
  let template: Awaited<ReturnType<typeof templateStore.getById>> = null;
  let mmPenandatanganUnit: Record<string, unknown> | null = null;
  let aborted = false;
  let success = 0;
  let failed = 0;
  let totalExpected = 0;
  let rowsProcessed = 0;
  const ndIds: number[] = [];

  port.onDisconnect.addListener(() => {
    aborted = true;
  });

  const processRow = async (msg: Extract<MailMergeRowMsg, { type: "mm/row" }>) => {
    if (aborted) return;

    const step = (s: string) => sendProgress({ type: "mm/row-step", index: msg.index, step: s });

    try {
      const payload = { ...msg.payload };

      // 1. Create naskah
      step("Membuat naskah dinas…");
      const result = await nadine.createNaskah(payload);
      if (!result.Success) {
        throw new Error(result.Error || result.Message || "Gagal membuat naskah");
      }
      const ndId = result.Data?.KonsepNaskah?.DataNd?.NdId as number | undefined;
      const docId = result.Data?.KonsepNaskah?.Id as string | undefined;
      if (!ndId) throw new Error("NdId tidak ditemukan dalam response");

      step(`Naskah dibuat (ND #${ndId})`);

      // 2. Generate edit link (best-effort)
      if (docId) {
        await state.sleep(1000);
        step("Menyiapkan dokumen…");
        try {
          const detail = await nadine.getNaskahDetailForEdit(ndId);
          await nadine.generateEditLink(ndId, docId, (detail.Data as Record<string, unknown>) ?? {});
        } catch {
          /* non-fatal */
        }
      }

      // 3. Upload rendered ND docx
      step(`Mengupload konsep ND: ${msg.filename}…`);
      const binary = atob(msg.docxBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      let ndUploaded = false;
      for (let retry = 0; retry < 3; retry++) {
        await state.sleep(retry === 0 ? 1000 : 2000);
        try {
          const up = await nadine.uploadKonsepFile(ndId, msg.filename, bytes);
          if ((up as { Success?: boolean }).Success) {
            ndUploaded = true;
            break;
          }
        } catch {
          if (retry >= 2) console.warn("[asguard] mm ND upload failed");
        }
      }
      if (ndUploaded) step("Konsep ND berhasil diupload");
      else step("⚠️ Upload konsep ND gagal (dilanjutkan)");

      // 4. NP — use penandatangan chosen this run or saved from previous run
      if (template) {
        const pengirimParam = payload.PengirimNdParam as Record<string, unknown> | undefined;
        const pengirimData = (pengirimParam?.Pengirim ?? {}) as Record<string, unknown>;
        const eselon = pengirimData.Eselon as number | undefined;
        const savedPenandatangan = template.notaPengantarData?.Penandatangan as Record<string, unknown>[] | undefined;
        const penandatanganUnit = mmPenandatanganUnit ?? (savedPenandatangan?.[0] ?? null);
        if (eselon !== undefined && eselon <= 3 && penandatanganUnit) {
          step("Membuat Nota Pengantar…");
          try {
            const pengirimNP = (template.notaPengantarData?.Pengirim as Record<string, unknown> | undefined) ?? penandatanganUnit;
            const npPayload = {
              Perihal: payload.Perihal ?? "",
              Penandatangan: [penandatanganUnit],
              Pengirim: pengirimNP,
              Tujuan: pengirimData,
            };
            await nadine.createNotaPengantar(ndId, npPayload);

            let npId: string | null = null;
            for (let a = 0; a < 2; a++) {
              await state.sleep(1000);
              try {
                const npResp = await nadine.getNotaPengantar(ndId);
                const npRaw = (npResp as { Data?: unknown }).Data;
                const npData = Array.isArray(npRaw)
                  ? (npRaw[0] as Record<string, unknown>)
                  : (npRaw as Record<string, unknown>);
                npId = (npData?.Id as string | undefined) ?? null;
                if (npId) break;
              } catch {
                /* retry */
              }
            }

            if (npId) {
              step(`Nota Pengantar dibuat (ID: ${npId})`);
              const npBase64 = msg.npDocxBase64 ?? template.konsepNotaFile?.base64;
              const npName = msg.npFilename ?? template.konsepNotaFile?.name;
              if (npBase64 && npName) {
                step(`Mengupload konsep NP: ${npName}…`);
                const npBin = atob(npBase64);
                const npBytes = new Uint8Array(npBin.length);
                for (let i = 0; i < npBin.length; i++) npBytes[i] = npBin.charCodeAt(i);
                let npUploaded = false;
                for (let retry = 0; retry < 2; retry++) {
                  await state.sleep(retry === 0 ? 1000 : 2000);
                  try {
                    await nadine.uploadNotaPengantarFile(ndId, npId, npName, npBytes);
                    npUploaded = true;
                    break;
                  } catch {
                    /* retry */
                  }
                }
                if (npUploaded) step("Konsep NP berhasil diupload");
                else step("⚠️ Upload konsep NP gagal (dilanjutkan)");
              }
            } else {
              step("⚠️ ID Nota Pengantar tidak ditemukan");
            }
          } catch (npErr) {
            console.warn("[asguard] mm NP failed:", safeErrorMessage(npErr));
            step(`⚠️ Nota Pengantar gagal: ${safeErrorMessage(npErr)}`);
          }
        }
      }

      // 5. Sync
      if (docId) {
        step("Sinkronisasi dokumen…");
        await state.sleep(1500);
        let synced = false;
        for (let retry = 0; retry < 2; retry++) {
          try {
            await nadine.syncDocKonsep(ndId, docId);
            synced = true;
            break;
          } catch {
            if (retry < 1) await state.sleep(2000);
          }
        }
        if (synced) step("Dokumen berhasil disinkronisasi");
        else step("⚠️ Sinkronisasi gagal (dilanjutkan)");
      }

      success++;
      ndIds.push(ndId);
      sendProgress({ type: "mm/row-done", index: msg.index, ndId });
    } catch (e) {
      failed++;
      const errMsg = e instanceof NadineNoTokenError
        ? "Sesi kadaluarsa"
        : e instanceof NadineHttpError
          ? `HTTP ${e.status}: ${e.message}`
          : e instanceof Error ? e.message : String(e);
      sendProgress({ type: "mm/row-done", index: msg.index, error: errMsg });
    }

    rowsProcessed++;
    await state.sleep(500);

    if (rowsProcessed >= totalExpected || aborted) {
      sendProgress({ type: "mm/complete", success, failed, ndIds });
    }
  };

  port.onMessage.addListener(async (msg: MailMergeRowMsg) => {
    if (msg.type === "mm/start") {
      templateId = msg.templateId;
      totalExpected = msg.total;
      template = await templateStore.getById(templateId);
      mmPenandatanganUnit = msg.penandatanganUnit ?? null;
      if (mmPenandatanganUnit && template) {
        await templateStore.update(template.id, {
          notaPengantarData: {
            Penandatangan: [mmPenandatanganUnit],
            Pengirim: mmPenandatanganUnit,
          },
        });
        template = await templateStore.getById(templateId);
        debugLog("[asguard] mm: saved penandatangan to template");
      }
      return;
    }
    if (msg.type === "mm/abort") {
      aborted = true;
      sendProgress({ type: "mm/complete", success, failed, ndIds });
      return;
    }
    if (msg.type === "mm/row") {
      await processRow(msg);
    }
  });
}
