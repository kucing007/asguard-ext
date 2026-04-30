/**
 * SIMAN sop-tarik port — matches CLI's tarik_data_sop() flow.
 *
 * Uses getSkAll (sk/get-all endpoint with termohon="KPKNL") as the primary
 * data source, NOT penetapan-pengelolaan/get-data. This filters to only SK
 * records where the KPKNL is the termohon, matching the Nadine CLI behavior.
 *
 * Flow:
 *   1. Paginate getSkAll (termohon=KPKNL) to collect all SK records
 *   2. For each SK: getMonitoringByTiket → id_pengelolaan
 *   3. For each id_pengelolaan: getLogTransaksi → find kode_status "5.9.3"
 *   4. Export rows
 */
import * as simanClient from "../siman-client";
import * as simanStore from "../siman-store";
import type { SimanSopTarikPortRequest, SimanSopTarikMsg, SopExportRow } from "@/shared/siman-types";

const PAGE_LIMIT = 25;

/** ISO/datetime string → DD-MM-YYYY (no Date() to avoid timezone shift). */
function formatDateDMY(raw: string): string {
  if (!raw) return "";
  const dateStr = String(raw).slice(0, 10);
  const parts = dateStr.split("-");
  if (parts.length === 3 && parts[0].length === 4) {
    const [year, month, day] = parts;
    return `${day.padStart(2, "0")}-${month.padStart(2, "0")}-${year}`;
  }
  return String(raw);
}

export function setupSimanSopTarik(port: chrome.runtime.Port): void {
  port.onMessage.addListener(async (msg: SimanSopTarikPortRequest) => {
    function send(m: SimanSopTarikMsg) {
      try { port.postMessage(m); } catch { /* port closed */ }
    }

    if (msg.type !== "siman/sop-tarik-run") return;

    const { role } = simanStore.getSimanToken();
    if (!role) {
      send({ type: "sop/error", error: "No SIMAN role selected" });
      return;
    }

    const tahun = msg.tahunAnggaran || "0";
    const idKanwil = msg.idKanwil || Number(role.idKanwil) || 0;
    const idKpknl = msg.idKpknl || Number(role.idKpknl) || 0;

    try {
      // Phase 1: Paginate SK data (filtered by termohon=KPKNL)
      send({ type: "sop/status", message: `Mengambil daftar SK (kpknl=${idKpknl}, kanwil=${idKanwil}, tahun=${tahun})…` });

      const allSk: Record<string, unknown>[] = [];
      const firstPage = await simanClient.getSkAll(role, tahun, PAGE_LIMIT, 0, idKanwil, idKpknl);
      allSk.push(...firstPage.data);
      const total = firstPage.total || firstPage.data.length;
      send({ type: "sop/sk-progress", done: allSk.length, total });

      while (allSk.length < total) {
        const page = await simanClient.getSkAll(role, tahun, PAGE_LIMIT, allSk.length, idKanwil, idKpknl);
        if (!page.data.length) break;
        allSk.push(...page.data);
        send({ type: "sop/sk-progress", done: allSk.length, total });
      }

      if (!allSk.length) {
        send({ type: "sop/rows", rows: [] });
        send({ type: "sop/done" });
        return;
      }

      // Phase 2 & 3: For each SK, get monitoring + log
      const exportRows: SopExportRow[] = [];

      for (let i = 0; i < allSk.length; i++) {
        const sk = allSk[i];
        const noTiket = String(sk.no_tiket ?? "");
        if (!noTiket) continue;

        send({ type: "sop/detail-progress", done: i + 1, total: allSk.length, noTiket });

        const idPengelolaan = await simanClient.getMonitoringByTiket(role, noTiket);

        let tglDokumenDiterima = "";
        if (idPengelolaan) {
          const logs = await simanClient.getLogTransaksi(idPengelolaan).catch(() => []);
          let latest593: Record<string, unknown> | null = null;
          for (const log of logs) {
            if (String(log.kode_status ?? "") === "5.9.3") {
              if (!latest593 || String(log.start_at ?? "") > String(latest593.start_at ?? "")) {
                latest593 = log;
              }
            }
          }
          if (latest593) tglDokumenDiterima = formatDateDMY(String(latest593.start_at ?? ""));
        }

        const isTb = String(sk.is_tb ?? "").toUpperCase();

        exportRows.push({
          no_tiket: noTiket,
          no_sk: String(sk.no_sk ?? ""),
          tgl_sk: formatDateDMY(String(sk.tgl_sk ?? "")),
          ur_satker: String(sk.ur_satker ?? ""),
          kd_satker: String(sk.kd_satker ?? ""),
          pemohon: String(sk.pemohon ?? ""),
          ur_kl: String(sk.ur_kl ?? ""),
          nama_tipe_pengelolaan: String(sk.nama_tipe_pengelolaan ?? ""),
          tgl_dokumen_diterima: tglDokumenDiterima,
          kategori_bmn: isTb === "Y" ? "Tanah dan/atau Bangunan" : "Selain Tanah dan/atau Bangunan",
        });
      }

      send({ type: "sop/rows", rows: exportRows });
      send({ type: "sop/done" });
    } catch (e) {
      send({ type: "sop/error", error: e instanceof Error ? e.message : String(e) });
    }
  });
}
