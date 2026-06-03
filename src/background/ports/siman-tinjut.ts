/**
 * SIMAN tinjut-check port — progressive streaming with concurrency control.
 *
 * Flow:
 *   1. Content script connects via port "siman-tinjut"
 *   2. Sends { type: "check", noTikets: string[] }
 *   3. Background checks cache (chrome.storage.session) first
 *   4. For uncached tickets: fetch penetapan list, then check each ticket
 *      with concurrency limit of 5
 *   5. Results streamed back progressively per ticket
 */
import * as simanClient from "../siman-client";
import * as simanStore from "../siman-store";
import * as state from "../state";

const CACHE_KEY = "tinjutCache";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const CONCURRENCY = 5;

interface RekamFile {
  id: number;
  no: number;
  jenisDok: string;
  nmDok: string;
  noBukti: string;
  tglBukti: string;
  nmFile: string;
}

interface TinjutInfo {
  status: string;
  lastStatus: string;
  lastDate: string;
  lastBy: string;
  lastRole: string;
  kodeStatus: string;
  rekamFiles?: RekamFile[];
  skNo?: string;
  skTgl?: string;
  skPenandatangan?: string;
}

interface CacheEntry {
  info: TinjutInfo;
  ts: number; // timestamp
}

type TinjutMsg =
  | { type: "tinjut/result"; noTiket: string; info: TinjutInfo }
  | { type: "tinjut/skip"; noTiket: string } // PSP or unmapped
  | { type: "tinjut/done" }
  | { type: "tinjut/error"; error: string };

function send(port: chrome.runtime.Port, msg: TinjutMsg) {
  try { port.postMessage(msg); } catch { /* port closed */ }
}

/** Read valid (non-expired) cache entries from session storage */
async function readCache(): Promise<Record<string, CacheEntry>> {
  try {
    const raw = await chrome.storage.session.get(CACHE_KEY);
    return (raw?.[CACHE_KEY] as Record<string, CacheEntry>) ?? {};
  } catch { return {}; }
}

/** Write cache entries to session storage */
async function writeCache(cache: Record<string, CacheEntry>): Promise<void> {
  try { await chrome.storage.session.set({ [CACHE_KEY]: cache }); } catch { /* ignore */ }
}

/** Simple concurrency pool */
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

/** Extract rekam file summaries */
function extractRekamFiles(data: Record<string, unknown>[]): RekamFile[] {
  return data.map((r, i) => ({
    id: Number(r.id_pengelolaan_rekam_tindak_lanjut ?? 0),
    no: i + 1,
    jenisDok: String(r.nm_jenis_dok_rekam_tindak_lanjut ?? ""),
    nmDok: String(r.nm_dok_tl ?? ""),
    noBukti: String(r.no_bukti ?? ""),
    tglBukti: String(r.tgl_bukti ?? "").split("T")[0],
    nmFile: String(r.nm_file_bukti ?? ""),
  }));
}

/** Fetch SK info and attach to TinjutInfo */
async function attachSkInfo(base: TinjutInfo, idPengelolaan: string): Promise<void> {
  try {
    const skList = await simanClient.getSkByTiket(idPengelolaan, 1);
    if (skList.length > 0) {
      const sk = skList[0];
      base.skNo = String(sk.no_sk ?? "");
      base.skTgl = String(sk.tgl_sk ?? "").split("T")[0];
      base.skPenandatangan = String(sk.nama_penandatangan_sk ?? "");
    }
  } catch { /* ignore */ }
}

