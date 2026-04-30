/** SIMAN dok-lengkap port — marks all kelengkapan dokumen as Lengkap (status=5). */
import * as simanClient from "../siman-client";
import * as simanStore from "../siman-store";
import type { SimanDokLengkapPortRequest, SimanDokLengkapMsg } from "@/shared/siman-types";

export function setupSimanDokLengkap(port: chrome.runtime.Port): void {
  port.onMessage.addListener(async (msg: SimanDokLengkapPortRequest) => {
    function send(m: SimanDokLengkapMsg) {
      try { port.postMessage(m); } catch { /* port closed */ }
    }

    if (msg.type !== "siman/dok-lengkap-run") return;

    const { role } = simanStore.getSimanToken();
    if (!role) {
      send({ type: "dok/error", error: "No SIMAN role selected" });
      return;
    }

    try {
      const docs = await simanClient.getKelengkapanDokumen(msg.idPengelolaan, 100);
      const total = docs.length;
      let success = 0;
      let failed = 0;

      for (let i = 0; i < docs.length; i++) {
        const doc = docs[i] as Record<string, unknown>;
        const nmDok = String(doc.nm_dok ?? doc.nm_file ?? `Dokumen ${i + 1}`);
        send({ type: "dok/progress", done: i, total, nmDok });
        try {
          await simanClient.updateStatusDokumen(doc, 5, msg.noTiket);
          success++;
        } catch {
          failed++;
        }
      }
      send({ type: "dok/done", success, failed });
    } catch (e) {
      send({ type: "dok/error", error: e instanceof Error ? e.message : String(e) });
    }
  });
}
