import { useState, useEffect, useRef, useMemo } from "preact/hooks";
import type { SimanMonitoringMsg, MonitoringExportRow } from "@/shared/types";
import * as XLSX from "xlsx";

interface StatusTiketItem { id: number; kd_status_tiket: number; nm_status_tiket: string }
interface TipePengelolaanItem { id_tipe_pengelolaan: number; nama_tipe_pengelolaan: string; [k: string]: unknown }
interface TermohonItem { id_struktur: number; nama_alias: string; nama_level: string; penetapan: string }
type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

const COLUMNS: { key: keyof MonitoringExportRow; label: string }[] = [
  // Ticket-level
  { key: "no_tiket", label: "No Tiket" },
  { key: "nama_tipe_pengelolaan", label: "Tipe Pengelolaan" },
  { key: "ur_satker", label: "Satker" },
  { key: "kd_satker", label: "Kode Satker" },
  { key: "pemohon", label: "Pemohon" },
  { key: "termohon", label: "Termohon" },
  { key: "deskripsi", label: "Deskripsi" },
  { key: "status", label: "Status" },
  { key: "no_sk", label: "No SK" },
  { key: "tgl_sk", label: "Tgl SK" },
  { key: "jumlah_aset", label: "Jumlah Aset" },
  { key: "jumlah_dok_analisis", label: "Jml Dok Analisis" },
  { key: "jumlah_dok_kelengkapan", label: "Jml Dok Kelengkapan" },
  { key: "tgl_dokumen_diterima", label: "Tgl Dokumen Diterima" },
  // Per-asset detail
  { key: "kd_brg", label: "Kode Barang" },
  { key: "nup", label: "NUP" },
  { key: "ur_sskel", label: "Uraian Barang" },
  { key: "merk", label: "Merk" },
  { key: "catatan", label: "Catatan/Keterangan" },
  { key: "alamat", label: "Alamat" },
  { key: "ur_kondisi", label: "Kondisi" },
  { key: "nm_jns_bmn", label: "Jenis BMN" },
  { key: "no_psp", label: "No PSP" },
  { key: "tgl_perlh", label: "Tgl Perolehan" },
  { key: "luas_aset", label: "Luas Aset" },
  { key: "ref_luas", label: "Luas Dimohon" },
  { key: "ref_luas_sewa", label: "Luas Sewa" },
  { key: "ref_jenis", label: "Jenis Peruntukan" },
  { key: "ref_jangka_waktu", label: "Jangka Waktu" },
  { key: "ref_periode_label", label: "Periode" },
  { key: "tujuan_permohonan", label: "Tujuan Permohonan" },
  { key: "nilai_perolehan", label: "Nilai Perolehan" },
  { key: "nilai_buku", label: "Nilai Buku" },
  { key: "nilai_permohonan", label: "Nilai Permohonan" },
  { key: "nilai_persetujuan", label: "Nilai Persetujuan" },
  { key: "nilai_perolehan_proporsional", label: "Nilai Proporsional" },
  { key: "status_asuransi", label: "Status Asuransi" },
  { key: "status_kib", label: "Status KIB" },
  { key: "status_tindak_lanjut", label: "Status Tindak Lanjut" },
];

function send<T>(msg: unknown): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

