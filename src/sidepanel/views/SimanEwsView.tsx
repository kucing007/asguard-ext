import { useState, useEffect, useRef, useMemo, useCallback } from "preact/hooks";
import type { SimanEwsMsg, EwsRow } from "@/shared/types";
import * as XLSX from "xlsx";
import { Icon } from "../components/Icon";
import {
  CACHE_KEY, NOTES_STORE_KEY, CACHE_TTL,
  type CachedEws, type EwsNoteLocal,
  EWS_COLORS, computeFrozenSisa, formatCacheAge, formatDate,
  send, loadNotesMap, migrateLegacy,
} from "../siman/ews-shared";

const LIMIT_OPTIONS = [10, 25, 50, 100];

type FilterStatus = "semua" | "lewat" | "kritis" | "perhatian" | "aman";
type FilterRenewal = "semua" | "diperpanjang" | "beda" | "belum" | "dikonfirmasi" | "proses";

export function SimanEwsView({
  userName: _userName,
  onSelectTicket,
}: {
  userName: string;
  onSelectTicket: (noTiket: string) => void;
}) {
  const [cached, setCached] = useState<CachedEws | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const portRef = useRef<chrome.runtime.Port | null>(null);

  const [filterStatus, setFilterStatus] = useState<FilterStatus>("semua");
  const [filterRenewal, setFilterRenewal] = useState<FilterRenewal>("semua");
  const [filterAuthor, setFilterAuthor] = useState<string>("__all__");
  const [activeTab, setActiveTab] = useState<"belum" | "proses" | "perpanjang" | "tidak">("belum");
  const [displayLimit, setDisplayLimit] = useState(25);

  const [notes, setNotes] = useState<Map<string, EwsNoteLocal>>(new Map());
  const [syncingAll, setSyncingAll] = useState(false);
  const [bannerMsg, setBannerMsg] = useState<string | null>(null);

  // Reload notes when window regains focus (e.g. returning from detail view)
  const refreshNotes = useCallback(() => {
    loadNotesMap().then(setNotes);
  }, []);

  // Load cache + notes on mount + run legacy migration
  useEffect(() => {
    chrome.storage.local.get(CACHE_KEY, (res) => {
      const data = res[CACHE_KEY] as CachedEws | undefined;
      if (data?.rows) setCached(data);
      setLoading(false);

      if (data?.kpknlId != null) {
        migrateLegacy(data.kpknlId).then(() => loadNotesMap().then(setNotes));
        // Silent auto-pull from server on mount
        send<{ ok: boolean }>({ type: "ews/notes-fetch", kpknlId: data.kpknlId })
          .then(() => refreshNotes())
          .catch(() => {});
      } else {
        loadNotesMap().then(setNotes);
      }
    });

    // Listen for storage updates so the list reflects detail-view edits
    const onStorage = (changes: { [key: string]: chrome.storage.StorageChange }) => {
      if (changes[NOTES_STORE_KEY]) refreshNotes();
    };
    chrome.storage.onChanged.addListener(onStorage);
    return () => {
      chrome.storage.onChanged.removeListener(onStorage);
      portRef.current?.disconnect();
    };
  }, [refreshNotes]);

  function startScan() {
    if (running) return;
    setRunning(true);
    setError(null);
    setStatus("Menghubungkan…");
    setProgress(null);

    const port = chrome.runtime.connect({ name: "siman-ews" });
    portRef.current = port;

    port.onMessage.addListener((msg: SimanEwsMsg) => {
      if (msg.type === "ews/status") setStatus(msg.message);
      if (msg.type === "ews/progress") {
        setProgress({ done: msg.done, total: msg.total });
        setStatus(`Memproses ${msg.done}/${msg.total} tiket…`);
      }
      if (msg.type === "ews/rows") {
        const newCache: CachedEws = { rows: msg.rows, updatedAt: Date.now(), kpknlId: msg.kpknlId };
        setCached(newCache);
        chrome.storage.local.set({ [CACHE_KEY]: newCache });
      }
      if (msg.type === "ews/done") { setRunning(false); setStatus(""); }
      if (msg.type === "ews/error") {
        setError(msg.error);
        setRunning(false);
        setStatus("");
      }
    });
    port.onDisconnect.addListener(() => { setRunning(false); });
    port.postMessage({ type: "siman/ews-run", idTipePengelolaan: 5, idStatus: 3 });
  }

  async function handleSyncAll() {
    if (!cached?.kpknlId) {
      setBannerMsg("Cache KPKNL belum ada — jalankan scan terlebih dahulu.");
      return;
    }
    setSyncingAll(true);
    setBannerMsg("Menarik catatan dari server…");
    try {
      // When user filters by a specific author, request only their notes from server.
      const author = filterAuthor === "__all__" ? undefined : filterAuthor;
      const res = await send<{ ok: boolean; data?: EwsNoteLocal[]; error?: string }>({
        type: "ews/notes-fetch",
        kpknlId: cached.kpknlId,
        author,
      });
      if (res?.ok) {
        await refreshNotes();
        setBannerMsg(`✓ Sinkron: ${res.data?.length ?? 0} catatan diperbarui dari server.`);
      } else {
        setBannerMsg("Gagal sync: " + (res?.error || "tidak diketahui"));
      }
    } catch (e) {
      setBannerMsg("Gagal sync: " + String(e));
    } finally {
      setSyncingAll(false);
    }
  }

  // Stats (unfiltered)
  const stats = useMemo(() => {
    if (!cached?.rows) return null;
    const rows = cached.rows;
    const tikets = new Set(rows.map((r) => r.no_tiket));
    return {
      totalTiket: tikets.size,
      totalAset: rows.length,
      lewat: rows.filter((r) => r.status_ews === "lewat").length,
      kritis: rows.filter((r) => r.status_ews === "kritis").length,
      perhatian: rows.filter((r) => r.status_ews === "perhatian").length,
      aman: rows.filter((r) => r.status_ews === "aman").length,
    };
  }, [cached]);

  // Unique authors from notes (for author filter dropdown)
  const authorOptions = useMemo(() => {
    const set = new Set<string>();
    for (const n of notes.values()) {
      if (n.author) set.add(n.author);
    }
    return [...set].sort();
  }, [notes]);

  // Group rows by ticket, filtered by status + renewal + author
  const groupedRows = useMemo(() => {
    if (!cached?.rows) return [] as [string, EwsRow[]][];
    let filtered = filterStatus === "semua"
      ? cached.rows
      : cached.rows.filter((r) => r.status_ews === filterStatus);

    if (filterRenewal !== "semua") {
      filtered = filtered.filter((r) => {
        const conf = notes.get(r.no_tiket);
        if (filterRenewal === "diperpanjang") return r.renewal?.is_renewal === true || conf?.choice === "diperpanjang" || conf?.choice === "sudah_perpanjang";
        if (filterRenewal === "beda") return r.renewal && !r.renewal.is_renewal;
        if (filterRenewal === "belum") return !r.renewal && (r.status_ews === "lewat" || r.status_ews === "kritis") && !conf;
        if (filterRenewal === "dikonfirmasi") return !!conf;
        if (filterRenewal === "proses") return conf?.choice === "proses_perpanjangan";
        return true;
      });
    }

    if (filterAuthor !== "__all__") {
      filtered = filtered.filter((r) => {
        const c = notes.get(r.no_tiket);
        return c?.author === filterAuthor;
      });
    }

    const map = new Map<string, EwsRow[]>();
    for (const r of filtered) {
      if (!map.has(r.no_tiket)) map.set(r.no_tiket, []);
      map.get(r.no_tiket)!.push(r);
    }
    return [...map.entries()].sort((a, b) => {
      const minA = Math.min(...a[1].map((r) => r.sisa_hari));
      const minB = Math.min(...b[1].map((r) => r.sisa_hari));
      return minA - minB;
    });
  }, [cached, filterStatus, filterRenewal, filterAuthor, notes]);

  // Split into 4 tab buckets based on note choice
  const { rowsBelum, rowsProses, rowsPerpanjang, rowsTidak } = useMemo(() => {
    const belum:     [string, EwsRow[]][] = [];
    const proses:    [string, EwsRow[]][] = [];
    const perpanjang: [string, EwsRow[]][] = [];
    const tidak:     [string, EwsRow[]][] = [];
    for (const entry of groupedRows) {
      const choice = notes.get(entry[0])?.choice;
      if (!choice) {
        belum.push(entry);
      } else if (choice === "proses_perpanjangan") {
        proses.push(entry);
      } else if (choice === "sudah_perpanjang" || choice === "diperpanjang") {
        perpanjang.push(entry);
      } else {
        tidak.push(entry);
      }
    }
    return { rowsBelum: belum, rowsProses: proses, rowsPerpanjang: perpanjang, rowsTidak: tidak };
  }, [groupedRows, notes]);

  function downloadXlsx() {
    if (!cached?.rows?.length) return;
    const wb = XLSX.utils.book_new();

    const DETAIL_COLS = [
      "No Tiket", "Tipe Pengelolaan", "Satker", "Kode Satker",
      "No SK", "Tgl SK", "Kode Barang", "NUP", "Uraian Barang",
      "Tujuan Permohonan", "Jangka Waktu (Bulan)", "Tgl Berakhir",
      "Sisa Waktu", "Status EWS", "Nilai Persetujuan",
      "PKS Mulai", "PKS Berakhir", "PKS Sisa",
      "Konfirmasi", "Tiket Perpanjangan", "Surat Persetujuan", "Catatan", "Author",
    ];
    const choiceLabel = (c?: string) =>
      c === "sudah_perpanjang" || c === "diperpanjang" ? "Sudah Perpanjang"
      : c === "proses_perpanjangan" ? "Proses Perpanjangan"
      : c === "tidak" ? "Tidak Diperpanjang" : "";
    const detailData: (string | number)[][] = [DETAIL_COLS];
    for (const r of cached.rows) {
      const n = notes.get(r.no_tiket);
      detailData.push([
        r.no_tiket, r.nama_tipe_pengelolaan, r.ur_satker, r.kd_satker,
        r.no_sk, r.tgl_sk, r.kd_brg, r.nup, r.ur_sskel,
        r.tujuan_permohonan, r.ref_jangka_waktu, r.tgl_berakhir,
        r.sisa_label, r.status_ews.toUpperCase(), r.nilai_persetujuan,
        r.pks_tgl_perjanjian ?? "-", r.pks_tgl_berakhir ?? "-", r.pks_sisa_label ?? "-",
        choiceLabel(n?.choice),
        n?.no_tiket_perpanjangan ?? "",
        n?.surat_persetujuan ?? "",
        n?.note ?? "",
        n?.author ?? "",
      ]);
    }
    const ws1 = XLSX.utils.aoa_to_sheet(detailData);
    ws1["!cols"] = DETAIL_COLS.map((c) => ({ wch: Math.max(c.length + 2, 14) }));
    XLSX.utils.book_append_sheet(wb, ws1, "Detail Aset");

    const SUMMARY_COLS = [
      "No Tiket", "Satker", "No SK", "Tgl SK",
      "Jumlah Aset", "Aset Kritis", "Aset Perhatian", "Aset Aman",
      "Berakhir Terdekat", "Sisa Waktu", "Total Persetujuan",
      "PKS Mulai", "PKS Berakhir", "PKS Sisa",
      "Konfirmasi", "Tiket Perpanjangan", "Surat Persetujuan", "Catatan", "Author",
    ];
    const summaryData: (string | number)[][] = [SUMMARY_COLS];
    for (const [noTiket, group] of groupedRows) {
      const first = group[0];
      const minSisa = Math.min(...group.map((r) => r.sisa_hari));
      const nearest = group.find((r) => r.sisa_hari === minSisa);
      const n = notes.get(noTiket);
      summaryData.push([
        noTiket, first.ur_satker, first.no_sk, first.tgl_sk,
        group.length,
        group.filter((r) => r.status_ews === "kritis").length,
        group.filter((r) => r.status_ews === "perhatian").length,
        group.filter((r) => r.status_ews === "aman").length,
        nearest?.tgl_berakhir ?? "",
        nearest?.sisa_label ?? "",
        group.reduce((s, r) => s + r.nilai_persetujuan, 0),
        first.pks_tgl_perjanjian ?? "-", first.pks_tgl_berakhir ?? "-", first.pks_sisa_label ?? "-",
        choiceLabel(n?.choice),
        n?.no_tiket_perpanjangan ?? "",
        n?.surat_persetujuan ?? "",
        n?.note ?? "",
        n?.author ?? "",
      ]);
    }
    const ws2 = XLSX.utils.aoa_to_sheet(summaryData);
    ws2["!cols"] = SUMMARY_COLS.map((c) => ({ wch: Math.max(c.length + 2, 14) }));
    XLSX.utils.book_append_sheet(wb, ws2, "Ringkasan");

    XLSX.writeFile(wb, `EWS_Pemanfaatan_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  const cardStyle = "padding:10px;background:var(--surface-2);border-radius:var(--radius-sm);border:1px solid var(--line)";
  const selectStyle = "font-size:11px;padding:4px 6px;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-sm);color:var(--text-primary)";

  if (loading) return <p class="hint">Memuat data…</p>;

  return (
    <div style="padding:12px;display:flex;flex-direction:column;gap:10px">
      {/* Cache info */}
      {cached && (
        <div style={`${cardStyle};display:flex;align-items:center;justify-content:space-between;gap:8px`}>
          <div style="font-size:11px;color:var(--muted);min-width:0;display:flex;align-items:center;gap:4px">
            <Icon name="calendar" size={13} /> Data terakhir: {formatDate(cached.updatedAt)}<br />
            <span style="font-size:10px">({formatCacheAge(cached.updatedAt)})</span>
            {Date.now() - cached.updatedAt > CACHE_TTL && (
              <span style="color:var(--warning);font-weight:600"> — Perlu diperbarui</span>
            )}
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0">
            <button
              class="btn"
              style="font-size:11px;padding:5px 10px"
              onClick={handleSyncAll}
              disabled={syncingAll || !cached.kpknlId}
              title="Tarik catatan terbaru dari server"
            >
              <Icon name={syncingAll ? "loader" : "refresh-cw"} size={13} /> Sync
            </button>
            <button
              class="btn btn--primary"
              style="font-size:11px;padding:5px 12px"
              onClick={startScan}
              disabled={running}
            >
              <Icon name="refresh-cw" size={13} /> Update
            </button>
          </div>
        </div>
      )}

      {bannerMsg && (
        <div style="padding:6px 10px;background:rgba(99,102,241,0.12);border:1px solid #6366f1;border-radius:var(--radius-sm);font-size:11px;color:#a5b4fc">
          {bannerMsg}
        </div>
      )}

      {/* No cache yet */}
      {!cached && !running && (
        <div style={`${cardStyle};text-align:center`}>
          <p style="font-size:12px;color:var(--muted);margin:0 0 8px">
            Belum ada data EWS. Klik tombol di bawah untuk memulai scan.
          </p>
          <button
            class="btn btn--primary"
            style="font-size:12px;padding:8px 16px"
            onClick={startScan}
          >
            <Icon name="rocket" size={14} /> Scan Data EWS
          </button>
        </div>
      )}

      {/* Progress */}
      {running && (
        <div style="display:flex;flex-direction:column;gap:6px">
          {status && <p class="hint" style="margin:0">{status}</p>}
          {progress && (
            <div>
              <div style="font-size:11px;color:var(--muted);margin-bottom:3px">
                {progress.done} / {progress.total || "?"}
              </div>
              <ProgressBar value={progress.done} max={progress.total || progress.done} />
            </div>
          )}
        </div>
      )}

      {error && <p class="hint" style="color:var(--error);margin:0">{error}</p>}

      {/* Stats summary */}
      {stats && !running && (
        <div style={cardStyle}>
          <div style="font-size:12px;font-weight:700;color:var(--text-primary);margin-bottom:6px;display:flex;align-items:center;gap:5px">
            <Icon name="bar-chart" size={14} /> Ringkasan: {stats.totalTiket} tiket, {stats.totalAset} aset
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <StatBadge label="Lewat" count={stats.lewat} color="var(--ews-lewat)" />
            <StatBadge label="Kritis" count={stats.kritis} color="var(--ews-kritis)" />
            <StatBadge label="Perhatian" count={stats.perhatian} color="var(--ews-perhatian)" />
            <StatBadge label="Aman" count={stats.aman} color="var(--ews-aman)" />
          </div>
          {cached!.rows.length > 0 && (
            <div style="margin-top:8px">
              <button class="btn btn--primary" style="font-size:11px;padding:5px 12px;display:inline-flex;align-items:center;gap:4px" onClick={downloadXlsx}>
                <Icon name="download" size={13} /> Unduh XLSX
              </button>
            </div>
          )}
        </div>
      )}

      {/* Filters & pagination */}
      {cached && !running && (
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <div style="display:flex;align-items:center;gap:4px">
            <label style="font-size:10px;color:var(--muted)">Status:</label>
            <select
              style={selectStyle}
              value={filterStatus}
              onChange={(e) => { setFilterStatus((e.target as HTMLSelectElement).value as FilterStatus); setDisplayLimit(25); }}
            >
              <option value="semua">Semua</option>
              <option value="lewat">⚫ Lewat</option>
              <option value="kritis">🔴 Kritis</option>
              <option value="perhatian">🟡 Perhatian</option>
              <option value="aman">🟢 Aman</option>
            </select>
          </div>
          <div style="display:flex;align-items:center;gap:4px">
            <label style="font-size:10px;color:var(--muted)">Perpanjangan:</label>
            <select
              style={selectStyle}
              value={filterRenewal}
              onChange={(e) => { setFilterRenewal((e.target as HTMLSelectElement).value as FilterRenewal); setDisplayLimit(25); }}
            >
              <option value="semua">Semua</option>
              <option value="diperpanjang">✅ Diperpanjang</option>
              <option value="beda">⚠ Beda Peruntukan</option>
              <option value="belum">⚠️ Belum Perpanjangan</option>
              <option value="dikonfirmasi">📌 Dikonfirmasi</option>
              <option value="proses">🔄 Proses Perpanjangan</option>
            </select>
          </div>
          {authorOptions.length > 0 && (
            <div style="display:flex;align-items:center;gap:4px">
              <label style="font-size:10px;color:var(--muted)">Author:</label>
              <select
                style={selectStyle}
                value={filterAuthor}
                onChange={(e) => { setFilterAuthor((e.target as HTMLSelectElement).value); setDisplayLimit(25); }}
              >
                <option value="__all__">Semua</option>
                {authorOptions.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </div>
          )}
          <div style="display:flex;align-items:center;gap:4px">
            <label style="font-size:10px;color:var(--muted)">Tampilkan:</label>
            <select
              style={selectStyle}
              value={displayLimit}
              onChange={(e) => setDisplayLimit(Number((e.target as HTMLSelectElement).value))}
            >
              {LIMIT_OPTIONS.map((n) => (
                <option key={n} value={n}>{n} tiket</option>
              ))}
              <option value={9999}>Semua</option>
            </select>
          </div>
          <span style="font-size:10px;color:var(--muted);margin-left:auto">
            {groupedRows.length} tiket
          </span>
        </div>
      )}

      {/* 4-tab segmented control */}
      {cached && !running && groupedRows.length > 0 && (() => {
        type Tab = "belum" | "proses" | "perpanjang" | "tidak";
        const TABS: { id: Tab; emoji: string; label: string; count: number; activeColor: string }[] = [
          { id: "belum",      emoji: "📋", label: "Belum",       count: rowsBelum.length,      activeColor: "var(--color-primary)" },
          { id: "proses",     emoji: "🔄", label: "Proses",      count: rowsProses.length,     activeColor: "var(--ews-perhatian)" },
          { id: "perpanjang", emoji: "✅", label: "Perpanjang",  count: rowsPerpanjang.length, activeColor: "var(--ews-confirmed)" },
          { id: "tidak",      emoji: "❌", label: "Tidak",       count: rowsTidak.length,      activeColor: "var(--ews-dismissed)" },
        ];
        return (
          <div style="display:flex;gap:2px;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-sm);padding:2px">
            {TABS.map(({ id, emoji, label, count, activeColor }) => (
              <button
                key={id}
                type="button"
                onClick={() => { setActiveTab(id); setDisplayLimit(25); }}
                style={`flex:1;padding:5px 4px;border-radius:calc(var(--radius-sm) - 2px);font-size:10px;font-weight:600;border:none;cursor:pointer;transition:all 0.15s;text-align:center;white-space:nowrap;${
                  activeTab === id
                    ? `background:${activeColor};color:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.2)`
                    : "background:transparent;color:var(--muted)"
                }`}
              >
                {emoji}<br />{label}<br />
                <span style={`font-size:12px;font-weight:700;${activeTab === id ? "color:#fff" : "color:var(--text-primary)"}`}>{count}</span>
              </button>
            ))}
          </div>
        );
      })()}

      {/* Ticket list for active tab */}
      {cached && !running && (() => {
        const rowMap: Record<string, [string, EwsRow[]][]> = {
          belum: rowsBelum,
          proses: rowsProses,
          perpanjang: rowsPerpanjang,
          tidak: rowsTidak,
        };
        const rows = rowMap[activeTab] ?? [];
        const displayed = rows.slice(0, displayLimit);
        const dimmed = activeTab !== "belum";
        if (displayed.length === 0) return (
          <p class="hint" style="text-align:center;margin:0">
            Tidak ada tiket di tab ini.
          </p>
        );
        return (
          <div style={`display:flex;flex-direction:column;gap:4px${dimmed ? ";opacity:0.85" : ""}`}>
            {displayed.map(([noTiket, group]) => {
              const conf = notes.get(noTiket);
              // Compute frozen sisa based on tab:
              // - perpanjang: freeze at tgl_surat (SK date)
              // - tidak: freeze at conf.updated_at
              const frozenDate =
                activeTab === "perpanjang" ? (group[0].renewal?.tgl_surat ?? null)
                : activeTab === "tidak" ? (conf?.updated_at ?? null)
                : null;
              const frozenSisa = frozenDate ? computeFrozenSisa(group[0].tgl_berakhir, frozenDate) : null;
              const minSisa = frozenSisa ? frozenSisa.sisa_hari : Math.min(...group.map((r) => r.sisa_hari));
              const worstStatus = minSisa <= 0 ? "lewat" : minSisa <= 90 ? "kritis" : minSisa <= 180 ? "perhatian" : "aman";
              const colors = EWS_COLORS[worstStatus];
              const nearest = group.find((r) => r.sisa_hari === Math.min(...group.map((r2) => r2.sisa_hari)));
              const sisaLabel = frozenSisa
                ? `${frozenSisa.sisa_label} (saat ${activeTab === "perpanjang" ? "SK" : "konfirmasi"})`
                : (nearest?.sisa_label ?? "");
              return (
                <CompactTicketRow
                  key={noTiket}
                  noTiket={noTiket}
                  satker={group[0].ur_satker}
                  sisaLabel={sisaLabel}
                  assetCount={group.length}
                  colors={colors}
                  conf={conf}
                  pksLabel={group[0].pks_sisa_label ?? undefined}
                  onClick={() => onSelectTicket(noTiket)}
                />
              );
            })}
            {rows.length > displayLimit && (
              <button
                class="btn"
                style="font-size:11px;padding:6px 12px;color:var(--text-primary);border:1px solid var(--line);margin-top:4px"
                onClick={() => setDisplayLimit((prev) => prev + 25)}
              >
                Tampilkan lebih banyak ({rows.length - displayLimit} tersisa)
              </button>
            )}
          </div>
        );
      })()}

      {cached && !running && groupedRows.length === 0 && (
        <p class="hint" style="text-align:center">
          {filterStatus === "semua" && filterRenewal === "semua" && filterAuthor === "__all__"
            ? "Tidak ada data aset sewa ditemukan."
            : "Tidak ada tiket sesuai filter."}
        </p>
      )}
    </div>
  );
}

function CompactTicketRow({
  noTiket, satker, sisaLabel, assetCount, colors, conf, pksLabel, onClick,
}: {
  noTiket: string;
  satker: string;
  sisaLabel: string;
  assetCount: number;
  colors: { border: string; text: string };
  conf?: EwsNoteLocal;
  pksLabel?: string;
  onClick: () => void;
}) {
  const isConfirmed = !!conf;
  const confColor = conf
    ? (conf.choice === "diperpanjang" || conf.choice === "sudah_perpanjang")
      ? "var(--ews-confirmed)"
      : conf.choice === "proses_perpanjangan"
        ? "var(--ews-perhatian)"
        : "var(--ews-dismissed)"
    : "";
  const borderColor = isConfirmed ? confColor : colors.border;
  const synced = !!conf?.last_synced_at;

  return (
    <button
      type="button"
      onClick={onClick}
      style={`display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:var(--radius-sm);border:1px solid var(--line);border-left:3px solid ${borderColor};background:var(--surface-2);cursor:pointer;text-align:left;width:100%;color:var(--text-primary);transition:background 0.15s`}
    >
      <span style={`width:8px;height:8px;border-radius:50%;background:${isConfirmed ? borderColor : colors.border};flex-shrink:0`} />
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
          {noTiket}
        </div>
        <div style="font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px">
          {satker}
        </div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:2px;flex-shrink:0">
        {sisaLabel && (
          <span style={`font-size:11px;font-weight:600;color:${colors.text};white-space:nowrap`}>
            {sisaLabel}
          </span>
        )}
        <span style="font-size:11px;color:var(--muted);white-space:nowrap">
          {assetCount} aset{synced ? " · ✓" : ""}
        </span>
        {pksLabel && (
          <span style="font-size:10px;color:var(--muted);white-space:nowrap">PKS: {pksLabel}</span>
        )}
      </div>
    </button>
  );
}

function StatBadge({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div style={`display:flex;align-items:center;gap:5px;font-size:12px;padding:4px 10px;border-radius:var(--radius-sm);background:var(--surface-2);border:1px solid var(--line)`}>
      <span style={`width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0`} />
      <span style="color:var(--muted)">{label}</span>
      <span style={`font-weight:700;color:${color}`}>{count}</span>
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
