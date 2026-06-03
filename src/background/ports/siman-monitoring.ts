/**
 * SIMAN monitoring-pengelolaan port — bulk scraping + auto-download.
 *
 * Flow:
 *   1. Paginate monitoring-pengelolaan/get to collect all records
 *   2. For each record: fetch aset detail, kelengkapan, analisis, SK
 *   3. Build export rows for Excel
 *   4. Auto-download all documents into per-tiket folders
 */
import * as simanClient from "../siman-client";
import * as simanStore from "../siman-store";
import { debugLog } from "@/shared/logging";
import type { SimanMonitoringPortRequest, SimanMonitoringMsg, MonitoringExportRow } from "@/shared/siman-types";

const PAGE_LIMIT = 25;

export function setupSimanMonitoring(port: chrome.runtime.Port): void {
  port.onMessage.addListener(async (msg: SimanMonitoringPortRequest) => {
    function send(m: SimanMonitoringMsg) {
      try { port.postMessage(m); } catch { /* port closed */ }
    }

    if (msg.type !== "siman/monitoring-run") return;

    // Ensure store is hydrated if service worker just woke up
    await simanStore.restoreSimanToken();
    const { role } = simanStore.getSimanToken();
    if (!role) {
      send({ type: "monitoring/error", error: "No SIMAN role selected" });
      return;
    }

    const filterId = msg.filterId || Number(role.idKpknl) || 0;
    const { idTipePengelolaan, idStatus, termohon, downloadKelengkapan, downloadAnalisis, downloadSk, downloadTindakLanjut, tahunSk } = msg;

    try {
      // Phase 1: Paginate monitoring list
      send({ type: "monitoring/status", message: `Mengambil daftar monitoring (kpknl=${filterId})…` });

      const allItems: Record<string, unknown>[] = [];
      const firstPage = await simanClient.getMonitoringList(filterId, idTipePengelolaan, idStatus, termohon, PAGE_LIMIT, 0);
      allItems.push(...firstPage.data);
      const total = firstPage.total || firstPage.data.length;
      send({ type: "monitoring/list-progress", done: allItems.length, total });

      while (allItems.length < total) {
        const page = await simanClient.getMonitoringList(filterId, idTipePengelolaan, idStatus, termohon, PAGE_LIMIT, allItems.length);
        if (!page.data.length) break;
        allItems.push(...page.data);
        send({ type: "monitoring/list-progress", done: allItems.length, total });
      }

      if (!allItems.length) {
        send({ type: "monitoring/rows", rows: [] });
        send({ type: "monitoring/done", success: 0, failed: 0, totalRows: 0 });
        return;
      }

      debugLog(`[asguard] monitoring: ${allItems.length} items collected`);

      // Phase 2: For each item, fetch details + download documents
      const exportRows: MonitoringExportRow[] = [];
      let dlSuccess = 0;
      let dlFailed = 0;

      for (let i = 0; i < allItems.length; i++) {
        const item = allItems[i];
        const idPengelolaan = String(item.id_pengelolaan ?? "");
        const noTiket = String(item.no_tiket ?? "");
        if (!idPengelolaan || !noTiket) continue;

        send({ type: "monitoring/detail-progress", done: i + 1, total: allItems.length, noTiket });

        // Fetch tindak-lanjut (persetujuan+sewa) AND permohonan (tujuan_permohonan fallback)
        const idTipe = Number(item.id_tipe_pengelolaan ?? 0);
        const [firstTlPage, firstPmPage, kelengkapanDocs, analisisDocs, skDocs, logs, tlLogResult, rekamTlResult] = await Promise.all([
          simanClient.getTindakLanjutAset(idPengelolaan, PAGE_LIMIT, 0).catch(() => ({ data: [], total: 0 })),
          simanClient.getAsetByNoTiket(idPengelolaan, PAGE_LIMIT, 0).catch(() => ({ data: [], total: 0 })),
          simanClient.getKelengkapanDokumen(idPengelolaan).catch(() => []),
          simanClient.getDokumenAnalisis(idPengelolaan, 9).then((r) => r.data).catch(() => []),
          simanClient.getSkByTiket(idPengelolaan).catch(() => []),
          simanClient.getLogTransaksi(idPengelolaan).catch(() => []),
          simanClient.getLogTransaksiTindakLanjut(idPengelolaan, 10, 0).catch(() => ({ data: [], total: 0 })),
          simanClient.getRekamTindakLanjut(idPengelolaan, idTipe, 25, 0).catch(() => ({ data: [], total: 0 })),
        ]);

        // Paginate tindak-lanjut aset
        const aset: Record<string, unknown>[] = [...firstTlPage.data];
        const asetTotal = firstTlPage.total || firstTlPage.data.length;
        while (aset.length < asetTotal) {
          const nextPage = await simanClient.getTindakLanjutAset(idPengelolaan, PAGE_LIMIT, aset.length).catch(() => ({ data: [], total: 0 }));
          if (!nextPage.data.length) break;
          aset.push(...nextPage.data);
        }

        // Paginate permohonan aset (for tujuan_permohonan fallback)
        const pmAset: Record<string, unknown>[] = [...firstPmPage.data];
        const pmTotal = firstPmPage.total || firstPmPage.data.length;
        while (pmAset.length < pmTotal) {
          const nextPage = await simanClient.getAsetByNoTiket(idPengelolaan, PAGE_LIMIT, pmAset.length).catch(() => ({ data: [], total: 0 }));
          if (!nextPage.data.length) break;
          pmAset.push(...nextPage.data);
        }

        // Build lookup map: id_aset -> permohonan record (for tujuan_permohonan)
        const pmMap = new Map<string, Record<string, unknown>>();
        for (const pm of pmAset) {
          const key = String(pm.id_aset ?? pm.id_pengelolaan_detail ?? "");
          if (key) pmMap.set(key, pm);
        }

        // Build export rows — one row per asset, with ticket info repeated
        const sk0 = skDocs[0] as Record<string, unknown> | undefined;

        // Extract tgl_dokumen_diterima from log transaksi (kode_status 5.9.3)
        let tglDokumenDiterima = "";
        let latest593: Record<string, unknown> | null = null;
        for (const log of logs) {
          if (String(log.kode_status ?? "") === "5.9.3") {
            if (!latest593 || String(log.start_at ?? "") > String(latest593.start_at ?? "")) {
              latest593 = log;
            }
          }
        }
        if (latest593) tglDokumenDiterima = formatDateDMY(String(latest593.start_at ?? ""));

        // Determine status tindak lanjut
        const tlLogs = tlLogResult.data;
        const rekamTlDocs = rekamTlResult.data;
        let statusTindakLanjut = "Belum melakukan Tindak Lanjut";
        // Check if latest log has kode_status 2.9.5
        if (tlLogs.length > 0) {
          const latestTlLog = tlLogs[0]; // already sorted desc by API
          if (String(latestTlLog.kode_status ?? "") === "2.9.5") {
            statusTindakLanjut = "Selesai Tindak Lanjut";
          } else if (rekamTlDocs.length > 0) {
            statusTindakLanjut = "Belum mengirim Tindak Lanjut";
          }
        } else if (rekamTlDocs.length > 0) {
          statusTindakLanjut = "Belum mengirim Tindak Lanjut";
        }

        const ticketInfo = {
          no_tiket: noTiket,
          nama_tipe_pengelolaan: String(item.nama_tipe_pengelolaan ?? ""),
          ur_satker: String(item.ur_satker ?? ""),
          kd_satker: String(item.kd_satker ?? ""),
          pemohon: String(item.pemohon ?? ""),
          termohon: String(item.termohon ?? ""),
          deskripsi: String(item.deskripsi ?? ""),
          status: String(item.status ?? item.deskripsi ?? ""),
          no_sk: String(sk0?.no_sk ?? ""),
          tgl_sk: String(sk0?.tgl_sk ?? ""),
          jumlah_aset: aset.length,
          jumlah_dok_analisis: analisisDocs.length,
          jumlah_dok_kelengkapan: kelengkapanDocs.length,
          tgl_dokumen_diterima: tglDokumenDiterima,
          status_tindak_lanjut: statusTindakLanjut,
        };

        if (aset.length === 0) {
          // Still emit a row for tickets with no assets
          exportRows.push({
            ...ticketInfo,
            kd_brg: "", nup: "", ur_sskel: "", merk: "", catatan: "", alamat: "",
            ur_kondisi: "", no_psp: "", tgl_perlh: "", luas_aset: "",
            ref_luas: "", ref_luas_sewa: "", ref_jenis: "", ref_jangka_waktu: "",
            ref_periode_label: "",
            tujuan_permohonan: "", nilai_perolehan: "", nilai_buku: "",
            nilai_permohonan: "", nilai_persetujuan: "",
            nilai_perolehan_proporsional: "",
            nm_jns_bmn: "", status_asuransi: "", status_kib: "",
            status_tindak_lanjut: statusTindakLanjut,
          });
        } else {
          for (const a of aset) {
            // Fallback tujuan_permohonan: tindak-lanjut → permohonan
            let tujuan = String(a.tujuan_permohonan ?? "");
            if (!tujuan) {
              const pmRec = pmMap.get(String(a.id_aset ?? ""));
              if (pmRec) tujuan = String(pmRec.tujuan_permohonan ?? "");
            }

            // Merge sewa into permohonan/persetujuan:
            // If nilai_permohonan is 0, use non-zero sewa value
            // If nilai_persetujuan is 0, use non-zero sewa_setuju value
            const rawPermohonan = Number(a.nilai_permohonan) || 0;
            const rawPersetujuan = Number(a.nilai_persetujuan) || 0;
            const sewaPermohonan = pickNonZeroSewa(a, "nilai_sewa");
            const sewaPersetujuan = pickNonZeroSewa(a, "nilai_sewa_setuju");

            exportRows.push({
              ...ticketInfo,
              kd_brg: String(a.kd_brg ?? ""),
              nup: String(a.no_aset ?? ""),
              ur_sskel: String(a.ur_sskel ?? ""),
              merk: String(a.merk ?? ""),
              catatan: String(a.catatan ?? a.ket ?? ""),
              alamat: String(a.alamat ?? ""),
              ur_kondisi: String(a.ur_kondisi ?? ""),
              no_psp: String(a.no_psp ?? ""),
              tgl_perlh: String(a.tgl_perlh ?? "").split("T")[0],
              luas_aset: Number(a.luas_aset) || 0,
              ref_luas: Number(a.ref_luas) || 0,
              ref_luas_sewa: Number(a.ref_luas_sewa) || 0,
              ref_jenis: String(a.ref_jenis ?? ""),
              ref_jangka_waktu: String(a.ref_jangka_waktu ?? ""),
              ref_periode_label: resolvePeriode(a),
              tujuan_permohonan: tujuan,
              nilai_perolehan: Number(a.nilai_perolehan) || 0,
              nilai_buku: Number(a.nilai_buku) || 0,
              nilai_permohonan: rawPermohonan || sewaPermohonan,
              nilai_persetujuan: rawPersetujuan || sewaPersetujuan,
              nilai_perolehan_proporsional: Number(a.nilai_perolehan_proporsional) || 0,
              nm_jns_bmn: String(a.nm_jns_bmn ?? ""),
              status_asuransi: String(a.status_asuransi ?? ""),
              status_kib: String(a.status_kib ?? ""),
            });
          }
        }

        // Check if this ticket matches the tahunSk filter (for downloads)
        const skNoStr = String(sk0?.no_sk ?? "");
        const skYear = skNoStr ? skNoStr.split("/").pop() : "";
        const matchesSkFilter = !tahunSk || skYear === tahunSk;

        // Auto-download documents (only for matching tickets)
        const docsToDownload: { id: number | string; filename: string; model: string; subfolder: string }[] = [];

        if (matchesSkFilter && downloadKelengkapan) {
          for (const doc of kelengkapanDocs) {
            if (doc.nm_file) {
              docsToDownload.push({
                id: Number(doc.id_pengelolaan_dok),
                filename: String(doc.nm_file),
                model: "LPDOK",
                subfolder: "kelengkapan",
              });
            }
          }
        }

        if (matchesSkFilter && downloadAnalisis) {
          for (const doc of analisisDocs) {
            if (doc.nm_file) {
              docsToDownload.push({
                id: Number(doc.id_pengelolaan_dok_analisis),
                filename: String(doc.nm_file),
                model: "DKANL",
                subfolder: "analisis",
              });
            }
          }
        }

        if (matchesSkFilter && downloadSk) {
          for (const sk of skDocs) {
            const skRec = sk as Record<string, unknown>;
            // Download SK from url_sk (satu-file.kemenkeu.go.id)
            const urlSk = String(skRec.url_sk ?? "").replace(/^"|"$/g, "");
            if (urlSk && urlSk.startsWith("http")) {
              try {
                const skFilename = `SK-${String(skRec.no_sk ?? noTiket).replace(/\//g, "-")}.pdf`;
                chrome.downloads.download({
                  url: urlSk,
                  filename: `monitoring/${noTiket}/sk/${skFilename}`,
                  saveAs: false,
                });
                dlSuccess++;
              } catch { dlFailed++; }
            }
            // Download lampiran from url_lampiran
            const urlLampiran = String(skRec.url_lampiran ?? "").replace(/^"|"$/g, "");
            if (urlLampiran && urlLampiran.startsWith("http")) {
              try {
                const lampFilename = `Lampiran-SK-${String(skRec.no_sk ?? noTiket).replace(/\//g, "-")}.pdf`;
                chrome.downloads.download({
                  url: urlLampiran,
                  filename: `monitoring/${noTiket}/sk/${lampFilename}`,
                  saveAs: false,
                });
                dlSuccess++;
              } catch { dlFailed++; }
            }
          }
        }

        // Download tindak lanjut documents
        if (matchesSkFilter && downloadTindakLanjut) {
          for (const tlDoc of rekamTlDocs) {
            const nmFile = String(tlDoc.nm_file_bukti ?? "");
            const tlId = Number(tlDoc.id_pengelolaan_rekam_tindak_lanjut ?? 0);
            if (nmFile && tlId) {
              docsToDownload.push({
                id: tlId,
                filename: nmFile,
                model: "DKRTL",
                subfolder: "tindak_lanjut",
              });
            }
          }
        }

        // Download kelengkapan + analisis + tindak lanjut docs via token
        for (const doc of docsToDownload) {
          send({ type: "monitoring/download-progress", done: dlSuccess + dlFailed + 1, total: docsToDownload.length, filename: doc.filename });
          try {
            const token = await simanClient.getDownloadTokenWithModel(doc.id, doc.filename, doc.model);
            if (token) {
              const url = simanClient.getFileStreamUrl(token, doc.filename);
              chrome.downloads.download({
                url,
                filename: `monitoring/${noTiket}/${doc.subfolder}/${doc.filename}`,
                saveAs: false,
              });
              dlSuccess++;
            } else {
              dlFailed++;
            }
          } catch {
            dlFailed++;
          }
        }
      }

      send({ type: "monitoring/rows", rows: exportRows });
      send({ type: "monitoring/done", success: dlSuccess, failed: dlFailed, totalRows: exportRows.length });
    } catch (e) {
      send({ type: "monitoring/error", error: e instanceof Error ? e.message : String(e) });
    }
  });
}

/** Resolve ref_periode_* booleans into a label */
function resolvePeriode(a: Record<string, unknown>): string {
  if (a.ref_periode_tahun) return "Tahunan";
  if (a.ref_periode_bulan) return "Bulanan";
  if (a.ref_periode_hari) return "Harian";
  if (a.ref_periode_jam) return "Per Jam";
  return "Non-Periodesitas";
}

/** Pick non-zero sewa value from _jam/_hari/_bulan/_tahun variants */
function pickNonZeroSewa(a: Record<string, unknown>, prefix: string): number {
  return Number(a[`${prefix}_tahun`]) || Number(a[`${prefix}_bulan`]) ||
         Number(a[`${prefix}_hari`]) || Number(a[`${prefix}_jam`]) || 0;
}

/** Convert ISO/YYYY-MM-DD date to DD-MM-YYYY */
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