export function SimanMonitoringView() {
  // Filters
  const [statusList, setStatusList] = useState<StatusTiketItem[]>([]);
  const [tipeList, setTipeList] = useState<TipePengelolaanItem[]>([]);
  const [termohonList, setTermohonList] = useState<TermohonItem[]>([]);
  const [selectedStatus, setSelectedStatus] = useState(9); // default: Tiket Aktif
  const [selectedTipe, setSelectedTipe] = useState(0);
  const [selectedTermohon, setSelectedTermohon] = useState(0);
  const [tahunSk, setTahunSk] = useState(""); // post-scrape filter by year in no_sk
  const [loadingRef, setLoadingRef] = useState(true);

  // Download toggles
  const [dlKelengkapan, setDlKelengkapan] = useState(true);
  const [dlAnalisis, setDlAnalisis] = useState(true);
  const [dlSk, setDlSk] = useState(true);
  const [dlTindakLanjut, setDlTindakLanjut] = useState(true);

  // Run state
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const [listProgress, setListProgress] = useState<{ done: number; total: number } | null>(null);
  const [detailProgress, setDetailProgress] = useState<{ done: number; total: number; noTiket: string } | null>(null);
  const [dlProgress, setDlProgress] = useState<{ done: number; total: number; filename: string } | null>(null);
  const [rows, setRows] = useState<MonitoringExportRow[] | null>(null);
  const [doneInfo, setDoneInfo] = useState<{ success: number; failed: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const portRef = useRef<chrome.runtime.Port | null>(null);

  useEffect(() => () => { portRef.current?.disconnect(); }, []);

  // Load reference data on mount
  useEffect(() => {
    (async () => {
      const [statusRes, tipeRes, termohonRes] = await Promise.all([
        send<ApiResult<StatusTiketItem[]>>({ type: "siman/get-monitoring-status-tiket" }),
        send<ApiResult<TipePengelolaanItem[]>>({ type: "siman/get-all-tipe-pengelolaan" }),
        send<ApiResult<TermohonItem[]>>({ type: "siman/get-struktur-termohon" }),
      ]);
      if (statusRes.ok) setStatusList(statusRes.data);
      if (tipeRes.ok) setTipeList(tipeRes.data);
      if (termohonRes.ok) setTermohonList(termohonRes.data);
      setLoadingRef(false);
    })();
  }, []);

  function start() {
    if (running) return;
    setRunning(true);
    setError(null);
    setRows(null);
    setDoneInfo(null);
    setStatus("Menghubungkan…");
    setListProgress(null);
    setDetailProgress(null);
    setDlProgress(null);

    const port = chrome.runtime.connect({ name: "siman-monitoring" });
    portRef.current = port;

    port.onMessage.addListener((msg: SimanMonitoringMsg) => {
      if (msg.type === "monitoring/status") setStatus(msg.message);
      if (msg.type === "monitoring/list-progress") setListProgress({ done: msg.done, total: msg.total });
      if (msg.type === "monitoring/detail-progress") {
        setDetailProgress({ done: msg.done, total: msg.total, noTiket: msg.noTiket });
        setStatus(`Memproses ${msg.done}/${msg.total}: ${msg.noTiket}`);
      }
      if (msg.type === "monitoring/download-progress") setDlProgress({ done: msg.done, total: msg.total, filename: msg.filename });
      if (msg.type === "monitoring/rows") setRows(msg.rows);
      if (msg.type === "monitoring/done") {
        setDoneInfo({ success: msg.success, failed: msg.failed });
        setRunning(false);
        setStatus("");
      }
      if (msg.type === "monitoring/error") {
        setError(msg.error);
        setRunning(false);
        setStatus("");
      }
    });

    port.onDisconnect.addListener(() => { setRunning(false); });

    port.postMessage({
      type: "siman/monitoring-run",
      idTipePengelolaan: selectedTipe,
      filterId: 0, // will use role's idKpknl in background
      idStatus: selectedStatus,
      termohon: selectedTermohon,
      downloadKelengkapan: dlKelengkapan,
      downloadAnalisis: dlAnalisis,
      downloadSk: dlSk,
      downloadTindakLanjut: dlTindakLanjut,
      tahunSk,
    });
  }

  // Filter rows by Tahun SK (post-scrape, client-side)
  const filteredRows = useMemo(() => {
    if (!rows) return null;
    if (!tahunSk) return rows;
    return rows.filter((r) => {
      const noSk = r.no_sk;
      if (!noSk) return false;
      // Extract year: last segment of "/" split, e.g. S-43/MK/KNL.1701/2026 → 2026
      const parts = noSk.split("/");
      const lastPart = parts[parts.length - 1];
      return lastPart === tahunSk;
    });
  }, [rows, tahunSk]);

  function downloadXlsx() {
    if (!filteredRows) return;
    const wb = XLSX.utils.book_new();

    // Sheet 1: Detail per Aset
    const detailData = [
      COLUMNS.map((c) => c.label),
      ...filteredRows.map((r) => COLUMNS.map((c) => {
        const v = r[c.key];
        return typeof v === "number" ? v : String(v ?? "");
      })),
    ];
    const wsDetail = XLSX.utils.aoa_to_sheet(detailData);
    wsDetail["!cols"] = COLUMNS.map((col) => {
      let maxLen = col.label.length;
      for (const row of filteredRows) {
        const val = String(row[col.key] ?? "");
        if (val.length > maxLen) maxLen = Math.min(val.length, 50);
      }
      return { wch: maxLen + 2 };
    });
    XLSX.utils.book_append_sheet(wb, wsDetail, "Detail Aset");

    // Sheet 2: Ringkasan per Tiket
    const SUMMARY_COLS = [
      "No Tiket", "Tipe Pengelolaan", "Satker", "Kode Satker",
      "Pemohon", "Termohon", "Deskripsi", "Status",
      "No SK", "Tgl SK", "Tgl Dokumen Diterima", "Jumlah Aset",
      "Total Nilai Perolehan", "Total Nilai Buku",
      "Total Nilai Permohonan", "Total Nilai Persetujuan",
      "Jml Dok Analisis", "Jml Dok Kelengkapan", "Status Tindak Lanjut",
    ];
    // Group rows by no_tiket
    const ticketMap = new Map<string, typeof filteredRows>();
    for (const r of filteredRows) {
      const key = r.no_tiket;
      if (!ticketMap.has(key)) ticketMap.set(key, []);
      ticketMap.get(key)!.push(r);
    }
    const summaryData: (string | number)[][] = [SUMMARY_COLS];
    for (const [noTiket, group] of ticketMap) {
      const first = group[0];
      summaryData.push([
        noTiket,
        first.nama_tipe_pengelolaan,
        first.ur_satker,
        first.kd_satker,
        first.pemohon,
        first.termohon,
        first.deskripsi,
        first.status,
        first.no_sk,
        first.tgl_sk,
        first.tgl_dokumen_diterima,
        group.length,
        group.reduce((s, r) => s + (Number(r.nilai_perolehan) || 0), 0),
        group.reduce((s, r) => s + (Number(r.nilai_buku) || 0), 0),
        group.reduce((s, r) => s + (Number(r.nilai_permohonan) || 0), 0),
        group.reduce((s, r) => s + (Number(r.nilai_persetujuan) || 0), 0),
        Number(first.jumlah_dok_analisis) || 0,
        Number(first.jumlah_dok_kelengkapan) || 0,
        first.status_tindak_lanjut,
      ]);
    }
    const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);
    wsSummary["!cols"] = SUMMARY_COLS.map((label) => ({ wch: Math.max(label.length + 2, 15) }));
    XLSX.utils.book_append_sheet(wb, wsSummary, "Ringkasan");

    XLSX.writeFile(wb, `Monitoring_Pengelolaan_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  const selectStyle = "width:100%;font-size:12px;padding:5px 8px;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-sm);color:var(--text-primary);box-sizing:border-box";
  const labelStyle = "font-size:11px;color:var(--muted);display:block;margin-bottom:3px";
  const checkStyle = "display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-primary)";

  return (
    <div style="padding:12px;display:flex;flex-direction:column;gap:10px">
      {/* Status Tiket filter */}
      <div>
        <label style={labelStyle}>Status Tiket</label>
        <select style={selectStyle} value={selectedStatus} onChange={(e) => setSelectedStatus(Number((e.target as HTMLSelectElement).value))} disabled={running || loadingRef}>
          <option value={0}>{loadingRef ? "Memuat…" : "— Semua Status —"}</option>
          {statusList.map((s) => <option key={s.kd_status_tiket} value={s.kd_status_tiket}>{s.nm_status_tiket}</option>)}
        </select>
      </div>

      {/* Tipe Pengelolaan filter */}
      <div>
        <label style={labelStyle}>Tipe Pengelolaan</label>
        <select style={selectStyle} value={selectedTipe} onChange={(e) => setSelectedTipe(Number((e.target as HTMLSelectElement).value))} disabled={running || loadingRef}>
          <option value={0}>— Semua Tipe —</option>
          {tipeList.map((t) => <option key={t.id_tipe_pengelolaan} value={t.id_tipe_pengelolaan}>{t.nama_tipe_pengelolaan}</option>)}
        </select>
      </div>

      {/* Termohon filter */}
      <div>
        <label style={labelStyle}>Termohon</label>
        <select style={selectStyle} value={selectedTermohon} onChange={(e) => setSelectedTermohon(Number((e.target as HTMLSelectElement).value))} disabled={running || loadingRef}>
          <option value={0}>— Semua Termohon —</option>
          {termohonList.map((t) => <option key={t.id_struktur} value={t.id_struktur}>{t.nama_alias} ({t.penetapan})</option>)}
        </select>
      </div>

      {/* Tahun SK filter (post-scrape) */}
      <div>
        <label style={labelStyle}>Tahun SK Persetujuan <span style="font-size:10px;color:var(--muted)">(filter setelah scraping)</span></label>
        <input
          type="text"
          placeholder="Contoh: 2026"
          value={tahunSk}
          onInput={(e) => setTahunSk((e.target as HTMLInputElement).value.trim())}
          style={selectStyle}
          disabled={running}
        />
      </div>

      {/* Download toggles */}
      <div style="padding:8px;background:var(--surface-2);border-radius:var(--radius-sm)">
        <div style="font-size:11px;color:var(--muted);margin-bottom:6px">Auto-download dokumen:</div>
        <div style="display:flex;flex-wrap:wrap;gap:10px">
          <label style={checkStyle}>
            <input type="checkbox" checked={dlKelengkapan} onChange={(e) => setDlKelengkapan((e.target as HTMLInputElement).checked)} disabled={running} />
            Kelengkapan
          </label>
          <label style={checkStyle}>
            <input type="checkbox" checked={dlAnalisis} onChange={(e) => setDlAnalisis((e.target as HTMLInputElement).checked)} disabled={running} />
            Analisis
          </label>
          <label style={checkStyle}>
            <input type="checkbox" checked={dlSk} onChange={(e) => setDlSk((e.target as HTMLInputElement).checked)} disabled={running} />
            SK
          </label>
          <label style={checkStyle}>
            <input type="checkbox" checked={dlTindakLanjut} onChange={(e) => setDlTindakLanjut((e.target as HTMLInputElement).checked)} disabled={running} />
            Tindak Lanjut
          </label>
        </div>
      </div>

      {/* Start button */}
      <button class="btn btn--primary" style="font-size:12px;padding:8px 14px" onClick={start} disabled={running || loadingRef}>
        {running ? "⏳ Memproses…" : "🚀 Mulai Scraping"}
      </button>

      {/* Progress */}
      {running && (
        <div style="display:flex;flex-direction:column;gap:6px">
          {status && <p class="hint" style="margin:0">{status}</p>}
          {listProgress && (
            <div>
              <div style="font-size:11px;color:var(--muted);margin-bottom:3px">Daftar: {listProgress.done} / {listProgress.total || "?"}</div>
              <ProgressBar value={listProgress.done} max={listProgress.total || listProgress.done} />
            </div>
          )}
          {detailProgress && (
            <div>
              <div style="font-size:11px;color:var(--muted);margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
                Detail {detailProgress.done}/{detailProgress.total}: {detailProgress.noTiket}
              </div>
              <ProgressBar value={detailProgress.done} max={detailProgress.total} />
            </div>
          )}
          {dlProgress && (
            <div style="font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
              ⬇ {dlProgress.filename}
            </div>
          )}
        </div>
      )}

      {error && <p class="hint" style="color:var(--error);margin:0">{error}</p>}

      {/* Done info */}
      {doneInfo && !running && (
        <div style="padding:8px;background:color-mix(in srgb, var(--color-primary) 10%, transparent);border-radius:var(--radius-sm);font-size:12px;color:var(--text-primary)">
          ✅ Selesai — {rows?.length ?? 0} data di-scrape{tahunSk ? `, ${filteredRows?.length ?? 0} sesuai filter SK ${tahunSk}` : ""}.
          {(dlKelengkapan || dlAnalisis || dlSk) && (
            <span> Download: {doneInfo.success} berhasil{doneInfo.failed > 0 ? `, ${doneInfo.failed} gagal` : "."}</span>
          )}
        </div>
      )}

      {/* Results */}
      {filteredRows !== null && !running && (
        <div style="display:flex;flex-direction:column;gap:8px">
          <div style="display:flex;align-items:center;justify-content:space-between">
            <span style="font-size:12px;color:var(--text-primary);font-weight:600">{filteredRows.length} data ditemukan</span>
            <button class="btn btn--primary" style="font-size:11px;padding:5px 12px" onClick={downloadXlsx} disabled={!filteredRows.length}>⬇ Unduh XLSX</button>
          </div>
          {filteredRows.length === 0 && <p class="hint">Tidak ada data monitoring.</p>}
          {filteredRows.length > 0 && (
            <div style="font-size:10px;color:var(--muted)">
              {filteredRows.slice(0, 5).map((r, i) => (
                <div key={i} style="padding:3px 0;border-bottom:1px solid var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
                  {r.no_tiket} · {r.kd_brg} · {r.ur_sskel}{r.catatan ? ` (${r.catatan})` : ""} · {r.ur_satker}
                </div>
              ))}
              {filteredRows.length > 5 && <div style="padding-top:3px">+{filteredRows.length - 5} lainnya…</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProgressBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div style="height:4px;background:var(--surface-2);border-radius:2px;overflow:hidden">
      <div style={`width:${pct}%;height:100%;background:var(--color-primary);transition:width 0.2s`} />
    </div>
  );
}
