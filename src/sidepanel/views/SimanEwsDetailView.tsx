import { useState, useEffect, useMemo, useCallback } from "preact/hooks";
import type { EwsRow } from "@/shared/siman-types";

const CACHE_KEY = "ewsData";
const NOTES_STORE_KEY = "asguard.ews-notes";

interface CachedEws {
  rows: EwsRow[];
  updatedAt: number;
  kpknlId?: number;
}

interface EwsNoteLocal {
  no_tiket: string;
  kpknl_id: number;
  note: string;
  status: "confirmed" | "dismissed";
  choice?: "diperpanjang" | "tidak";
  author: string;
  updated_at?: string;
  last_synced_at?: string;
}

interface NotesStore {
  kpknl_id: number;
  notes: Record<string, EwsNoteLocal>;
}

const EWS_COLORS = {
  lewat: { border: "var(--ews-lewat)", text: "var(--ews-lewat)", label: "Lewat" },
  kritis: { border: "var(--ews-kritis)", text: "var(--ews-kritis)", label: "Kritis" },
  perhatian: { border: "var(--ews-perhatian)", text: "var(--ews-perhatian)", label: "Perhatian" },
  aman: { border: "var(--ews-aman)", text: "var(--ews-aman)", label: "Aman" },
} as const;

function formatRupiah(n: number): string {
  if (!n) return "-";
  return "Rp " + n.toLocaleString("id-ID");
}

