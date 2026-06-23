import { useState, useEffect, useRef } from "preact/hooks";
import type {
  PanelSnapshot, SimanTemplate, SimanPenetapan, SimanTipePengelolaan,
  SimanKelengkapanDoc, SimanDokLengkapPortRequest, SimanDokLengkapMsg,
} from "@/shared/types";
import { Icon } from "../components/Icon";
import { useModalEscape } from "../components/useModalEscape";

function send<T>(msg: unknown): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

const STATUS_OPTIONS = [
  { label: "Semua status", value: "" },
  { label: "Proses", value: "penelitian" },
  { label: "Selesai", value: "selesai" },
  { label: "Draft", value: "draft" },
];
const LIMIT = 10;

// The deskripsi value that gates Lengkap Semua, matching CLI condition
const PROSES_PENELITIAN_DESKRIPSI = "Proses Penelitian Analis KPKNL";

interface Props {
  snap: PanelSnapshot;
  onRun: (noTiket: string, idPengelolaan: string, idTipePengelolaan: string, templateId: string) => void;
  onBack: () => void;
}

export function SimanDaftarView({ onRun }: Props) {
  const [items, setItems] = useState<SimanPenetapan[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState("");
  const [idTipeFilter, setIdTipeFilter] = useState("");
  const [tipes, setTipes] = useState<SimanTipePengelolaan[]>([]);
  const [templates, setTemplates] = useState<SimanTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const reqSeq = useRef(0);

  useEffect(() => {
    send<{ ok: boolean; data?: SimanTipePengelolaan[] }>({ type: "siman/get-tipe-pengelolaan" })
      .then((r) => { if (r.ok) setTipes(r.data ?? []); });
    send<{ ok: boolean; data?: SimanTemplate[] }>({ type: "siman/get-templates" })
      .then((r) => { if (r.ok) setTemplates(r.data ?? []); });
  }, []);

  useEffect(() => { fetchPage(0); }, [statusFilter, idTipeFilter]);

  async function fetchPage(p: number) {
    const seq = ++reqSeq.current;
    setLoading(true);
    setError(null);
    try {
      const r = await send<{ ok: boolean; data?: { data: SimanPenetapan[]; total: number }; error?: string }>({
        type: "siman/get-penetapan-list",
        limit: LIMIT,
        offset: p * LIMIT,
        statusFilter: statusFilter || undefined,
        idTipe: idTipeFilter || undefined,
      });
      if (seq !== reqSeq.current) return;
      if (r.ok && r.data) {
        setItems(r.data.data);
        setTotal(r.data.total);
        setPage(p);
      } else {
        setError(r.error ?? "Gagal memuat data");
      }
    } catch (e) {
      if (seq === reqSeq.current) setError(String(e));
    }
    if (seq === reqSeq.current) setLoading(false);
  }

  function templatesForItem(item: SimanPenetapan) {
    return templates.filter((t) => String(t.idTipePengelolaan) === item.idTipePengelolaan);
  }

  const totalPages = Math.ceil(total / LIMIT);
  const searchQ = search.trim().toLowerCase();
  const visibleItems = searchQ
    ? items.filter((it) =>
        (it.noTiket ?? "").toLowerCase().includes(searchQ) ||
        (it.satker ?? "").toLowerCase().includes(searchQ) ||
        (it.tipe ?? "").toLowerCase().includes(searchQ))
    : items;

  return (
    <div style="padding:8px;display:flex;flex-direction:column;gap:8px">
      <div style="display:flex;gap:6px;align-items:center">
        <select
          style="flex:1;font-size:11px;padding:4px 6px;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-sm);color:var(--text-primary)"
          value={statusFilter}
          onChange={(e) => setStatusFilter((e.target as HTMLSelectElement).value)}
        >
          {STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <select
          style="flex:1;font-size:11px;padding:4px 6px;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-sm);color:var(--text-primary)"
          value={idTipeFilter}
          onChange={(e) => setIdTipeFilter((e.target as HTMLSelectElement).value)}
        >
          <option value="">Semua tipe</option>
          {tipes.map((t) => <option key={t.id} value={t.id}>{t.nama}</option>)}
        </select>
      </div>
      <input class="mm-search" type="text" placeholder="Cari no. tiket, satker…" value={search} onInput={(e) => setSearch((e.target as HTMLInputElement).value)} />

      {loading && (
        <div class="card" style="padding:12px"><div class="skeleton"><div class="skeleton__line skeleton__line--long" /><div class="skeleton__line skeleton__line--medium" /><div class="skeleton__line skeleton__line--short" /></div></div>
      )}
      {error && <p class="hint" style="color:var(--error)">{error}</p>}

      {!loading && visibleItems.map((item) => (
        <PenetapanCard
          key={item.noTiket}
          item={item}
          templates={templatesForItem(item)}
          onRun={onRun}
        />
      ))}

      {!loading && visibleItems.length === 0 && !error && (
        <p class="hint">{searchQ ? "Tidak ada yang cocok." : "Tidak ada data pengelolaan."}</p>
      )}

      {totalPages > 1 && (
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px">
          <button class="btn btn--ghost" style="font-size:11px;padding:4px 10px;display:inline-flex;align-items:center;gap:4px" disabled={page === 0} onClick={() => fetchPage(page - 1)}><Icon name="chevron-left" size={12} /> Prev</button>
          <span class="hint">Hal {page + 1} / {totalPages} ({total} data)</span>
          <button class="btn btn--ghost" style="font-size:11px;padding:4px 10px;display:inline-flex;align-items:center;gap:4px" disabled={page >= totalPages - 1} onClick={() => fetchPage(page + 1)}>Next <Icon name="chevron-right" size={12} /></button>
        </div>
      )}
    </div>
  );
}

function PenetapanCard({ item, templates, onRun }: {
  item: SimanPenetapan;
  templates: SimanTemplate[];
  onRun: (noTiket: string, idPengelolaan: string, idTipePengelolaan: string, templateId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState(templates[0]?.id ?? "");
  const [docs, setDocs] = useState<SimanKelengkapanDoc[] | null>(null);
  const [docsLoading, setDocsLoading] = useState(false);
  const [docsError, setDocsError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [showRunConfirm, setShowRunConfirm] = useState(false);
  useModalEscape(showRunConfirm, () => setShowRunConfirm(false));
  const [openingDoc, setOpeningDoc] = useState<string | null>(null);
  const [lengkapState, setLengkapState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [lengkapMsg, setLengkapMsg] = useState("");
  const portRef = useRef<chrome.runtime.Port | null>(null);

  useEffect(() => { setSelectedTemplate(templates[0]?.id ?? ""); }, [templates]);

  // Disconnect port on unmount
  useEffect(() => () => { portRef.current?.disconnect(); }, []);

  async function loadDocs() {
    if (docsLoading) return;
    setDocsLoading(true);
    setDocsError(null);
    try {
      const r = await send<{ ok: boolean; data?: SimanKelengkapanDoc[]; error?: string }>({
        type: "siman/get-kelengkapan",
        idPengelolaan: item.idPengelolaan,
      });
      if (r.ok) setDocs(r.data ?? []);
      else setDocsError(r.error ?? "Gagal memuat dokumen");
    } catch (e) {
      setDocsError(String(e));
    }
    setDocsLoading(false);
  }

  function handleExpand() {
    const next = !expanded;
    setExpanded(next);
    if (next && docs === null) loadDocs();
  }

  async function openDoc(doc: SimanKelengkapanDoc) {
    const key = String(doc.id_pengelolaan_dok);
    if (openingDoc === key) return;
    setOpeningDoc(key);
    try {
      const r = await send<{ ok: boolean; url?: string; error?: string }>({
        type: "siman/get-download-token",
        idPengelolaanDok: Number(doc.id_pengelolaan_dok),
        nmFile: doc.nm_file,
      });
      if (r.ok && r.url) {
        chrome.tabs.create({ url: r.url });
      } else {
        setOpenError(r.error ?? "Gagal mendapatkan token unduh");
      }
    } catch (e) {
      setOpenError(String(e));
    }
    setOpeningDoc(null);
  }

  function openAllDocs() {
    if (!docs) return;
    const docsWithFile = docs.filter((d) => d.nm_file);
    const CAP = 8;
    const toOpen = docsWithFile.slice(0, CAP);
    if (docsWithFile.length > CAP) setOpenError(`Membuka ${CAP} dari ${docsWithFile.length} dokumen (batas tab).`);
    toOpen.forEach((d) => openDoc(d));
  }

  const [downloading, setDownloading] = useState(false);
  const [dlProgress, setDlProgress] = useState("");

  async function downloadAllDocs() {
    if (!docs || downloading) return;
    const docsWithFile = docs.filter((d) => d.nm_file);
    if (!docsWithFile.length) return;
    setDownloading(true);
    let done = 0;
    for (const doc of docsWithFile) {
      setDlProgress(`${done + 1}/${docsWithFile.length}: ${doc.nm_file}`);
      try {
        const r = await send<{ ok: boolean; url?: string }>({
          type: "siman/get-download-token",
          idPengelolaanDok: Number(doc.id_pengelolaan_dok),
          nmFile: doc.nm_file,
        });
        if (r.ok && r.url) {
          chrome.downloads.download({ url: r.url, filename: `${item.noTiket}/${doc.nm_file}` });
        }
      } catch { /* skip */ }
      done++;
    }
    setDlProgress(`${done} file diunduh`);
    setTimeout(() => { setDownloading(false); setDlProgress(""); }, 2000);
  }

  const canLengkapSemua = item.deskripsi === PROSES_PENELITIAN_DESKRIPSI;

  function startLengkapSemua() {
    if (lengkapState === "running") return;
    setLengkapState("running");
    setLengkapMsg("Memulai…");

    const port = chrome.runtime.connect({ name: "siman-dok-lengkap" });
    portRef.current = port;

    port.onMessage.addListener((msg: SimanDokLengkapMsg) => {
      if (msg.type === "dok/progress") {
        setLengkapMsg(`${msg.done + 1}/${msg.total}: ${msg.nmDok}`);
      }
      if (msg.type === "dok/done") {
        setLengkapState("done");
        setLengkapMsg(`Selesai: ${msg.success} berhasil, ${msg.failed} gagal`);
        // Reload docs to show updated status
        setDocs(null);
        loadDocs();
      }
      if (msg.type === "dok/error") {
        setLengkapState("error");
        setLengkapMsg(msg.error);
      }
    });

    port.onDisconnect.addListener(() => {
      setLengkapState((prev) => (prev === "running" ? "error" : prev));
    });

    const req: SimanDokLengkapPortRequest = {
      type: "siman/dok-lengkap-run",
      idPengelolaan: item.idPengelolaan,
      noTiket: item.noTiket,
    };
    port.postMessage(req);
  }

  return (
    <div class="card" style="padding:10px">
      {/* Header: tiket + status */}
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:13px;color:var(--color-primary)">{item.noTiket}</div>
          <div style="font-size:11px;color:var(--text-primary);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{item.satker}</div>
          <div style="font-size:11px;color:var(--muted);margin-top:1px">{item.tipe}</div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div style="font-size:10px;padding:2px 8px;border-radius:10px;background:var(--surface-2);color:var(--text-primary);font-weight:600;display:inline-block">
            {item.status}
          </div>
          {item.durasi && <div class="hint" style="margin-top:3px">{item.durasi}</div>}
        </div>
      </div>

      {/* Template select + Buat + expand */}
      <div style="display:flex;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid var(--line);align-items:center">
        {templates.length > 0 ? (
          <>
            <select
              style="flex:1;font-size:11px;padding:5px 8px;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-sm);color:var(--text-primary)"
              value={selectedTemplate}
              onChange={(e) => setSelectedTemplate((e.target as HTMLSelectElement).value)}
            >
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <button
              class="btn btn--primary"
              style="flex-shrink:0;font-size:11px;padding:5px 12px"
              onClick={() => setShowRunConfirm(true)}
            >
              Buat
            </button>
          </>
        ) : (
          <span class="hint" style="font-size:10px;flex:1">Buat template {item.tipe} terlebih dahulu</span>
        )}
        <button class="btn btn--ghost" style="font-size:13px;padding:4px 8px;flex-shrink:0;display:inline-flex;align-items:center" onClick={handleExpand}>
          <Icon name={expanded ? "arrow-up" : "arrow-down"} size={12} />
        </button>
      </div>

      {/* Expanded: Kelengkapan Dokumen */}
      {expanded && (
        <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--line)">
          <div style="font-size:12px;font-weight:600;color:var(--text-primary);margin-bottom:8px">Kelengkapan Dokumen</div>

          {/* Action buttons — stacked in a row that wraps */}
          {docs && docs.some((d) => d.nm_file) && (
            <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">
              <button class="btn btn--ghost" style="font-size:11px;padding:5px 10px;display:inline-flex;align-items:center;gap:4px" onClick={openAllDocs}>
                <Icon name="link" size={12} /> Buka Semua
              </button>
              <button
                class="btn btn--ghost"
                style={`font-size:11px;padding:5px 10px;display:inline-flex;align-items:center;gap:4px${downloading ? ";opacity:0.6" : ""}`}
                onClick={downloadAllDocs}
                disabled={downloading}
              >
                {downloading ? <><Icon name="loader" size={12} /> Unduh…</> : <><Icon name="download" size={12} /> Unduh Semua</>}
              </button>
              {canLengkapSemua && (
                <button
                  class="btn"
                  style={`font-size:11px;padding:5px 10px;display:inline-flex;align-items:center;gap:4px${lengkapState === "running" ? ";opacity:0.6" : ""}`}
                  onClick={startLengkapSemua}
                  disabled={lengkapState === "running"}
                >
                  {lengkapState === "running" ? <><Icon name="loader" size={12} /> Proses…</> : <><Icon name="circle-check" size={12} /> Lengkap Semua</>}
                </button>
              )}
            </div>
          )}

          {/* Progress banners */}
          {(lengkapState === "running" || lengkapState === "done" || lengkapState === "error") && (
            <div style={`font-size:11px;margin-bottom:8px;padding:6px 8px;border-radius:var(--radius-sm);background:var(--surface-2);color:${lengkapState === "error" ? "var(--error)" : "var(--muted)"}`}>
              {lengkapMsg}
            </div>
          )}
          {dlProgress && (
            <div style="font-size:11px;margin-bottom:8px;padding:6px 8px;border-radius:var(--radius-sm);background:var(--surface-2);color:var(--muted);display:flex;align-items:center;gap:4px">
              <Icon name="download" size={12} /> {dlProgress}
            </div>
          )}

          {docsLoading && <p class="hint" style="margin:6px 0">Memuat dokumen…</p>}
          {docsError && <p class="hint" style="color:var(--error);margin:6px 0">{docsError}</p>}
          {openError && <p class="hint" style="color:var(--error);margin:6px 0" role="alert">{openError}</p>}
          {docs && docs.length === 0 && !docsLoading && (
            <p class="hint" style="margin:6px 0">Tidak ada dokumen kelengkapan.</p>
          )}

          {/* Doc list */}
          {docs && docs.length > 0 && (
            <div style="display:flex;flex-direction:column;gap:2px">
              {docs.map((doc, i) => (
                <DocRow
                  key={i}
                  doc={doc}
                  opening={openingDoc === String(doc.id_pengelolaan_dok)}
                  onOpen={() => openDoc(doc)}
                />
              ))}
            </div>
          )}

          {/* Info footer */}
          <div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--line);font-size:11px;color:var(--muted);display:flex;flex-direction:column;gap:2px">
            <div><strong>No. Tiket:</strong> {item.noTiket}</div>
            <div><strong>Satker:</strong> {item.satker}</div>
            <div><strong>Status:</strong> {item.status}</div>
          </div>
        </div>
      )}

      {showRunConfirm && (
        <div class="modal-overlay" onClick={() => setShowRunConfirm(false)}>
          <div class="modal" onClick={(e) => e.stopPropagation()}>
            <h2 class="modal__title"><Icon name="file-text" /> Buat Naskah?</h2>
            <p class="modal__sub">Membuat naskah dari template untuk tiket <strong>{item.noTiket}</strong> dan mengirim ke Nadine.</p>
            <div class="modal__actions">
              <button class="btn btn--ghost" onClick={() => setShowRunConfirm(false)}>Batal</button>
              <button class="btn btn--primary" onClick={() => { setShowRunConfirm(false); onRun(item.noTiket, item.idPengelolaan, item.idTipePengelolaan, selectedTemplate); }}><Icon name="play" size={14} /> Buat</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DocRow({ doc, opening, onOpen }: { doc: SimanKelengkapanDoc; opening: boolean; onOpen: () => void }) {
  const hasFile = !!doc.nm_file;
  return (
    <div style="display:flex;align-items:center;gap:6px;padding:6px 4px;border-bottom:1px solid var(--line)">
      <StatusDot statusDok={doc.status_dok} />
      <div style="flex:1;min-width:0">
        <div style="font-size:11px;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{doc.nm_dok || doc.nm_file || "—"}</div>
        {doc.no_dok && <div style="font-size:10px;color:var(--muted);margin-top:1px">{doc.no_dok}</div>}
      </div>
      {hasFile && (
        <button
          class="btn btn--ghost"
          style={`font-size:11px;padding:4px 8px;flex-shrink:0${opening ? ";opacity:0.5" : ""}`}
          onClick={onOpen}
          disabled={opening}
        >
          {opening ? "…" : "Buka"}
        </button>
      )}
    </div>
  );
}

function StatusDot({ statusDok }: { statusDok: number }) {
  const map: Record<number, { cls: string; title: string }> = {
    1: { cls: "dot dot--warn", title: "Belum Diperiksa" },
    2: { cls: "dot dot--err", title: "Tidak Lengkap" },
    4: { cls: "dot dot--warn", title: "Diperbaiki" },
    5: { cls: "dot dot--ok", title: "Lengkap" },
  };
  const s = map[statusDok] ?? { cls: "dot", title: String(statusDok) };
  return <span class={s.cls} title={s.title} role="img" aria-label={s.title} style="flex-shrink:0" />;
}