/** Check a single ticket and return its TinjutInfo */
async function checkSingleTicket(
  idPengelolaan: string,
  idTipePengelolaan: number,
): Promise<TinjutInfo> {
  const base: TinjutInfo = { status: "", lastStatus: "", lastDate: "", lastBy: "", lastRole: "", kodeStatus: "" };
  try {
    const logRes = await simanClient.getLogTransaksiTindakLanjut(idPengelolaan, 10, 0);
    const lastLog = logRes.data.length > 0 ? logRes.data[0] : null;
    if (lastLog) {
      base.lastStatus = String(lastLog.status_permohonan ?? "");
      base.lastDate = String(lastLog.created_at ?? "");
      base.lastBy = String(lastLog.fullname ?? "");
      base.lastRole = String(lastLog.role ?? "");
      base.kodeStatus = String(lastLog.kode_status ?? "");
    }

    if (lastLog && String(lastLog.kode_status ?? "") === "2.9.5") {
      base.status = "Sudah Tinjut";
      return base;
    }

    // Check rekam-tindak-lanjut for evidence — fetch up to 25 for file list
    try {
      const rekamRes = await simanClient.getRekamTindakLanjut(idPengelolaan, idTipePengelolaan, 25, 0);
      if (rekamRes.total > 0 || rekamRes.data.length > 0) {
        base.status = "Ada Bukti";
        base.rekamFiles = extractRekamFiles(rekamRes.data);
        await attachSkInfo(base, idPengelolaan);
        return base;
      }
    } catch { /* ignore */ }

    base.status = "Belum Tinjut";
    await attachSkInfo(base, idPengelolaan);
    return base;
  } catch {
    base.status = "Belum Tinjut";
    base.lastStatus = "Gagal mengecek status";
    return base;
  }
}

export function setupSimanTinjut(port: chrome.runtime.Port): void {
  port.onMessage.addListener(async (msg: { type: string; noTikets?: string[] }) => {
    if (msg.type !== "check" || !msg.noTikets) return;
    const allNoTikets = msg.noTikets;

    await simanStore.restoreSimanToken();
    const { role } = simanStore.getSimanToken();
    if (!role) {
      send(port, { type: "tinjut/error", error: "No SIMAN role" });
      return;
    }

    const now = Date.now();

    // 1. Check session cache — send cached results immediately
    const cache = await readCache();
    const uncached: string[] = [];

    for (const nt of allNoTikets) {
      const entry = cache[nt];
      if (entry && (now - entry.ts) < CACHE_TTL_MS) {
        // Cache hit — send immediately
        if (entry.info.status) {
          send(port, { type: "tinjut/result", noTiket: nt, info: entry.info });
        } else {
          send(port, { type: "tinjut/skip", noTiket: nt });
        }
      } else {
        uncached.push(nt);
      }
    }

    if (uncached.length === 0) {
      send(port, { type: "tinjut/done" });
      return;
    }

    // 2. Fetch penetapan list for mapping
    try {
      const listRes = await simanClient.getPenetapanList(
        role, 500, 0, undefined, undefined, state.capturedPenetapanBody ?? undefined,
      );

      const tiketMap = new Map<string, string>();
      const tipeMap = new Map<string, number>();
      for (const item of listRes.data) {
        const nt = item.noTiket ?? "";
        const idP = item.idPengelolaan ?? "";
        if (nt && idP) {
          tiketMap.set(nt, idP);
          tipeMap.set(nt, Number(item.idTipePengelolaan ?? 0));
        }
      }

      // Filter: skip PSP and unmapped tickets
      const toCheck: string[] = [];
      for (const nt of uncached) {
        if (!tiketMap.has(nt)) {
          cache[nt] = { info: { status: "", lastStatus: "", lastDate: "", lastBy: "", lastRole: "", kodeStatus: "" }, ts: now };
          send(port, { type: "tinjut/skip", noTiket: nt });
          continue;
        }
        const tipe = tipeMap.get(nt) ?? 0;
        if (tipe === 1) { // PSP
          cache[nt] = { info: { status: "", lastStatus: "", lastDate: "", lastBy: "", lastRole: "", kodeStatus: "" }, ts: now };
          send(port, { type: "tinjut/skip", noTiket: nt });
          continue;
        }
        toCheck.push(nt);
      }

      // 3. Check tickets with concurrency limit, stream results
      await poolRun(toCheck, CONCURRENCY, async (nt) => {
        const idP = tiketMap.get(nt)!;
        const idTipe = tipeMap.get(nt) ?? 0;
        const info = await checkSingleTicket(idP, idTipe);
        cache[nt] = { info, ts: now };
        send(port, { type: "tinjut/result", noTiket: nt, info });
      });

      // Save all to cache
      await writeCache(cache);
      send(port, { type: "tinjut/done" });
    } catch (e) {
      send(port, { type: "tinjut/error", error: String(e) });
    }
  });
}