function formatRelative(iso?: string): string {
  if (!iso) return "Belum pernah";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return iso;
  const diff = Date.now() - t;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "baru saja";
  if (mins < 60) return `${mins} menit lalu`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} jam lalu`;
  const days = Math.floor(hrs / 24);
  return `${days} hari lalu`;
}

function send<T>(msg: unknown): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

export function SimanEwsDetailView({
  noTiket,
  userName,
  onBack,
}: {
  noTiket: string;
  userName: string;
  onBack: () => void;
}) {
  const [cached, setCached] = useState<CachedEws | null>(null);
  const [note, setNote] = useState<EwsNoteLocal | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [formChoice, setFormChoice] = useState<"diperpanjang" | "tidak" | "">("");
  const [formNote, setFormNote] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<{ kind: "ok" | "err" | "info"; text: string } | null>(null);
  const [skList, setSkList] = useState<Record<string, unknown>[] | null>(null);
  const [skLoading, setSkLoading] = useState(false);

  // Load cache + local note
  useEffect(() => {
    chrome.storage.local.get([CACHE_KEY, NOTES_STORE_KEY], (res) => {
      const c = res[CACHE_KEY] as CachedEws | undefined;
      if (c?.rows) setCached(c);

      const store = res[NOTES_STORE_KEY] as NotesStore | undefined;
      const found = store?.notes?.[noTiket] ?? null;
      if (found) setNote(found);
      setLoading(false);
    });
  }, [noTiket]);

  const group = useMemo(() => {
    if (!cached?.rows) return [] as EwsRow[];
    return cached.rows.filter((r) => r.no_tiket === noTiket);
  }, [cached, noTiket]);

  const first = group[0];

  // Fetch SK list when we have id_pengelolaan
  useEffect(() => {
    if (!first?.id_pengelolaan) return;
    setSkLoading(true);
    send<{ ok: boolean; data?: Record<string, unknown>[] }>({
      type: "siman/get-sk-by-tiket-monitoring",
      idPengelolaan: first.id_pengelolaan,
    }).then((res) => {
      setSkList(res?.ok && Array.isArray(res.data) ? res.data : []);
    }).catch(() => setSkList([]))
      .finally(() => setSkLoading(false));
  }, [first?.id_pengelolaan]);
  const minSisa = useMemo(() => (group.length ? Math.min(...group.map((r) => r.sisa_hari)) : 0), [group]);
  const nearest = useMemo(() => group.find((r) => r.sisa_hari === minSisa), [group, minSisa]);
  const worstStatus: keyof typeof EWS_COLORS =
    minSisa <= 0 ? "lewat" : minSisa <= 90 ? "kritis" : minSisa <= 180 ? "perhatian" : "aman";
  const colors = EWS_COLORS[worstStatus];

  const kpknlId = cached?.kpknlId;

  function startEdit() {
    setFormChoice(note?.choice ?? "");
    setFormNote(note?.note ?? "");
    setEditing(true);
  }

  async function handleSave() {
    if (!formChoice || kpknlId == null) return;
    const payload = {
      no_tiket: noTiket,
      kpknl_id: kpknlId,
      note: formChoice === "tidak" ? (formNote || "Tidak diperpanjang") : (formNote || "Sudah diperpanjang"),
      status: (formChoice === "diperpanjang" ? "confirmed" : "dismissed") as "confirmed" | "dismissed",
      choice: formChoice as "diperpanjang" | "tidak",
      author: userName,
    };
    const res = await send<{ ok: boolean; error?: string }>({ type: "ews/note-upsert", note: payload });
    if (res?.ok) {
      const saved: EwsNoteLocal = { ...payload, updated_at: new Date().toISOString(), last_synced_at: note?.last_synced_at };
      setNote(saved);
      setEditing(false);
      setSyncMsg({ kind: "info", text: "Tersimpan lokal — auto-push ke server di latar." });
    } else {
      setSyncMsg({ kind: "err", text: res?.error || "Gagal menyimpan" });
    }
  }

  async function handleRemove() {
    if (kpknlId == null) return;
    if (!confirm("Hapus konfirmasi tiket ini?")) return;
    const res = await send<{ ok: boolean; error?: string }>({
      type: "ews/note-delete",
      noTiket,
      kpknlId,
    });
    if (res?.ok) {
      setNote(null);
      setEditing(false);
      setSyncMsg({ kind: "info", text: "Konfirmasi dihapus (lokal + server)." });
    } else {
      setSyncMsg({ kind: "err", text: res?.error || "Gagal menghapus" });
    }
  }

  const handleSync = useCallback(async () => {
    if (kpknlId == null) {
      setSyncMsg({ kind: "err", text: "KPKNL tidak diketahui (cache belum lengkap)." });
      return;
    }
    setSyncing(true);
    setSyncMsg({ kind: "info", text: "Mensinkronkan dengan server…" });
    try {
      const res = await send<
        | { ok: true; note: EwsNoteLocal }
        | { ok: false; error: string }
      >({ type: "ews/note-sync-one", noTiket, kpknlId });
      if (res?.ok) {
        setNote(res.note);
        setSyncMsg({ kind: "ok", text: "Tersinkron." });
      } else {
        setSyncMsg({ kind: "err", text: res?.error || "Gagal sync" });
      }
    } catch (e) {
      setSyncMsg({ kind: "err", text: String(e) });
    } finally {
      setSyncing(false);
    }
  }, [noTiket, kpknlId]);

  if (loading) return <p class="hint">Memuat detail tiket…</p>;

  if (!first) {
    return (
      <div style="padding:12px">
        <p class="hint" style="text-align:center">
          Tiket <b>{noTiket}</b> tidak ditemukan di cache. Coba update data EWS terlebih dahulu.
        </p>
        <div style="text-align:center;margin-top:8px">
          <button class="btn" onClick={onBack}>← Kembali</button>
        </div>
      </div>
    );
  }

  const isConfirmed = !!note;
  const cardStyle = "padding:10px;background:var(--surface-2);border-radius:var(--radius-sm);border:1px solid var(--line)";

  return (
    <div style="padding:12px;display:flex;flex-direction:column;gap:10px">
      {/* Ticket header */}
      <div style={`padding:12px;border-radius:var(--radius-sm);border:1px solid var(--line);border-left:3px solid ${colors.border};background:var(--surface-2)`}>
        <div style="display:flex;align-items:center;gap:10px">
          <span style={`width:10px;height:10px;border-radius:50%;background:${colors.border};flex-shrink:0`} />
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:700;word-break:break-all">{noTiket}</div>
            <div style="font-size:12px;color:var(--muted);margin-top:2px">{first.ur_satker}</div>
          </div>
        </div>
        <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px;color:var(--text-primary)">
          <span><b>SK:</b> {first.no_sk || "-"}</span>
          <span><b>Tgl SK:</b> {first.tgl_sk || "-"}</span>
          <span><b>Aset:</b> {group.length}</span>
          {nearest && (
            <span style={`font-weight:600;color:${colors.text}`}>{nearest.sisa_label}</span>
          )}
        </div>
      </div>

      {/* Sync row */}
      <div style={`${cardStyle};display:flex;align-items:center;gap:8px`}>
        <div style="flex:1;min-width:0;font-size:12px;color:var(--muted)">
          Sinkronisasi: <b style="color:var(--text-primary)">{formatRelative(note?.last_synced_at)}</b>
          {note?.updated_at && (
            <div style="font-size:11px;color:var(--muted);margin-top:2px">
              Diubah: {formatRelative(note.updated_at)}
            </div>
          )}
        </div>
        <button
          class="btn btn--primary"
          style="font-size:12px;padding:6px 14px"
          onClick={handleSync}
          disabled={syncing || kpknlId == null}
        >
          {syncing ? "Sync…" : "Sync"}
        </button>
      </div>

      {syncMsg && (
        <div
          style={`padding:8px 12px;border-radius:var(--radius-sm);font-size:12px;border:1px solid var(--line);${
            syncMsg.kind === "ok"
              ? "color:var(--ews-confirmed)"
              : syncMsg.kind === "err"
                ? "color:var(--error)"
                : "color:var(--muted)"
          }`}
        >
          {syncMsg.text}
        </div>
      )}

      {/* Confirmation panel */}
      <div style={cardStyle}>
        <div style="font-size:13px;font-weight:700;margin-bottom:8px;color:var(--text-primary)">
          Konfirmasi Tiket
        </div>

        {!editing && isConfirmed && (
          <div
            style={`padding:10px 12px;border-radius:var(--radius-sm);border:1px solid var(--line);border-left:3px solid ${
              note!.choice === "diperpanjang" ? "var(--ews-confirmed)" : "var(--ews-dismissed)"
            };background:var(--surface-2)`}
          >
            <div style="display:flex;align-items:center;gap:8px">
              <span style={`width:8px;height:8px;border-radius:50%;background:${
                note!.choice === "diperpanjang" ? "var(--ews-confirmed)" : "var(--ews-dismissed)"
              };flex-shrink:0`} />
              <div style="flex:1;min-width:0">
                <div style={`font-size:12px;font-weight:600;color:${
                  note!.choice === "diperpanjang" ? "var(--ews-confirmed)" : "var(--ews-dismissed)"
                }`}>
                  {note!.choice === "diperpanjang" ? "Sudah Diperpanjang" : "Tidak Diperpanjang"}
                </div>
                {note!.note && <div style="font-size:12px;color:var(--muted);margin-top:3px">{note!.note}</div>}
                <div style="font-size:11px;color:var(--muted);margin-top:4px">
                  oleh {note!.author || "—"}
                </div>
              </div>
            </div>
            <div style="display:flex;gap:8px;margin-top:10px">
              <button class="btn" style="font-size:12px;padding:5px 12px" onClick={startEdit}>
                Edit
              </button>
              <button
                class="btn"
                style="font-size:12px;padding:5px 12px;color:var(--error)"
                onClick={handleRemove}
              >
                Hapus
              </button>
            </div>
          </div>
        )}

        {!editing && !isConfirmed && (
          <div>
            <p style="margin:0 0 8px;font-size:12px;color:var(--muted)">
              Belum ada konfirmasi untuk tiket ini.
            </p>
            <button class="btn btn--primary" style="font-size:12px;padding:6px 14px" onClick={startEdit}>
              Tambah Konfirmasi
            </button>
          </div>
        )}

        {editing && (
          <div style="display:flex;flex-direction:column;gap:8px">
            <select
              value={formChoice}
              onChange={(e) => setFormChoice((e.target as HTMLSelectElement).value as "diperpanjang" | "tidak" | "")}
              style="font-size:12px;padding:8px;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-sm);color:var(--text-primary)"
            >
              <option value="">-- Pilih status --</option>
              <option value="diperpanjang">Sudah Diperpanjang</option>
              <option value="tidak">Tidak Diperpanjang</option>
            </select>
            <textarea
              placeholder="Catatan (opsional)"
              value={formNote}
              onInput={(e) => setFormNote((e.target as HTMLTextAreaElement).value)}
              rows={3}
              style="font-size:12px;padding:8px;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-sm);color:var(--text-primary);resize:vertical;font-family:inherit"
            />
            <div style="display:flex;gap:8px">
              <button
                class="btn btn--primary"
                style="font-size:12px;padding:6px 14px"
                onClick={handleSave}
                disabled={!formChoice}
              >
                Simpan
              </button>
              <button
                class="btn"
                style="font-size:12px;padding:6px 14px"
                onClick={() => { setEditing(false); setFormChoice(""); setFormNote(""); }}
              >
                Batal
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Asset list */}
      <div style={cardStyle}>
        <div style="font-size:13px;font-weight:700;margin-bottom:8px;color:var(--text-primary)">
          Daftar Aset ({group.length})
        </div>
        <div style="display:flex;flex-direction:column;gap:8px">
          {group.map((r, i) => {
            const c = EWS_COLORS[r.status_ews];
            return (
              <div
                key={i}
                style={`padding:8px 10px;background:var(--surface-2);border-radius:var(--radius-sm);border:1px solid var(--line);border-left:3px solid ${c.border};font-size:12px`}
              >
                <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
                  <span style="font-weight:600">
                    {r.kd_brg} / NUP {r.nup}
                  </span>
                  <span
                    style={`font-weight:600;color:${c.text};font-size:11px;padding:2px 8px;background:var(--surface);border-radius:var(--radius-sm);white-space:nowrap`}
                  >
                    {r.sisa_label}
                  </span>
                </div>
                <div style="color:var(--muted);margin-top:3px">{r.ur_sskel}</div>
                {r.tujuan_permohonan && (
                  <div style="color:var(--muted);margin-top:2px">Tujuan: {r.tujuan_permohonan}</div>
                )}
                <div style="display:flex;gap:12px;margin-top:4px;color:var(--muted);flex-wrap:wrap">
                  <span>Jangka: {r.ref_jangka_waktu} bln</span>
                  <span>Berakhir: {r.tgl_berakhir}</span>
                  {r.ref_luas_sewa && <span>Luas: {r.ref_luas_sewa}</span>}
                  <span>{formatRupiah(r.nilai_persetujuan)}</span>
                </div>

                {(r.status_ews === "lewat" || r.status_ews === "kritis") &&
                  (r.renewal ? (
                    r.renewal.is_renewal ? (
                      <div style="margin-top:6px;padding:6px 8px;border-radius:var(--radius-sm);border:1px solid var(--line);border-left:3px solid var(--ews-confirmed);background:var(--surface)">
                        <div style="font-weight:600;color:var(--ews-confirmed);font-size:12px">Diperpanjang</div>
                        <div style="color:var(--muted);margin-top:3px;font-size:11px">
                          Tiket: {r.renewal.no_tiket || "-"}<br />
                          SK: {r.renewal.no_surat} ({r.renewal.tgl_surat})
                          {r.renewal.new_tujuan && (<><br />Tujuan: {r.renewal.new_tujuan}</>)}
                          {r.renewal.new_luas && (<><br />Luas: {r.renewal.new_luas}</>)}
                        </div>
                        <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;font-size:11px">
                          <span style={`padding:2px 6px;border-radius:var(--radius-sm);border:1px solid var(--line);${r.renewal.match_luas ? "color:var(--ews-confirmed)" : "color:var(--error)"}`}>
                            Luas: {r.renewal.match_luas ? "✓ Cocok" : "✗ Beda"}
                          </span>
                          <span style={`padding:2px 6px;border-radius:var(--radius-sm);border:1px solid var(--line);${r.renewal.match_tujuan ? "color:var(--ews-confirmed)" : "color:var(--error)"}`}>
                            Tujuan: {r.renewal.match_tujuan ? "✓ Cocok" : "✗ Beda"}
                          </span>
                          <span style={`padding:2px 6px;border-radius:var(--radius-sm);border:1px solid var(--line);${r.renewal.match_keterangan ? "color:var(--ews-confirmed)" : "color:var(--error)"}`}>
                            Keterangan: {r.renewal.match_keterangan ? "✓ Cocok" : "✗ Beda"}
                          </span>
                        </div>
                      </div>
                    ) : (
                      <div style="margin-top:6px;padding:6px 8px;border-radius:var(--radius-sm);border:1px solid var(--line);border-left:3px solid var(--ews-perhatian);background:var(--surface)">
                        <div style="font-weight:600;color:var(--ews-perhatian);font-size:12px">
                          Ada SK Baru, Peruntukan Berbeda
                        </div>
                        <div style="color:var(--muted);margin-top:3px;font-size:11px">
                          Tiket: {r.renewal.no_tiket || "-"}<br />
                          SK: {r.renewal.no_surat} ({r.renewal.tgl_surat})
                          {r.renewal.new_tujuan && (<><br />Tujuan baru: {r.renewal.new_tujuan}</>)}
                          {r.renewal.new_luas && (<><br />Luas baru: {r.renewal.new_luas}</>)}
                        </div>
                        <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;font-size:11px">
                          <span style={`padding:2px 6px;border-radius:var(--radius-sm);border:1px solid var(--line);${r.renewal.match_luas ? "color:var(--ews-confirmed)" : "color:var(--error)"}`}>
                            Luas: {r.renewal.match_luas ? "✓ Cocok" : "✗ Beda"}
                          </span>
                          <span style={`padding:2px 6px;border-radius:var(--radius-sm);border:1px solid var(--line);${r.renewal.match_tujuan ? "color:var(--ews-confirmed)" : "color:var(--error)"}`}>
                            Tujuan: {r.renewal.match_tujuan ? "✓ Cocok" : "✗ Beda"}
                          </span>
                          <span style={`padding:2px 6px;border-radius:var(--radius-sm);border:1px solid var(--line);${r.renewal.match_keterangan ? "color:var(--ews-confirmed)" : "color:var(--error)"}`}>
                            Keterangan: {r.renewal.match_keterangan ? "✓ Cocok" : "✗ Beda"}
                          </span>
                        </div>
                      </div>
                    )
                  ) : (
                    <div style="margin-top:6px;padding:6px 8px;border-radius:var(--radius-sm);border:1px solid var(--line);border-left:3px solid var(--ews-kritis);background:var(--surface)">
                      <div style="font-weight:600;color:var(--ews-kritis);font-size:12px">Belum Ada Perpanjangan</div>
                      <div style="color:var(--muted);font-size:11px;margin-top:2px">Tidak ditemukan SK sewa baru untuk aset ini</div>
                    </div>
                  ))}
              </div>
            );
          })}
        </div>
      </div>
      {/* SK & Lampiran downloads */}
      <div style={cardStyle}>
        <div style="font-size:13px;font-weight:700;margin-bottom:8px;color:var(--text-primary)">
          Surat Keputusan
        </div>
        {skLoading && <p style="margin:0;font-size:12px;color:var(--muted)">Memuat SK…</p>}
        {!skLoading && skList && skList.length === 0 && (
          <p style="margin:0;font-size:12px;color:var(--muted)">Tidak ada SK ditemukan.</p>
        )}
        {!skLoading && skList && skList.length > 0 && (
          <div style="display:flex;flex-direction:column;gap:8px">
            {skList.map((sk, i) => {
              const noSk = String(sk.no_sk ?? "-");
              const tglSk = String(sk.tgl_sk ?? "").split("T")[0];
              const urlSk = String(sk.url_sk ?? "").replace(/^"+|"+$/g, "").trim();
              const urlLampiran = String(sk.url_lampiran ?? "").replace(/^"+|"+$/g, "").trim();
              return (
                <div key={i} style="padding:8px 10px;background:var(--surface-2);border-radius:var(--radius-sm);border:1px solid var(--line);font-size:12px">
                  <div style="font-weight:600;margin-bottom:6px">
                    {noSk} <span style="color:var(--muted);font-weight:400">({tglSk})</span>
                  </div>
                  <div style="display:flex;gap:8px;flex-wrap:wrap">
                    {urlSk && (
                      <a
                        href={urlSk}
                        target="_blank"
                        rel="noopener noreferrer"
                        class="btn"
                        style="font-size:11px;padding:4px 10px;text-decoration:none"
                      >
                        Download SK
                      </a>
                    )}
                    {urlLampiran && (
                      <a
                        href={urlLampiran}
                        target="_blank"
                        rel="noopener noreferrer"
                        class="btn"
                        style="font-size:11px;padding:4px 10px;text-decoration:none"
                      >
                        Download Lampiran
                      </a>
                    )}
                    {!urlSk && !urlLampiran && (
                      <span style="font-size:12px;color:var(--muted)">Tidak ada file tersedia</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
