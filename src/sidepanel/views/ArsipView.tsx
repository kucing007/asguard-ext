import { useEffect, useRef, useState } from "preact/hooks";
import type {
  ApiResult,
  ArsipBerkas,
  ArsipDocType,
  ArsipGroup,
  ArsipItem,
  ArsipKlasifikasi,
  ArsipPortMsg,
  ArsipProgressMsg,
} from "@/shared/types";
import { extractPdfFromBase64 } from "@/sidepanel/pdf-extract";

function send<T>(msg: unknown): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

function todayDMY(): string {
  const d = new Date();
  return [
    String(d.getDate()).padStart(2, "0"),
    String(d.getMonth() + 1).padStart(2, "0"),
    d.getFullYear(),
  ].join("-");
}

function fmtDate(iso?: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
  } catch { return iso; }
}

const DOC_LABELS: Record<ArsipDocType, string> = {
  konsep: "Surat Keluar",
  amplop: "Surat Masuk",
  disposisi: "Disposisi",
};

interface Props { onBack: () => void }

type Step = "setup" | "list" | "berkas" | "auto-run" | "done";
type AutoPhase = "fetching" | "classifying" | "confirming" | "archiving";

interface DoneStats { success: number; skipped: number; created: number; failed: number }

export function ArsipView({ onBack }: Props) {
  const [step, setStep] = useState<Step>("setup");

  // --- Setup ---
  const [docType, setDocType] = useState<ArsipDocType>("konsep");
  const [mode, setMode] = useState<"manual" | "auto" | "auto-ai">("manual");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState(todayDMY());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- Manual: list ---
  const [items, setItems] = useState<ArsipItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [listSearch, setListSearch] = useState("");

  // --- Manual: berkas ---
  const [berkasList, setBerkasList] = useState<ArsipBerkas[]>([]);
  const [chosenBerkasId, setChosenBerkasId] = useState<number | null>(null);
  const [showNewBerkas, setShowNewBerkas] = useState(false);
  const [klasList, setKlasList] = useState<ArsipKlasifikasi[]>([]);
  const [klasSearch, setKlasSearch] = useState("");
  const [chosenKlasId, setChosenKlasId] = useState<number | null>(null);
  const [newBerkasUraian, setNewBerkasUraian] = useState("");
  const [newBerkasYear, setNewBerkasYear] = useState(String(new Date().getFullYear()));
  const [berkasCreating, setBerkasCreating] = useState(false);
  const [archiving, setArchiving] = useState(false);

  // --- Auto: run ---
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const [autoPhase, setAutoPhase] = useState<AutoPhase>("fetching");
  const [autoStatus, setAutoStatus] = useState("");
  const [classifyDone, setClassifyDone] = useState(0);
  const [classifyTotal, setClassifyTotal] = useState(0);
  const [autoGroups, setAutoGroups] = useState<ArsipGroup[]>([]);
  const [groupSteps, setGroupSteps] = useState<Record<number, string>>({});

  // --- Done ---
  const [doneStats, setDoneStats] = useState<DoneStats | null>(null);

  useEffect(() => () => { portRef.current?.disconnect(); }, []);

  // ---- Handlers ----

  async function handleFetch() {
    if (!startDate) { setError("Masukkan tanggal mulai"); return; }
    setError(null);
    setLoading(true);

    if (mode === "auto" || mode === "auto-ai") {
      setStep("auto-run");
      setAutoPhase("fetching");
      setAutoStatus("Menghubungkan...");
      setAutoGroups([]);
      setGroupSteps({});

      const port = chrome.runtime.connect({ name: "arsip-run" });
      portRef.current = port;

      port.onMessage.addListener((msg: ArsipProgressMsg) => {
        if (msg.type === "arsip/pdf-extract") {
          extractPdfFromBase64(msg.base64, msg.maxPages ?? 5)
            .then(text => port.postMessage({ type: "arsip/pdf-text", text, ndId: msg.ndId } as ArsipPortMsg))
            .catch(() => port.postMessage({ type: "arsip/pdf-text", text: "", ndId: msg.ndId } as ArsipPortMsg));
          return;
        }
        if (msg.type === "arsip/status") {
          setAutoStatus(msg.message);
        } else if (msg.type === "arsip/classify-progress") {
          setAutoPhase("classifying");
          setClassifyDone(msg.done);
          setClassifyTotal(msg.total);
          setAutoStatus(mode === "auto-ai"
            ? `Menganalisis klasifikasi ... (${msg.done}/${msg.total})`
            : `Menganalisis klasifikasi ... (${msg.done}/${msg.total})`);
        } else if (msg.type === "arsip/groups") {
          setAutoPhase("confirming");
          setAutoGroups(msg.groups);
        } else if (msg.type === "arsip/group-step") {
          setAutoPhase("archiving");
          setGroupSteps(prev => ({ ...prev, [msg.index]: msg.step }));
        } else if (msg.type === "arsip/complete") {
          setDoneStats(msg);
          setStep("done");
          port.disconnect();
        } else if (msg.type === "arsip/error") {
          setError(msg.error);
          setStep("setup");
          port.disconnect();
        }
      });

      port.onDisconnect.addListener(() => { setLoading(false); });

      port.postMessage({ type: "arsip/start-auto", docType, startDate, endDate, useAI: mode === "auto-ai" } as ArsipPortMsg);
      setLoading(false);
      return;
    }

    // Manual: fetch items
    try {
      const res = await send<ApiResult<ArsipItem[]>>({
        type: "arsip/fetch", docType, startDate, endDate, limit: 500,
      });
      if (!res.ok) { setError(res.error); setLoading(false); return; }
      setItems(res.data);
      setSelectedIds(new Set(res.data.map(i => String(i.Id))));
      setStep("list");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function handleGoToBerkas() {
    setLoading(true);
    setError(null);
    try {
      const res = await send<ApiResult<ArsipBerkas[]>>({ type: "arsip/berkas-list" });
      if (!res.ok) { setError(res.error); return; }
      setBerkasList(res.data);
      setChosenBerkasId(null);
      setStep("berkas");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function handleShowNewBerkas() {
    setShowNewBerkas(true);
    if (klasList.length === 0) {
      try {
        const res = await send<ApiResult<ArsipKlasifikasi[]>>({ type: "arsip/klasifikasi-fav" });
        if (res.ok) setKlasList(res.data);
      } catch { /* proceed */ }
    }
  }

  async function handleLoadAllKlasifikasi() {
    try {
      const res = await send<ApiResult<ArsipKlasifikasi[]>>({ type: "arsip/klasifikasi-all" });
      if (res.ok) {
        const flat: ArsipKlasifikasi[] = [];
        const flatten = (arr: ArsipKlasifikasi[]) => {
          for (const k of arr) { flat.push(k); if (k.Children?.length) flatten(k.Children); }
        };
        flatten(res.data);
        setKlasList(flat);
      }
    } catch { /* proceed */ }
  }

  async function handleCreateBerkas() {
    if (!chosenKlasId || !newBerkasUraian) return;
    setBerkasCreating(true);
    try {
      await send({ type: "arsip/berkas-create", klasifikasiArsipId: chosenKlasId, uraianBerkas: newBerkasUraian, kurunWaktu: newBerkasYear });
      const res = await send<ApiResult<ArsipBerkas[]>>({ type: "arsip/berkas-list" });
      if (res.ok) {
        setBerkasList(res.data);
        setShowNewBerkas(false);
        setKlasSearch("");
        setNewBerkasUraian("");
      }
    } catch { /* proceed */ } finally {
      setBerkasCreating(false);
    }
  }

  async function handleArchive() {
    if (!chosenBerkasId) return;
    const sel = items.filter(i => selectedIds.has(String(i.Id)));
    setArchiving(true);
    setError(null);
    try {
      const res = await send<ApiResult<unknown>>({
        type: "arsip/bulk",
        docType,
        berkasId: chosenBerkasId,
        items: sel.map(i => ({ Id: String(i.Id), NdId: i.NdId })),
      });
      if (!res.ok) { setError(res.error); return; }
      setDoneStats({ success: sel.length, skipped: 0, created: 0, failed: 0 });
      setStep("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setArchiving(false);
    }
  }

  function handleConfirmAuto() {
    portRef.current?.postMessage({ type: "arsip/confirm" } as ArsipPortMsg);
    setAutoPhase("archiving");
    setGroupSteps({});
  }

  function handleAbortAuto() {
    portRef.current?.postMessage({ type: "arsip/abort" } as ArsipPortMsg);
    portRef.current?.disconnect();
    onBack();
  }

  // ---- Render ----

  if (step === "done" && doneStats) {
    return (
      <div class="arsip-view fade-in">
        <div class="arsip-done">
          <div class="arsip-done__icon">📦</div>
          <h2 class="arsip-done__title">Selesai</h2>
          <div class="arsip-done__stats">
            {doneStats.success > 0 && <p class="arsip-done__ok">{doneStats.success} naskah berhasil diarsipkan</p>}
            {doneStats.created > 0 && <p class="arsip-done__info">{doneStats.created} berkas baru dibuat</p>}
            {doneStats.skipped > 0 && <p class="arsip-done__warn">{doneStats.skipped} naskah dilewati (tanpa klasifikasi)</p>}
            {doneStats.failed > 0 && <p class="arsip-done__err">{doneStats.failed} naskah gagal diarsipkan</p>}
          </div>
          <button class="btn btn--ghost" onClick={onBack}>Kembali</button>
        </div>
      </div>
    );
  }

  if (step === "auto-run") {
    const totalItems = autoGroups.reduce((s, g) => s + g.count, 0);
    return (
      <div class="arsip-view fade-in">
        {(autoPhase === "fetching" || autoPhase === "classifying") && (
          <>
            <div class="arsip-status">
              <span class="arsip-spinner">⏳</span>
              <span>{autoStatus}</span>
            </div>
            {autoPhase === "classifying" && classifyTotal > 0 && (
              <div class="arsip-progress-bar">
                <div class="arsip-progress-bar__fill" style={{ width: `${(classifyDone / classifyTotal) * 100}%` }} />
              </div>
            )}
          </>
        )}

        {autoPhase === "confirming" && (
          <>
            <p class="arsip-status-text">{autoGroups.length} kelompok klasifikasi ditemukan</p>
            <div class="arsip-groups">
              {autoGroups.map(g => (
                <div key={g.kode} class="arsip-group-row">
                  <span class="arsip-group-kode">{g.kode}</span>
                  <span class="arsip-group-count">{g.count} naskah</span>
                  <span class={`arsip-group-badge ${g.berkasExists ? "arsip-group-badge--ok" : "arsip-group-badge--new"}`}>
                    {g.berkasExists ? "ada" : "buat baru"}
                  </span>
                </div>
              ))}
            </div>
            <div class="arsip-actions">
              <button class="btn btn--primary" onClick={handleConfirmAuto}>
                Arsipkan {totalItems} Naskah
              </button>
              <button class="btn btn--ghost" onClick={handleAbortAuto}>Batal</button>
            </div>
          </>
        )}

        {autoPhase === "archiving" && (
          <>
            <p class="arsip-status-text">Mengarsipkan...</p>
            <div class="arsip-groups">
              {autoGroups.map((g, i) => (
                <div key={g.kode} class="arsip-group-row">
                  <span class="arsip-group-kode">{g.kode}</span>
                  <span class="arsip-group-step">{groupSteps[i] ?? "⏳"}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    );
  }

  if (step === "berkas") {
    const filteredKlas = klasList.filter(k => {
      if (!klasSearch) return false;
      const s = klasSearch.toLowerCase();
      return (k.KodeKlasifikasi ?? "").toLowerCase().includes(s) || (k.Nama ?? "").toLowerCase().includes(s);
    }).slice(0, 20);

    return (
      <div class="arsip-view fade-in">
        <h2 class="section-title">Pilih Berkas Arsip</h2>
        <p class="hint">{selectedIds.size} naskah akan diarsipkan</p>

        {error && <p class="error-text">{error}</p>}

        {!showNewBerkas ? (
          <>
            <div class="arsip-berkas-list">
              {berkasList.length === 0 && <p class="hint">Belum ada berkas tersedia.</p>}
              {berkasList.map(b => (
                <button
                  key={b.Id}
                  class={`arsip-berkas-item ${chosenBerkasId === b.Id ? "arsip-berkas-item--active" : ""}`}
                  onClick={() => setChosenBerkasId(b.Id)}
                >
                  <span class="arsip-berkas-kode">{b.KlasifikasiArsip?.KodeKlasifikasi ?? "—"}</span>
                  <span class="arsip-berkas-uraian">{b.UraianBerkas ?? "—"}</span>
                  <span class="arsip-berkas-year">{b.KurunWaktu}</span>
                </button>
              ))}
            </div>
            <div class="arsip-actions">
              <button class="btn btn--primary" disabled={!chosenBerkasId || archiving} onClick={handleArchive}>
                {archiving ? "Mengarsipkan..." : `Arsipkan ${selectedIds.size} Naskah`}
              </button>
              <button class="btn btn--ghost" onClick={handleShowNewBerkas}>+ Berkas Baru</button>
              <button class="btn btn--ghost" onClick={() => setStep("list")}>Kembali</button>
            </div>
          </>
        ) : (
          <div class="arsip-new-berkas card">
            <h3 class="card__title">Berkas Baru</h3>

            <label class="field">
              <span class="field__label">Cari Klasifikasi Arsip</span>
              <input
                class="field__input"
                placeholder="Kode atau nama klasifikasi..."
                value={klasSearch}
                onInput={e => setKlasSearch((e.target as HTMLInputElement).value)}
              />
              {klasList.length === 0 && (
                <button class="btn btn--sm btn--ghost" style={{ marginTop: "4px" }} onClick={handleLoadAllKlasifikasi}>
                  Muat Semua Klasifikasi
                </button>
              )}
              {klasSearch && (
                <div class="arsip-klas-list">
                  {filteredKlas.length === 0 && klasList.length > 0 && (
                    <p class="hint" style={{ padding: "8px" }}>Tidak ditemukan</p>
                  )}
                  {filteredKlas.map(k => (
                    <button
                      key={k.Id}
                      class={`arsip-klas-item ${chosenKlasId === k.Id ? "arsip-klas-item--active" : ""}`}
                      onClick={() => { setChosenKlasId(k.Id); setKlasSearch(`${k.KodeKlasifikasi} - ${k.Nama}`); }}
                    >
                      <span class="arsip-klas-kode">{k.KodeKlasifikasi}</span>
                      <span class="arsip-klas-nama">{k.Nama}</span>
                    </button>
                  ))}
                </div>
              )}
            </label>

            <label class="field">
              <span class="field__label">Uraian Berkas</span>
              <input
                class="field__input"
                placeholder="Deskripsi berkas..."
                value={newBerkasUraian}
                onInput={e => setNewBerkasUraian((e.target as HTMLInputElement).value)}
              />
            </label>

            <label class="field">
              <span class="field__label">Tahun</span>
              <input
                class="field__input"
                type="number"
                value={newBerkasYear}
                onInput={e => setNewBerkasYear((e.target as HTMLInputElement).value)}
              />
            </label>

            <div class="arsip-actions">
              <button
                class="btn btn--primary"
                disabled={!chosenKlasId || !newBerkasUraian || berkasCreating}
                onClick={handleCreateBerkas}
              >
                {berkasCreating ? "Membuat..." : "Buat Berkas"}
              </button>
              <button class="btn btn--ghost" onClick={() => { setShowNewBerkas(false); setKlasSearch(""); }}>
                Batal
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (step === "list") {
    const q = listSearch.trim().toLowerCase();
    const visible = q
      ? items.filter(i =>
        (i.Perihal ?? "").toLowerCase().includes(q) ||
        (i.NoNd ?? "").toLowerCase().includes(q) ||
        (i.Pengirim ?? "").toLowerCase().includes(q)
      )
      : items;

    const visibleIds = visible.map(i => String(i.Id));
    const allVisibleSelected = visibleIds.length > 0 && visibleIds.every(id => selectedIds.has(id));

    function toggleAll() {
      setSelectedIds(prev => {
        const n = new Set(prev);
        if (allVisibleSelected) visibleIds.forEach(id => n.delete(id));
        else visibleIds.forEach(id => n.add(id));
        return n;
      });
    }

    function toggleItem(id: string) {
      setSelectedIds(prev => {
        const n = new Set(prev);
        n.has(id) ? n.delete(id) : n.add(id);
        return n;
      });
    }

    return (
      <div class="arsip-view fade-in">
        {/* Search bar */}
        <div class="arsip-search-row">
          <input
            class="field__input arsip-search-input"
            placeholder="Cari perihal, No. ND, pengirim..."
            value={listSearch}
            onInput={e => setListSearch((e.target as HTMLInputElement).value)}
          />
          {listSearch && (
            <button class="arsip-search-clear" onClick={() => setListSearch("")}>✕</button>
          )}
        </div>

        <div class="arsip-list-bar">
          <button class="btn btn--sm btn--ghost" onClick={toggleAll}>
            {allVisibleSelected ? "Batalkan" : "Pilih Semua"}
            {q ? " (hasil)" : ""}
          </button>
          <span class="arsip-list-count">
            {selectedIds.size} dipilih · {visible.length}{q ? `/${items.length}` : ""} naskah
          </span>
        </div>

        {visible.length === 0 && (
          <p class="hint">{q ? "Tidak ada hasil untuk pencarian ini." : "Tidak ada naskah ditemukan dalam rentang tersebut."}</p>
        )}

        <div class="arsip-item-list">
          {visible.map(item => {
            const id = String(item.Id);
            return (
              <label key={id} class="arsip-item">
                <input
                  type="checkbox"
                  checked={selectedIds.has(id)}
                  onChange={() => toggleItem(id)}
                  class="arsip-item__check"
                />
                <div class="arsip-item__body">
                  <div class="arsip-item__perihal">{item.Perihal ?? "—"}</div>
                  <div class="arsip-item__meta">{item.NoNd ?? ""} · {fmtDate(item.TanggalKirim)}</div>
                </div>
              </label>
            );
          })}
        </div>

        {error && <p class="error-text">{error}</p>}

        <div class="arsip-actions">
          <button
            class="btn btn--primary"
            disabled={selectedIds.size === 0 || loading}
            onClick={handleGoToBerkas}
          >
            {loading ? "Memuat..." : `Pilih Berkas (${selectedIds.size})`}
          </button>
          <button class="btn btn--ghost" onClick={() => setStep("setup")}>Kembali</button>
        </div>
      </div>
    );
  }

  // Setup step
  return (
    <div class="arsip-view fade-in">
      <div class="arsip-type-bar">
        {(["konsep", "amplop", "disposisi"] as ArsipDocType[]).map(t => (
          <button
            key={t}
            class={`arsip-type-btn ${docType === t ? "arsip-type-btn--active" : ""}`}
            onClick={() => setDocType(t)}
          >
            {DOC_LABELS[t]}
          </button>
        ))}
      </div>

      <div class="arsip-mode-bar">
        <button
          class={`arsip-mode-btn ${mode === "manual" ? "arsip-mode-btn--active" : ""}`}
          onClick={() => setMode("manual")}
        >Manual</button>
        <button
          class={`arsip-mode-btn ${mode === "auto" ? "arsip-mode-btn--active" : ""}`}
          onClick={() => setMode("auto")}
        >Otomasi</button>
        <button
          class={`arsip-mode-btn arsip-mode-btn--ai ${mode === "auto-ai" ? "arsip-mode-btn--active" : ""}`}
          onClick={() => setMode("auto-ai")}
        >Otomasi + AI</button>
      </div>

      {mode === "auto" && (
        <p class="hint">
          Otomasi menganalisis KodeKlasifikasi tiap naskah, mengelompokkan, lalu mengarsipkan ke berkas yang sesuai — membuat berkas baru jika diperlukan.
        </p>
      )}
      {mode === "auto-ai" && (
        <p class="hint">
          Otomasi + AI membaca isi PDF tiap naskah dan menggunakan LLM lokal untuk menentukan klasifikasi arsip yang paling tepat, lalu mengarsipkan secara otomatis.
        </p>
      )}

      <label class="field">
        <span class="field__label">Tanggal Mulai (DD-MM-YYYY)</span>
        <input
          class="field__input"
          placeholder="01-01-2026"
          value={startDate}
          onInput={e => setStartDate((e.target as HTMLInputElement).value)}
        />
      </label>

      <label class="field">
        <span class="field__label">Tanggal Akhir (DD-MM-YYYY)</span>
        <input
          class="field__input"
          placeholder={todayDMY()}
          value={endDate}
          onInput={e => setEndDate((e.target as HTMLInputElement).value)}
        />
      </label>

      {error && <p class="error-text">{error}</p>}

      <button class="btn btn--primary" disabled={loading || !startDate} onClick={handleFetch}>
        {loading ? "Memuat..." : "Muat Data"}
      </button>
    </div>
  );
}
