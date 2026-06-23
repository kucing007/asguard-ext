import { useState, useEffect, useMemo, useCallback } from "preact/hooks";
import type { EwsRow } from "@/shared/siman-types";
import { Icon } from "../components/Icon";
import { useModalEscape } from "../components/useModalEscape";
import {
  CACHE_KEY, NOTES_STORE_KEY,
  type CachedEws, type EwsNoteLocal, type NotesStore,
  EWS_COLORS, computeFrozenSisa, formatRelative, formatRupiah, send,
} from "../siman/ews-shared";

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
  const [formChoice, setFormChoice] = useState<"sudah_perpanjang" | "proses_perpanjangan" | "tidak" | "">("");
  const [formNote, setFormNote] = useState("");
  const [formTiketPerpanjangan, setFormTiketPerpanjangan] = useState("");
  const [spLoading, setSpLoading] = useState(false);
  const [spResult, setSpResult] = useState<{ ok: boolean; noSurat?: string; error?: string } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<{ kind: "ok" | "err" | "info"; text: string } | null>(null);
  const [skList, setSkList] = useState<Record<string, unknown>[] | null>(null);
  const [skLoading, setSkLoading] = useState(false);
  const [showRemove, setShowRemove] = useState(false);
  const [formDirty, setFormDirty] = useState(false);
  const [showDiscard, setShowDiscard] = useState(false);
  useModalEscape(showRemove, () => setShowRemove(false));
  useModalEscape(showDiscard, () => setShowDiscard(false));
  const [assetsExpanded, setAssetsExpanded] = useState(true);

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

  // Frozen sisa: for confirmed tickets, stop time at the decision date
  const frozenSisaGroup = useMemo(() => {
    if (!note) return null;
    const choice = note.choice;
    if (choice === "sudah_perpanjang" || choice === "diperpanjang") {
      // freeze at SK date (tgl_surat from renewal of first asset with renewal info)
      const tglSurat = group.find(r => r.renewal?.tgl_surat)?.renewal?.tgl_surat;
      if (tglSurat && nearest) return computeFrozenSisa(nearest.tgl_berakhir, tglSurat);
    } else if (choice === "tidak") {
      // freeze at confirmation date
      if (note.updated_at && nearest) return computeFrozenSisa(nearest.tgl_berakhir, note.updated_at);
    }
    return null;
  }, [note, group, nearest]);

  const displayMinSisa = frozenSisaGroup ? frozenSisaGroup.sisa_hari : minSisa;
  const worstStatus: keyof typeof EWS_COLORS =
    displayMinSisa <= 0 ? "lewat" : displayMinSisa <= 90 ? "kritis" : displayMinSisa <= 180 ? "perhatian" : "aman";
  const colors = EWS_COLORS[worstStatus];

  const kpknlId = cached?.kpknlId;

  function startEdit() {
    // Map legacy "diperpanjang" → "sudah_perpanjang" for editing
    const c = note?.choice;
    setFormChoice(c === "diperpanjang" ? "sudah_perpanjang" : (c ?? ""));
    setFormNote(note?.note ?? "");
    setFormTiketPerpanjangan(note?.no_tiket_perpanjangan ?? "");
    setSpResult(note?.surat_persetujuan ? { ok: true, noSurat: note.surat_persetujuan } : null);
    setFormDirty(false);
    setEditing(true);
  }

  async function lookupSuratPersetujuan(tiketNo: string) {
    if (!tiketNo.trim()) { setSpResult(null); return; }
    setSpLoading(true);
    setSpResult(null);
    try {
      const res = await send<{ ok: boolean; noSurat?: string; error?: string }>({
        type: "siman/get-surat-persetujuan",
        noTiketPerpanjangan: tiketNo.trim(),
        idTipePengelolaan: 5,
      });
      setSpResult(res);
    } catch (e) {
      setSpResult({ ok: false, error: String(e) });
    } finally {
      setSpLoading(false);
    }
  }

  async function handleSave() {
    if (!formChoice || kpknlId == null) return;
    const noteDefaults: Record<string, string> = {
      sudah_perpanjang: "Sudah perpanjang",
      proses_perpanjangan: "Proses perpanjangan",
      tidak: "Tidak diperpanjang",
    };
    const isConfirmed = formChoice === "sudah_perpanjang" || formChoice === "proses_perpanjangan";
    const payload = {
      no_tiket: noTiket,
      kpknl_id: kpknlId,
      note: formNote || noteDefaults[formChoice] || "",
      status: (isConfirmed ? "confirmed" : "dismissed") as "confirmed" | "dismissed",
      choice: formChoice as "sudah_perpanjang" | "proses_perpanjangan" | "tidak",
      author: userName,
      no_tiket_perpanjangan: (formChoice === "sudah_perpanjang" || formChoice === "proses_perpanjangan")
        ? formTiketPerpanjangan.trim() || undefined
        : undefined,
      surat_persetujuan: formChoice === "sudah_perpanjang" && spResult?.ok
        ? spResult.noSurat
        : undefined,
    };
    const res = await send<{ ok: boolean; error?: string }>({ type: "ews/note-upsert", note: payload });
    if (res?.ok) {
      const saved: EwsNoteLocal = { ...payload, updated_at: new Date().toISOString(), last_synced_at: note?.last_synced_at };
      setNote(saved);
      setEditing(false);
      setFormDirty(false);
      setSyncMsg({ kind: "info", text: "Tersimpan lokal — auto-push ke server di latar." });
    } else {
      setSyncMsg({ kind: "err", text: res?.error || "Gagal menyimpan" });
    }
  }

  async function handleRemove() {
    if (kpknlId == null) return;
    setShowRemove(false);
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
          <button class="btn" onClick={onBack}><Icon name="chevron-left" size={16} /> Kembali</button>
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
            <span style={`font-weight:600;color:${colors.text}`}>
              {frozenSisaGroup
                ? `${frozenSisaGroup.sisa_label} (saat ${
                    (note?.choice === "sudah_perpanjang" || note?.choice === "diperpanjang") ? "SK" : "konfirmasi"
                  })`
                : nearest.sisa_label
              }
            </span>
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

        {!editing && isConfirmed && (() => {
          const ch = note!.choice;
          const isPositive = ch === "diperpanjang" || ch === "sudah_perpanjang";
          const isProses = ch === "proses_perpanjangan";
          const borderColor = isPositive ? "var(--ews-confirmed)" : isProses ? "var(--ews-perhatian)" : "var(--ews-dismissed)";
          const label = isPositive ? "Sudah Perpanjang"
            : isProses ? "Proses Perpanjangan"
            : "Tidak Diperpanjang";
          return (
            <div
              style={`padding:10px 12px;border-radius:var(--radius-sm);border:1px solid var(--line);border-left:3px solid ${borderColor};background:var(--surface-2)`}
            >
              <div style="display:flex;align-items:center;gap:8px">
                <span style={`width:8px;height:8px;border-radius:50%;background:${borderColor};flex-shrink:0`} />
                <div style="flex:1;min-width:0">
                  <div style={`font-size:12px;font-weight:600;color:${borderColor}`}>{label}</div>
                  {note!.no_tiket_perpanjangan && (
                    <div style="font-size:11px;color:var(--text-primary);margin-top:3px">
                      Tiket Perpanjangan: <b>{note!.no_tiket_perpanjangan}</b>
                    </div>
                  )}
                  {note!.surat_persetujuan && (
                    <div style="font-size:11px;color:var(--ews-confirmed);margin-top:2px">
                      Surat Persetujuan: <b>{note!.surat_persetujuan}</b>
                    </div>
                  )}
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
                  onClick={() => setShowRemove(true)}
                >
                  Hapus
                </button>
              </div>
            </div>
          );
        })()}

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
              onChange={(e) => {
                const v = (e.target as HTMLSelectElement).value as typeof formChoice;
                setFormChoice(v);
                setFormDirty(true);
                if (v !== "sudah_perpanjang" && v !== "proses_perpanjangan") {
                  setFormTiketPerpanjangan("");
                  setSpResult(null);
                }
              }}
              style="font-size:12px;padding:8px;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-sm);color:var(--text-primary)"
            >
              <option value="">-- Pilih status --</option>
              <option value="sudah_perpanjang">Sudah Perpanjang</option>
              <option value="proses_perpanjangan">Proses Perpanjangan</option>
              <option value="tidak">Tidak Diperpanjang</option>
            </select>

            {/* Ticket number input for sudah_perpanjang & proses_perpanjangan */}
            {(formChoice === "sudah_perpanjang" || formChoice === "proses_perpanjangan") && (
              <div style="display:flex;flex-direction:column;gap:4px">
                <label style="font-size:11px;color:var(--muted)">
                  {formChoice === "sudah_perpanjang" ? "Nomor Tiket Perpanjangan:" : "Nomor Tiket yang Sedang Berproses:"}
                </label>
                <input
                  type="text"
                  placeholder="Masukkan nomor tiket SIMAN"
                  value={formTiketPerpanjangan}
                  onInput={(e) => { setFormTiketPerpanjangan((e.target as HTMLInputElement).value); setFormDirty(true); }}
                  onBlur={() => {
                    if (formChoice === "sudah_perpanjang") lookupSuratPersetujuan(formTiketPerpanjangan);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && formChoice === "sudah_perpanjang") lookupSuratPersetujuan(formTiketPerpanjangan);
                  }}
                  style="font-size:12px;padding:8px;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-sm);color:var(--text-primary)"
                />
                {/* SP lookup result (only for sudah_perpanjang) */}
                {formChoice === "sudah_perpanjang" && spLoading && (
                  <div style="font-size:11px;color:var(--muted);padding:4px 0">Mencari Surat Persetujuan…</div>
                )}
                {formChoice === "sudah_perpanjang" && spResult && (
                  spResult.ok ? (
                    <div style="font-size:11px;padding:6px 8px;border-radius:var(--radius-sm);border:1px solid var(--ews-confirmed);color:var(--ews-confirmed);background:var(--surface);display:flex;align-items:center;gap:4px">
                      <Icon name="check" size={14} /> Surat Persetujuan: <b>{spResult.noSurat}</b>
                    </div>
                  ) : (
                    <div style="font-size:11px;padding:6px 8px;border-radius:var(--radius-sm);border:1px solid var(--ews-kritis);color:var(--ews-kritis);background:var(--surface);display:flex;align-items:center;gap:4px">
                      <Icon name="alert" size={14} /> {spResult.error || "Surat Persetujuan tidak ditemukan"}
                    </div>
                  )
                )}
              </div>
            )}

            <textarea
              placeholder="Catatan (opsional)"
              value={formNote}
              onInput={(e) => { setFormNote((e.target as HTMLTextAreaElement).value); setFormDirty(true); }}
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
                onClick={() => { if (formDirty) setShowDiscard(true); else { setEditing(false); setFormChoice(""); setFormNote(""); setFormTiketPerpanjangan(""); setSpResult(null); } }}
              >
                Batal
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Asset list */}
      <div style={cardStyle}>
        <button type="button" onClick={() => setAssetsExpanded((v) => !v)} style="display:flex;align-items:center;gap:6px;font-size:13px;font-weight:700;margin-bottom:8px;color:var(--text-primary);background:none;border:none;cursor:pointer;width:100%;text-align:left;padding:0;font-family:inherit">
          <span style={`display:inline-flex;transform:rotate(${assetsExpanded ? 90 : 0}deg);transition:transform 0.15s`}><Icon name="chevron-right" size={14} /></span>
          Daftar Aset ({group.length})
        </button>
        {assetsExpanded && (
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
                    {(() => {
                      // Per-asset frozen sisa
                      const choice = note?.choice;
                      const frozenDate =
                        (choice === "sudah_perpanjang" || choice === "diperpanjang") ? (r.renewal?.tgl_surat ?? null)
                        : choice === "tidak" ? (note?.updated_at ?? null)
                        : null;
                      const frozen = frozenDate ? computeFrozenSisa(r.tgl_berakhir, frozenDate) : null;
                      if (frozen) {
                        const label = (choice === "sudah_perpanjang" || choice === "diperpanjang") ? "SK" : "konfirmasi";
                        return `${frozen.sisa_label} (saat ${label})`;
                      }
                      return r.sisa_label;
                    })()}
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
                        <RenewalMatches renewal={r.renewal} />
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
                        <RenewalMatches renewal={r.renewal} />
                      </div>
                    )
                  ) : (
                    <div style="margin-top:6px;padding:6px 8px;border-radius:var(--radius-sm);border:1px solid var(--line);border-left:3px solid var(--ews-kritis);background:var(--surface)">
                      <div style="font-weight:600;color:var(--ews-kritis);font-size:12px">Belum Ada Perpanjangan</div>
                      <div style="color:var(--muted);font-size:11px;margin-top:2px">Tidak ditemukan SK sewa baru untuk aset ini</div>
                    </div>
                  ))}

                {/* PKS Masa Aktif Sewa */}
                {r.pks_tgl_perjanjian ? (() => {
                  const pksColor = r.pks_sisa_hari != null
                    ? EWS_COLORS[r.pks_sisa_hari <= 0 ? "lewat" : r.pks_sisa_hari <= 90 ? "kritis" : r.pks_sisa_hari <= 180 ? "perhatian" : "aman"]
                    : EWS_COLORS.aman;
                  return (
                    <div style="margin-top:6px;padding:6px 8px;border-radius:var(--radius-sm);border:1px solid var(--line);background:var(--surface)">
                      <div style="font-weight:600;font-size:12px;color:var(--text-primary);display:flex;align-items:center;gap:4px"><Icon name="clipboard-list" size={14} /> Masa Aktif Sewa (PKS)</div>
                      <div style="display:flex;gap:12px;margin-top:4px;font-size:11px;color:var(--muted);flex-wrap:wrap">
                        <span>Mulai: <b>{r.pks_tgl_perjanjian}</b></span>
                        <span>Berakhir: <b>{r.pks_tgl_berakhir || "-"}</b></span>
                        {r.pks_sisa_label && (
                          <span style={`font-weight:600;color:${pksColor.text}`}>{r.pks_sisa_label}</span>
                        )}
                      </div>
                    </div>
                  );
                })() : (
                  <div style="margin-top:6px;padding:6px 8px;border-radius:var(--radius-sm);border:1px solid var(--line);background:var(--surface)">
                    <div style="font-weight:600;font-size:12px;color:var(--text-primary);display:flex;align-items:center;gap:4px"><Icon name="clipboard-list" size={14} /> Masa Aktif Sewa (PKS)</div>
                    <div style="font-size:11px;color:var(--muted);margin-top:4px">-</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        )}
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

      {showRemove && (
        <div class="modal-overlay" onClick={() => setShowRemove(false)}>
          <div class="modal" onClick={(e) => e.stopPropagation()}>
            <h2 class="modal__title"><Icon name="alert" /> Hapus Konfirmasi?</h2>
            <p class="modal__sub">Catatan untuk tiket <b>{noTiket}</b> akan dihapus (lokal + server).</p>
            <div class="modal__actions">
              <button class="btn btn--ghost" onClick={() => setShowRemove(false)}>Batal</button>
              <button class="btn btn--danger" onClick={handleRemove}><Icon name="trash" size={14} /> Hapus</button>
            </div>
          </div>
        </div>
      )}

      {showDiscard && (
        <div class="modal-overlay" onClick={() => setShowDiscard(false)}>
          <div class="modal" onClick={(e) => e.stopPropagation()}>
            <h2 class="modal__title"><Icon name="alert" /> Buang Perubahan?</h2>
            <p class="modal__sub">Perubahan formulir belum disimpan.</p>
            <div class="modal__actions">
              <button class="btn btn--ghost" onClick={() => setShowDiscard(false)}>Lanjut Edit</button>
              <button class="btn btn--danger" onClick={() => { setEditing(false); setFormChoice(""); setFormNote(""); setFormTiketPerpanjangan(""); setSpResult(null); setShowDiscard(false); }}><Icon name="trash" size={14} /> Buang</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RenewalMatches({ renewal }: { renewal: { match_luas?: boolean; match_tujuan?: boolean; match_keterangan?: boolean } }) {
  const Badge = ({ label, ok }: { label: string; ok?: boolean }) => (
    <span style={`padding:2px 6px;border-radius:var(--radius-sm);border:1px solid var(--line);${ok ? "color:var(--ews-confirmed)" : "color:var(--error)"}`}>
      {label}: {ok ? <span style="display:inline-flex;align-items:center;gap:2px"><Icon name="check" size={11} /> Cocok</span> : <span style="display:inline-flex;align-items:center;gap:2px"><Icon name="x" size={11} /> Beda</span>}
    </span>
  );
  return (
    <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;font-size:11px">
      <Badge label="Luas" ok={renewal.match_luas} />
      <Badge label="Tujuan" ok={renewal.match_tujuan} />
      <Badge label="Keterangan" ok={renewal.match_keterangan} />
    </div>
  );
}
