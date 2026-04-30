/** Template run port handler — create naskah from a saved template. */
import * as nadine from "../nadine-client";
import { NadineNoTokenError, NadineHttpError } from "../nadine-client";
import * as templateStore from "../template-store";
import * as state from "../state";
import type { TemplateRunRequest, TemplateRunMsg } from "@/shared/types";

export function setupTemplateRun(port: chrome.runtime.Port): void {
  port.onMessage.addListener((msg: TemplateRunRequest) => {
    if (msg.type === "template/run") handleTemplateRun(port, msg);
  });
}

async function handleTemplateRun(port: chrome.runtime.Port, msg: TemplateRunRequest): Promise<void> {
  const send = (m: TemplateRunMsg) => {
    try {
      port.postMessage(m);
    } catch {
      /* port closed */
    }
  };

  try {
    // 1. Load template
    const template = await templateStore.getById(msg.templateId);
    if (!template) {
      send({ type: "run/error", error: "Template tidak ditemukan" });
      return;
    }

    const payload = { ...template.payload };
    if (msg.perihalOverride) payload.Perihal = msg.perihalOverride;

    // 2. Create naskah
    send({ type: "run/step", step: 1, total: 6, label: "Membuat naskah dinas…" });
    const result = await nadine.createNaskah(payload);

    if (!result.Success) {
      send({ type: "run/error", error: result.Error || result.Message || "Gagal membuat naskah" });
      return;
    }

    const ndId = result.Data?.KonsepNaskah?.DataNd?.NdId;
    const docId = result.Data?.KonsepNaskah?.Id;
    if (!ndId) {
      send({ type: "run/error", error: "NdId tidak ditemukan dalam response" });
      return;
    }

    console.log(`[asguard] naskah created: ndId=${ndId}, docId=${docId}`);
    send({ type: "run/step", step: 2, total: 6, label: "Mempersiapkan dokumen…" });

    // 3. Generate edit link (retry up to 5x with delay)
    if (docId) {
      for (let attempt = 0; attempt < 5; attempt++) {
        await state.sleep(attempt === 0 ? 1000 : 3000);
        try {
          const detail = await nadine.getNaskahDetailForEdit(ndId);
          const editPayload = (detail.Data as Record<string, unknown>) ?? {};
          await nadine.generateEditLink(ndId, docId, editPayload);
          console.log("[asguard] edit link generated");
          break;
        } catch (e) {
          if (attempt >= 4) console.warn("[asguard] edit link failed after 5 retries:", e);
        }
      }
    }

    // 4. Upload konsep ND if available
    if (template.konsepFile) {
      send({ type: "run/step", step: 3, total: 6, label: `Mengupload ${template.konsepFile.name}…` });
      const binary = atob(template.konsepFile.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      for (let retry = 0; retry < 10; retry++) {
        await state.sleep(retry === 0 ? 1000 : 2000);
        try {
          const uploadResult = await nadine.uploadKonsepFile(ndId, template.konsepFile.name, bytes);
          if ((uploadResult as { Success?: boolean }).Success) {
            console.log("[asguard] konsep ND uploaded");
            break;
          }
        } catch (e) {
          if (retry >= 9) console.warn("[asguard] konsep upload failed after 10 retries:", e);
        }
      }
    } else {
      send({ type: "run/step", step: 3, total: 6, label: "Skip upload (tidak ada file)" });
    }

    // 5. Nota Pengantar — create if eselon <= 3
    const pengirimParam = payload.PengirimNdParam as Record<string, unknown> | undefined;
    const pengirimData = (pengirimParam?.Pengirim ?? {}) as Record<string, unknown>;
    const eselon = pengirimData.Eselon as number | undefined;

    let npId: string | null = null;

    if (eselon !== undefined && eselon <= 3) {
      send({ type: "run/step", step: 4, total: 6, label: "Membuat Nota Pengantar…" });

      try {
        let penandatanganUnit: Record<string, unknown> | null = null;

        if (msg.penandatanganUnit) {
          penandatanganUnit = msg.penandatanganUnit;
          await templateStore.update(template.id, {
            notaPengantarData: {
              Penandatangan: [penandatanganUnit],
              Pengirim: penandatanganUnit,
            },
          });
          console.log(`[asguard] NP: user-selected penandatangan saved to template: ${penandatanganUnit.NamaJabatan}`);
        } else if (template.notaPengantarData?.Penandatangan) {
          const saved = template.notaPengantarData.Penandatangan as Record<string, unknown>[];
          if (saved.length > 0) {
            penandatanganUnit = saved[0];
            console.log(`[asguard] NP: using saved penandatangan: ${penandatanganUnit.NamaJabatan}`);
          }
        }

        if (!penandatanganUnit) {
          console.warn("[asguard] NP: no penandatangan available — skipping NP creation");
          send({ type: "run/step", step: 4, total: 6, label: "Skip NP (pilih penandatangan terlebih dahulu)" });
        } else {
          const pengirimNP = (template.notaPengantarData?.Pengirim as Record<string, unknown> | undefined) ?? penandatanganUnit;

          const npPayload = {
            Perihal: payload.Perihal ?? "",
            Penandatangan: [penandatanganUnit],
            Pengirim: pengirimNP,
            Tujuan: pengirimData,
          };

          console.log("[asguard] NP payload:", JSON.stringify(npPayload).slice(0, 300));
          const createResp = await nadine.createNotaPengantar(ndId, npPayload);
          console.log("[asguard] NP create response:", JSON.stringify(createResp).slice(0, 200));

          for (let attempt = 0; attempt < 5; attempt++) {
            await state.sleep(1000);
            try {
              const npResponse = await nadine.getNotaPengantar(ndId);
              const npRaw = (npResponse as { Data?: unknown }).Data;
              const npData = Array.isArray(npRaw)
                ? (npRaw[0] as Record<string, unknown> | undefined)
                : (npRaw as Record<string, unknown> | undefined);
              npId = (npData?.Id as string | undefined) ?? null;
              if (npId) {
                console.log(`[asguard] NP created: id=${npId}`);
                break;
              }
            } catch {
              /* retry */
            }
          }

          if (!npId) {
            console.warn("[asguard] NP: could not get ID after 5 retries");
          }

          if (npId && template.konsepNotaFile) {
            send({ type: "run/step", step: 5, total: 6, label: `Mengupload NP: ${template.konsepNotaFile.name}…` });
            const npBinary = atob(template.konsepNotaFile.base64);
            const npBytes = new Uint8Array(npBinary.length);
            for (let i = 0; i < npBinary.length; i++) npBytes[i] = npBinary.charCodeAt(i);

            for (let retry = 0; retry < 10; retry++) {
              await state.sleep(retry === 0 ? 1000 : 2000);
              try {
                const npUpload = await nadine.uploadNotaPengantarFile(ndId, npId, template.konsepNotaFile.name, npBytes);
                if ((npUpload as { Success?: boolean }).Success) {
                  console.log("[asguard] NP file uploaded");
                  break;
                }
              } catch {
                /* retry */
              }
            }
          } else if (npId) {
            send({ type: "run/step", step: 5, total: 6, label: "NP dibuat (tidak ada file NP)" });
          }
        }
      } catch (e) {
        console.warn("[asguard] NP creation failed:", e);
        send({ type: "run/step", step: 4, total: 6, label: "NP gagal dibuat (dilanjutkan)" });
      }
    } else {
      const reason = eselon === undefined ? "eselon tidak tersedia" : `eselon ${eselon} > 3`;
      send({ type: "run/step", step: 4, total: 6, label: `Skip NP (${reason})` });
    }

    // 6. Sync ND document
    if (docId) {
      send({ type: "run/step", step: 6, total: 6, label: "Sync dokumen…" });
      await state.sleep(2000);

      for (let retry = 0; retry < 5; retry++) {
        try {
          await nadine.syncDocKonsep(ndId, docId);
          console.log("[asguard] sync OK");
          break;
        } catch (e) {
          console.warn(`[asguard] sync attempt ${retry + 1} failed:`, e);
          if (retry < 4) await state.sleep(retry === 0 ? 2000 : 3000);
        }
      }
    }

    send({ type: "run/done", ndId });
  } catch (e) {
    const errMsg =
      e instanceof NadineNoTokenError
        ? "Sesi Nadine kadaluarsa — buka ulang Nadine lalu refresh."
        : e instanceof NadineHttpError
          ? `Gagal: ${e.message}`
          : `Error: ${e instanceof Error ? e.message : String(e)}`;
    send({ type: "run/error", error: errMsg });
  }
}
