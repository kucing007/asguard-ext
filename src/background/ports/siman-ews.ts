import * as simanClient from "../siman-client";
import * as simanStore from "../siman-store";
import { debugLog } from "@/shared/logging";
import type { SimanEwsPortRequest, SimanEwsMsg, EwsRow } from "@/shared/siman-types";

const PAGE_LIMIT = 25;
const CONCURRENCY = 5;

type Msg = SimanEwsMsg;

function send(port: chrome.runtime.Port, msg: Msg) {
  try { port.postMessage(msg); } catch { /* port closed */ }
}

async function poolRun<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

function addMonths(dateStr: string, months: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setMonth(d.getMonth() + months);
  return d.toISOString().split("T")[0];
}

function diffDays(from: string, to: string): number {
  const a = new Date(from + "T00:00:00");
  const b = new Date(to + "T00:00:00");
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function formatSisa(days: number): string {
  if (days < 0) {
    const abs = Math.abs(days);
    return `Sudah Lewat ${formatPositive(abs)}`;
  }
  if (days === 0) return "Hari Ini";
  return formatPositive(days);
}

function formatPositive(totalDays: number): string {
  const years = Math.floor(totalDays / 365);
  const rem = totalDays % 365;
  const months = Math.floor(rem / 30);
  const days = rem % 30;
  const parts: string[] = [];
  if (years > 0) parts.push(`${years} Tahun`);
  if (months > 0) parts.push(`${months} Bulan`);
  if (days > 0 || parts.length === 0) parts.push(`${days} Hari`);
  return parts.join(" ");
}

function categorize(sisaHari: number): "lewat" | "kritis" | "perhatian" | "aman" {
  if (sisaHari <= 0) return "lewat";
  if (sisaHari <= 90) return "kritis";
  if (sisaHari <= 180) return "perhatian";
  return "aman";
}

/** Get best nilai_persetujuan from asset fields */
function getNilaiPersetujuan(a: Record<string, unknown>): number {
  return Number(a.nilai_persetujuan)
    || Number(a.nilai_sewa_setuju)
    || Number(a.nilai_sewa_setuju_tahun)
    || Number(a.nilai_sewa_setuju_bulan)
    || Number(a.nilai_sewa_setuju_hari)
    || Number(a.nilai_sewa_setuju_jam)
    || 0;
}

/** Fuzzy string comparison: normalize + check if strings overlap */
function fuzzyMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const na = a.toLowerCase().trim().replace(/\s+/g, " ");
  const nb = b.toLowerCase().trim().replace(/\s+/g, " ");
  if (na === nb) return true;
  // Check substring overlap (one contains the other)
  if (na.includes(nb) || nb.includes(na)) return true;
  // Check word overlap: at least 50% of words match
  const wordsA = new Set(na.split(/\s+/).filter(w => w.length > 2));
  const wordsB = new Set(nb.split(/\s+/).filter(w => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return false;
  const overlap = [...wordsA].filter(w => wordsB.has(w)).length;
  const minSize = Math.min(wordsA.size, wordsB.size);
  return overlap / minSize >= 0.5;
}

export function setupSimanEws(port: chrome.runtime.Port): void {
  port.onMessage.addListener(async (msg: SimanEwsPortRequest) => {
    if (msg.type !== "siman/ews-run") return;

    const { idTipePengelolaan, idStatus } = msg;

    // Get role's KPKNL id for filtering
    await simanStore.restoreSimanToken();
    const { role } = simanStore.getSimanToken();
    if (!role) {
      send(port, { type: "ews/error", error: "No SIMAN role selected" });
      return;
    }
    const filterId = Number(role.idKpknl) || 0;

    try {
      send(port, { type: "ews/status", message: `Mengambil daftar tiket (KPKNL=${filterId})...` });

      // Phase 1: Paginate all tickets for this KPKNL
      const allItems: Record<string, unknown>[] = [];
      let offset = 0;
      let total = 0;
      do {
        const res = await simanClient.getMonitoringList(filterId, idTipePengelolaan, idStatus, 0, PAGE_LIMIT, offset);
        if (offset === 0) total = res.total;
        allItems.push(...res.data);
        offset += PAGE_LIMIT;
        send(port, { type: "ews/progress", done: Math.min(allItems.length, total), total });
      } while (allItems.length < total);

      if (allItems.length === 0) {
        send(port, { type: "ews/rows", rows: [], kpknlId: filterId });
        send(port, { type: "ews/done" });
        return;
      }

      send(port, { type: "ews/status", message: `Memproses ${allItems.length} tiket...` });

      // Phase 2: For each ticket, fetch SK + aset
      const allRows: EwsRow[] = [];
      let processed = 0;

      await poolRun(allItems, CONCURRENCY, async (item) => {
        const idPengelolaan = String(item.id_pengelolaan ?? "");
        const noTiket = String(item.no_tiket ?? "");
        if (!idPengelolaan) return;

        try {
          const [skList, asetRes] = await Promise.all([
            simanClient.getSkByTiket(idPengelolaan, 1).catch(() => []),
            simanClient.getAsetByNoTiket(idPengelolaan, 100, 0).catch(() => ({ data: [], total: 0 })),
          ]);

          const sk = skList.length > 0 ? skList[0] : null;
          const tglSk = sk ? String(sk.tgl_sk ?? "").split("T")[0] : "";
          const noSk = sk ? String(sk.no_sk ?? "") : "";

          if (!tglSk || tglSk === "9999-01-01") {
            processed++;
            send(port, { type: "ews/progress", done: processed, total: allItems.length });
            return;
          }

          for (const a of asetRes.data) {
            const jangkaWaktu = Number(a.ref_jangka_waktu) || 0;
            if (jangkaWaktu <= 0) continue;

            const tglBerakhir = addMonths(tglSk, jangkaWaktu);
            const today = new Date().toISOString().split("T")[0];
            const sisaHari = diffDays(today, tglBerakhir);

            // Get tujuan_permohonan
            let tujuan = String(a.tujuan_permohonan ?? "");
            if (!tujuan) tujuan = String(a.tujuan ?? "");

            allRows.push({
              no_tiket: noTiket,
              id_pengelolaan: idPengelolaan,
              nama_tipe_pengelolaan: String(item.nama_tipe_pengelolaan ?? ""),
              ur_satker: String(item.ur_satker ?? ""),
              kd_satker: String(item.kd_satker ?? ""),
              pemohon: String(item.pemohon ?? ""),
              no_sk: noSk,
              tgl_sk: tglSk,
              id_aset: String(a.id_aset ?? a.id ?? ""),
              kd_brg: String(a.kd_brg ?? ""),
              nup: String(a.no_aset ?? ""),
              ur_sskel: String(a.ur_sskel ?? ""),
              tujuan_permohonan: tujuan,
              keterangan: String(a.keterangan ?? a.ket ?? ""),
              ref_luas_sewa: String(a.ref_luas_sewa ?? a.ref_luas ?? ""),
              ref_jangka_waktu: jangkaWaktu,
              tgl_berakhir: tglBerakhir,
              sisa_hari: sisaHari,
              sisa_label: formatSisa(sisaHari),
              status_ews: categorize(sisaHari),
              nilai_persetujuan: getNilaiPersetujuan(a),
              renewal: null, // filled in Phase 3
            });
          }
        } catch (e) {
          debugLog("[ews] error processing", noTiket, e);
        }

        processed++;
        send(port, { type: "ews/progress", done: processed, total: allItems.length });
      });

      // Phase 3: For lewat & kritis assets, check renewal via list-pengelolaan API
      const needsRenewalCheck = allRows.filter(
        r => (r.status_ews === "lewat" || r.status_ews === "kritis") && r.id_aset,
      );

      if (needsRenewalCheck.length > 0) {
        send(port, { type: "ews/status", message: `Memeriksa perpanjangan ${needsRenewalCheck.length} aset...` });

        // Build lookup index: id_aset → all rows for that asset (for cross-referencing)
        const assetRowIndex = new Map<string, EwsRow[]>();
        for (const r of allRows) {
          if (!r.id_aset) continue;
          if (!assetRowIndex.has(r.id_aset)) assetRowIndex.set(r.id_aset, []);
          assetRowIndex.get(r.id_aset)!.push(r);
        }

        // Deduplicate by id_aset to avoid redundant API calls
        const uniqueIdAsets = [...new Set(needsRenewalCheck.map(r => r.id_aset))];
        const renewalCache = new Map<string, { no_tiket: string; no_surat: string; tgl_surat: string; nama_tipe: string } | null>();
        let renewalDone = 0;

        await poolRun(uniqueIdAsets, CONCURRENCY, async (idAset) => {
          try {
            const history = await simanClient.getListPengelolaan(idAset);
            // Filter for Sewa entries only, sort by tgl_surat desc (newest first)
            const sewaEntries = history
              .filter(h => String(h.nama_tipe_pengelolaan ?? "").toLowerCase().includes("sewa"))
              .sort((a, b) => String(b.tgl_surat ?? "").localeCompare(String(a.tgl_surat ?? "")));

            if (sewaEntries.length > 0) {
              const latest = sewaEntries[0];
              renewalCache.set(idAset, {
                no_tiket: String(latest.no_tiket ?? ""),
                no_surat: String(latest.no_surat ?? ""),
                tgl_surat: String(latest.tgl_surat ?? "").split("T")[0],
                nama_tipe: String(latest.nama_tipe_pengelolaan ?? ""),
              });
            } else {
              renewalCache.set(idAset, null);
            }
          } catch (e) {
            debugLog("[ews] renewal check error", idAset, e);
            renewalCache.set(idAset, null);
          }

          renewalDone++;
          send(port, { type: "ews/progress", done: renewalDone, total: uniqueIdAsets.length });
        });

        // Apply renewal info with comparison
        for (const row of needsRenewalCheck) {
          const info = renewalCache.get(row.id_aset);
          if (!info || !info.no_tiket || info.no_tiket === row.no_tiket) continue;

          // Find the new ticket's asset row in allRows for comparison
          const newRows = assetRowIndex.get(row.id_aset) ?? [];
          const newRow = newRows.find(r => r.no_tiket === info.no_tiket);

          const newTujuan = newRow?.tujuan_permohonan ?? "";
          const newLuas = newRow?.ref_luas_sewa ?? "";
          const newKet = newRow?.keterangan ?? "";

          const matchLuas = fuzzyMatch(row.ref_luas_sewa, newLuas);
          const matchTujuan = fuzzyMatch(row.tujuan_permohonan, newTujuan);
          const matchKet = fuzzyMatch(row.keterangan, newKet);

          // Overall: is_renewal if at least tujuan OR keterangan match (same purpose)
          // If we have no data from new row (not in allRows), still mark as potential
          const hasNewData = !!newRow;
          const isRenewal = !hasNewData || matchTujuan || matchKet;

          row.renewal = {
            no_tiket: info.no_tiket,
            no_surat: info.no_surat,
            tgl_surat: info.tgl_surat,
            nama_tipe_pengelolaan: info.nama_tipe,
            new_tujuan: newTujuan,
            new_luas: newLuas,
            new_keterangan: newKet,
            match_luas: matchLuas,
            match_tujuan: matchTujuan,
            match_keterangan: matchKet,
            is_renewal: isRenewal,
          };
        }
      }

      // Sort: most critical first (lowest sisa_hari)
      allRows.sort((a, b) => a.sisa_hari - b.sisa_hari);

      send(port, { type: "ews/rows", rows: allRows, kpknlId: filterId });
      send(port, { type: "ews/done" });
    } catch (e) {
      send(port, { type: "ews/error", error: e instanceof Error ? e.message : String(e) });
    }
  });
}
