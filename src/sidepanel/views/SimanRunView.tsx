import { useState, useEffect } from "preact/hooks";
import type { SimanTemplate, SimanRunProgressMsg } from "@/shared/types";
import { renderDocx, uint8ToBase64 } from "@/sidepanel/mailmerge/docx-render";
import { Icon } from "../components/Icon";

type CustomVarDef = { outputKey: string; sourceKey: string; transform: string };

function applyTransform(v: string, transform: string): string {
  switch (transform) {
    case "UPPERCASE": return v.toUpperCase();
    case "lowercase": return v.toLowerCase();
    case "TitleCase": return v.split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
    case "formatDate": {
      const bulan = ["Januari","Februari","Maret","April","Mei","Juni","Juli","Agustus","September","Oktober","November","Desember"];
      const raw = v.slice(0, 10);
      for (const sep of ["-", "/"]) {
        const p = raw.split(sep);
        if (p.length === 3) {
          const [a, b, c] = p.map(Number);
          const d = a > 31 ? new Date(a, b - 1, c) : new Date(c, b - 1, a);
          if (!isNaN(d.getTime())) return `${d.getDate()} ${bulan[d.getMonth()]} ${d.getFullYear()}`;
        }
      }
      return v;
    }
    case "riUPPER": {
      const u = v.trim().toUpperCase();
      return (u.endsWith("REPUBLIK INDONESIA") || u.endsWith(" RI")) ? v.trim() : `${v.trim()} REPUBLIK INDONESIA`;
    }
    case "riTitle": {
      const tc = (s: string) => s.split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
      const u = v.trim().toUpperCase();
      return (u.endsWith("REPUBLIK INDONESIA") || u.endsWith(" RI")) ? tc(v.trim()) : `${tc(v.trim())} Republik Indonesia`;
    }
    default: return v;
  }
}

function applyCustomVars(vars: Record<string, string>, customVars: CustomVarDef[]): Record<string, string> {
  const out = { ...vars };
  for (const cv of customVars) {
    if (!cv.outputKey || !cv.sourceKey) continue;
    out[cv.outputKey] = applyTransform(vars[cv.sourceKey] ?? "", cv.transform);
  }
  return out;
}

function downloadDocx(base64: string, filename: string) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function sendMsg<T>(msg: unknown): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

interface Props {
  noTiket: string;
  idPengelolaan: string;
  idTipePengelolaan: string;
  templateId: string;
  onDone: () => void;
  onBack: () => void;
}

type Phase = "fetching" | "preview" | "rendering" | "rendered" | "pick-np" | "sending" | "done" | "error";

export function SimanRunView({ noTiket, idPengelolaan, idTipePengelolaan, templateId, onDone }: Props) {
  const [phase, setPhase] = useState<Phase>("fetching");
  const [steps, setSteps] = useState<string[]>([]);
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [missingKeys, setMissingKeys] = useState<string[]>([]);
  const [template, setTemplate] = useState<SimanTemplate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ndId, setNdId] = useState<number | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [showDebug, setShowDebug] = useState(false);
  const [renderedNd, setRenderedNd] = useState<{ base64: string; filename: string } | null>(null);
  const [renderedNp, setRenderedNp] = useState<{ base64: string; filename: string } | null>(null);
  const [targetNdId, setTargetNdId] = useState("");
  const [npPenandatangan, setNpPenandatangan] = useState<Record<string, unknown> | null>(null);
  const [npUnits, setNpUnits] = useState<Record<string, unknown>[] | null>(null);
  const [npUnitsLoading, setNpUnitsLoading] = useState(false);

  useEffect(() => {
    setPhase("fetching");
    setSteps([]);
    setError(null);
    setRenderedNd(null);
    setRenderedNp(null);

    sendMsg<{ ok: boolean; data?: SimanTemplate[] }>({ type: "siman/get-templates" })
      .then((r) => {
        if (r.ok && r.data) {
          const t = r.data.find((x) => x.id === templateId) ?? null;
          setTemplate(t);
          if (t?.npPenandatangan) setNpPenandatangan(t.npPenandatangan);
        }
      });

    const port = chrome.runtime.connect({ name: "siman-run" });
    port.onMessage.addListener((msg: SimanRunProgressMsg) => {
      if (msg.status === "running") {
        setSteps((s) => [...s, msg.step]);
      } else if (msg.status === "done" && msg.step === "variables") {
        const missing = (msg.message ?? "").split(",").filter(Boolean);
        setVariables(msg.variables ?? {});
        setMissingKeys(missing);
        setPhase("preview");
      } else if (msg.status === "error") {
        setError(msg.message ?? "Error tidak diketahui");
        setPhase("error");
      }
    });
    port.postMessage({ type: "siman/run", noTiket, idPengelolaan, idTipePengelolaan, templateId });
    return () => port.disconnect();
  }, [retryCount]);

  useEffect(() => {
    if (phase !== "pick-np" || npUnits !== null) return;
    setNpUnitsLoading(true);
    sendMsg<{ ok: boolean; data?: Record<string, unknown>[]; error?: string }>(
      { type: "template/units", kodeOrganisasi: "", pengirimEselon: 3 }
    )
      .then((r) => { if (r.ok) setNpUnits(r.data ?? []); else setNpUnits([]); })
      .catch(() => setNpUnits([]))
      .finally(() => setNpUnitsLoading(false));
  }, [phase]);

  function getRenderVars() {
    const base = template?.customVars?.length
      ? applyCustomVars(variables, template.customVars)
      : variables;

    // Apply template mapping: docx placeholders use names like {jenis_bmn}
    // but variables are keyed by SIMAN names like nm_jns_bmn.
    // The mapping bridges them: "{jenis_bmn}" → "nm_jns_bmn".
    // Build a render map keyed by placeholder names so renderDocx can find them.
    if (!template?.mapping || Object.keys(template.mapping).length === 0) {
      return base;
    }
    const docxData: Record<string, string> = { ...base };
    for (const [ph, varKey] of Object.entries(template.mapping)) {
      const placeholderName = ph.replace(/^\{|\}$/g, "");
      if (varKey === "__ask__") {
        // __ask__ means the placeholder key IS the variable key
        if (base[placeholderName] !== undefined) {
          docxData[placeholderName] = base[placeholderName];
        }
      } else if (varKey) {
        // Map: placeholder name ← value from the SIMAN variable
        const value = base[varKey];
        if (value !== undefined) {
          docxData[placeholderName] = value;
        }
      }
    }
    return docxData;
  }

  function handleRender() {
    if (!template?.konsepNd) return;
    const renderVars = getRenderVars();
    const stillMissing = missingKeys.filter((k) => !renderVars[k]);
    if (stillMissing.length > 0) {
      alert(`Isi variabel yang kosong: ${stillMissing.join(", ")}`);
      return;
    }
    setPhase("rendering");
    try {
      const ndBytes = renderDocx(template.konsepNd.base64, renderVars);
      setRenderedNd({ base64: uint8ToBase64(ndBytes), filename: template.konsepNd.name });
      if (template.konsepNp) {
        const npBytes = renderDocx(template.konsepNp.base64, renderVars);
        setRenderedNp({ base64: uint8ToBase64(npBytes), filename: template.konsepNp.name });
      }
      setTargetNdId(renderVars.id_nadine ?? "");
      const needsPicker = !!template.konsepNp && !template.npPenandatangan && !npPenandatangan;
      setPhase(needsPicker ? "pick-np" : "rendered");
    } catch (e) {
      setError(String(e));
      setPhase("error");
    }
  }

  function connectAndSend(msg: unknown) {
    setPhase("sending");
    setSteps([]);
    const port = chrome.runtime.connect({ name: "siman-run" });
    port.onMessage.addListener((m: SimanRunProgressMsg) => {
      if (m.status === "running") setSteps((s) => [...s, m.step]);
      else if (m.status === "done" && m.step === "done") {
        setNdId(m.ndId ?? null);
        setPhase("done");
        port.disconnect();
      } else if (m.status === "error") {
        setError(m.message ?? "Error tidak diketahui");
        setPhase("error");
        port.disconnect();
      }
    });
    port.postMessage(msg);
  }

  function handleUploadToExisting() {
    const ndIdNum = Number(targetNdId);
    if (!ndIdNum || !renderedNd) {
      alert("Masukkan ID Naskah Nadine yang valid.");
      return;
    }
    // If NP template exists but no penandatangan chosen yet, go pick one first
    if (renderedNp && !npPenandatangan) {
      setNpUnits(null);
      setPhase("pick-np");
      return;
    }
    connectAndSend({
      type: "siman/upload-nd",
      templateId,
      variables: getRenderVars(),
      ndId: ndIdNum,
      ndDocxBase64: renderedNd.base64,
      ndFilename: renderedNd.filename,
      npDocxBase64: renderedNp?.base64,
      npFilename: renderedNp?.filename,
      npPenandatangan: npPenandatangan ?? undefined,
    });
  }


  // --- Phases ---

  if (phase === "fetching") {
    return (
      <div style="padding:12px">
        <p class="hint">Mengambil data SIMAN…</p>
        {steps.map((s, i) => <div key={i} style="font-size:12px;color:var(--muted);margin-bottom:4px;display:inline-flex;align-items:center;gap:4px"><Icon name="loader" size={12} /> {s}</div>)}
      </div>
    );
  }

  if (phase === "preview") {
    const effectiveVars = getRenderVars();
    const knownGroups: Record<string, string[]> = {
      "Detail Permohonan": ["no_tiket","kd_satker","ur_satker","ur_satker_title","nm_jns_bmn","pemohon","pemohon_title","ur_kl","ur_kl_title","id_satker","nama_tipe_pengelolaan","nama_jenis_pengelolaan","termohon","deskripsi","durasi_penetapan"],
      "Referensi Satker": ["alamat_satker","nm_kab_kota","email_kantor","no_telp_kantor","ur_eselon1","ur_kel","ur_kec","ur_prov","alamat_lengkap","alamat_lengkap_title"],
      "Kalkulasi Aset": ["jumlah_aset","sum_total_permohonan","sum_total_buku","sum_total_perolehan","sum_nilai_persetujuan","sum_nilai_perolehan_proporsional","nilai_persetujuan_sewa","sum_total_permohonan_fmt","sum_total_buku_fmt","sum_total_perolehan_fmt","sum_nilai_persetujuan_fmt","sum_nilai_perolehan_proporsional_fmt","nilai_persetujuan_sewa_fmt"],
      "Pembilang": ["pembilang_total_permohonan","pembilang_total_buku","pembilang_total_perolehan","pembilang_nilai_persetujuan","pembilang_nilai_perolehan_proporsional","pembilang_nilai_sewa"],
      "Surat Keputusan": ["no_surat","tgl_surat","tgl_surat_formal","perihal_sk","perihal_sk_title","nama_penandatangan_sk","jabatan_penandatangan_sk","id_nadine"],
      "Berita Acara / Surat": ["nm_dok_ba","no_dok_ba","tgl_dokumen_ba","perihal_surat","perihal_surat_title"],
    };
    const groupedKeys = new Set(Object.values(knownGroups).flat());
    // Raw API fields (sk_* prefix = from SK API; anything else not in known groups)
    const rawSkKeys = Object.keys(effectiveVars).filter((k) => k.startsWith("sk_"));
    const otherRawKeys = Object.keys(effectiveVars).filter((k) => !groupedKeys.has(k) && !rawSkKeys.includes(k));
    const debugGroups: Record<string, string[]> = {
      ...knownGroups,
      ...(rawSkKeys.length ? { "Raw: Surat Keputusan API": rawSkKeys } : {}),
      ...(otherRawKeys.length ? { "Raw: Lainnya": otherRawKeys } : {}),
    };

    return (
      <div style="padding:12px">
        <div style="font-weight:600;font-size:13px;margin-bottom:8px">Preview Variabel — {noTiket}</div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:10px;display:flex;gap:8px;align-items:center">
          <span>{Object.keys(effectiveVars).length} variabel · {missingKeys.length} perlu diisi</span>
          <button
            style="font-size:10px;padding:2px 6px;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-sm);cursor:pointer;color:var(--text-primary)"
            onClick={() => setShowDebug((d) => !d)}
          >{showDebug ? "Sembunyikan Debug" : "Debug Semua Variabel"}</button>
        </div>

        {showDebug ? (
          <div style="max-height:55vh;overflow-y:auto;margin-bottom:12px;display:flex;flex-direction:column;gap:8px">
            {Object.entries(debugGroups).map(([group, keys]) => {
              const present = keys.filter((k) => effectiveVars[k] !== undefined && effectiveVars[k] !== "");
              if (!present.length) return null;
              return (
                <div key={group}>
                  <div style="font-size:10px;font-weight:600;color:var(--muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px">{group}</div>
                  {present.map((k) => (
                    <div key={k} style="display:flex;gap:6px;padding:3px 0;border-bottom:1px solid var(--line)">
                      <code style="flex:0 0 150px;font-size:10px;color:var(--color-primary)">{k}</code>
                      <span style="font-size:10px;color:var(--text-primary);word-break:break-all">{effectiveVars[k]}</span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        ) : (
          <div style="display:flex;flex-direction:column;gap:4px;max-height:55vh;overflow-y:auto;margin-bottom:12px">
            {missingKeys.map((k) => (
              <div key={k} style="display:flex;gap:6px;align-items:center;padding:5px 8px;background:color-mix(in srgb, var(--error) 8%, transparent);border:1px solid color-mix(in srgb, var(--error) 25%, transparent);border-radius:var(--radius-sm)">
                <span style="color:var(--error);font-size:11px;width:12px">!</span>
                <code style="flex:0 0 130px;font-size:10px;color:var(--error)">{k}</code>
                <input
                  style="flex:1;font-size:11px;padding:2px 6px;background:var(--surface);border:1px solid var(--error);border-radius:var(--radius-sm);color:var(--text-primary)"
                  value={effectiveVars[k] ?? ""}
                  placeholder={`Isi ${k}…`}
                  onInput={(e) => {
                    const val = (e.target as HTMLInputElement).value;
                    setVariables((v) => ({ ...v, [k]: val }));
                  }}
                />
              </div>
            ))}
            {(() => {
              // Only show vars actually used by this template's mapping
              const mappedKeys = new Set(
                Object.entries(template?.mapping ?? {}).map(([ph, varKey]) =>
                  varKey === "__ask__" ? ph.replace(/^\{|\}$/g, "") : varKey,
                ).filter(Boolean),
              );
              return Object.entries(effectiveVars)
                .filter(([k]) => !missingKeys.includes(k) && mappedKeys.has(k))
                .map(([k, v]) => (
                  <div key={k} style="display:flex;gap:6px;align-items:center;padding:5px 8px;background:color-mix(in srgb, var(--color-primary) 6%, transparent);border-radius:var(--radius-sm)">
                    <span style="color:var(--color-primary);font-size:11px;width:12px;display:inline-flex;align-items:center"><Icon name="check" size={12} /></span>
                    <code style="flex:0 0 130px;font-size:10px;color:var(--color-primary)">{k}</code>
                    <input
                      style="flex:1;font-size:11px;padding:2px 6px;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-sm);color:var(--text-primary)"
                      value={v}
                      onInput={(e) => {
                        const val = (e.target as HTMLInputElement).value;
                        setVariables((vv) => ({ ...vv, [k]: val }));
                      }}
                    />
                  </div>
                ));
            })()}
          </div>
        )}

        <button class="btn" style="width:100%" onClick={handleRender}>
          <Icon name="play" /> Render Dokumen
        </button>
      </div>
    );
  }

  if (phase === "rendering") {
    return (
      <div style="padding:12px">
        <p class="hint">Merender dokumen…</p>
      </div>
    );
  }

  if (phase === "rendered") {
    const detectedFromSiman = !!getRenderVars().id_nadine;
    return (
      <div style="padding:12px;display:flex;flex-direction:column;gap:10px">
        <div style="font-weight:600;font-size:13px">Dokumen Siap — {noTiket}</div>

        {/* Download section */}
        <div class="card">
          <div style="font-size:11px;font-weight:600;margin-bottom:8px">Download Dokumen</div>
          <button
            class="btn btn--ghost"
            style="width:100%;margin-bottom:6px;font-size:12px"
            onClick={() => downloadDocx(renderedNd!.base64, renderedNd!.filename)}
          ><Icon name="download" /> {renderedNd?.filename}</button>
          {renderedNp && (
            <button
              class="btn btn--ghost"
              style="width:100%;font-size:12px"
              onClick={() => downloadDocx(renderedNp.base64, renderedNp.filename)}
            ><Icon name="download" /> {renderedNp.filename}</button>
          )}
        </div>

        {/* Upload to existing ndId */}
        <div class="card">
          <div style="font-size:11px;font-weight:600;margin-bottom:6px">Upload ke Naskah Nadine yang Ada</div>
          {detectedFromSiman && (
            <div style="font-size:10px;color:var(--color-primary);margin-bottom:6px">
              <Icon name="check" /> Terdeteksi dari SIMAN: ND #{targetNdId}
            </div>
          )}
          <div style="display:flex;gap:6px;margin-bottom:6px">
            <input
              class="field__input"
              style="flex:1;font-size:12px"
              placeholder="ND ID (angka)"
              value={targetNdId}
              onInput={(e) => setTargetNdId((e.target as HTMLInputElement).value)}
            />
            <button class="btn" style="font-size:12px;white-space:nowrap" onClick={handleUploadToExisting}>
              Upload
            </button>
          </div>
          <div style="font-size:10px;color:var(--muted)">Upload konsep ND (dan NP) ke naskah yang sudah ada di Nadine.</div>
        </div>

        {/* NP penandatangan indicator */}
        {renderedNp && (
          <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:color-mix(in srgb, var(--color-primary) 6%, transparent);border-radius:var(--radius-sm);font-size:11px">
            <span>
              <span style="color:var(--muted)">NP Penandatangan: </span>
              {npPenandatangan
                ? <strong>{String(npPenandatangan.NamaJabatan ?? npPenandatangan.NamaPejabat ?? "?")}</strong>
                : <span style="color:var(--error)">Belum dipilih</span>
              }
            </span>
            <button
              style="font-size:10px;padding:2px 6px;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-sm);cursor:pointer;color:var(--text-primary)"
              onClick={() => { setNpUnits(null); setPhase("pick-np"); }}
            >Ganti</button>
          </div>
        )}

        <button
          class="btn btn--ghost"
          style="width:100%;font-size:12px"
          onClick={onDone}
        >Selesai (Tanpa Kirim ke Nadine)</button>
      </div>
    );
  }

  if (phase === "pick-np") {
    return (
      <div style="padding:12px">
        <div style="font-weight:600;font-size:13px;margin-bottom:4px">Pilih Penandatangan NP</div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:10px">
          Pilihan akan disimpan ke template untuk run berikutnya.
        </div>
        {npUnitsLoading && <p class="hint">Memuat daftar pejabat…</p>}
        {!npUnitsLoading && npUnits?.length === 0 && (
          <p class="hint" style="color:var(--error)">Tidak ada pejabat ditemukan.</p>
        )}
        {!npUnitsLoading && npUnits && npUnits.map((u, i) => (
          <button
            key={i}
            class="btn btn--ghost"
            style="width:100%;margin-bottom:6px;text-align:left"
            onClick={() => { setNpPenandatangan(u); setPhase("rendered"); }}
          >
            <strong style="font-size:12px">{String(u.NamaJabatan ?? u.NamaPejabat ?? "")}</strong><br />
            <small style="color:var(--muted)">{String(u.NamaPejabat ?? u.NamaOrganisasi ?? "")}</small>
          </button>
        ))}
        <button class="btn btn--ghost" style="width:100%;margin-top:6px;font-size:12px" onClick={() => setPhase("rendered")}>
          Lewati (Tanpa NP)
        </button>
      </div>
    );
  }

  if (phase === "sending") {
    return (
      <div style="padding:12px">
        <p class="hint">Mengirim ke Nadine…</p>
        {steps.map((s, i) => <div key={i} style="font-size:12px;color:var(--muted);margin-bottom:4px;display:inline-flex;align-items:center;gap:4px"><Icon name="loader" size={12} /> {s}</div>)}
      </div>
    );
  }

  if (phase === "done") {
    return (
      <div style="padding:12px;text-align:center">
        <div style="margin-bottom:8px"><Icon name="circle-check" size={32} /></div>
        <div style="font-weight:600;margin-bottom:4px">Berhasil!</div>
        {ndId && <div class="hint">ND ID: {ndId}</div>}
        <button class="btn" style="margin-top:16px;width:100%" onClick={onDone}>Kembali ke Daftar</button>
      </div>
    );
  }

  return (
    <div style="padding:12px">
      <div style="color:var(--error);margin-bottom:8px" role="alert"><Icon name="circle-x" /> Error: {error}</div>
      <div style="display:flex;gap:8px">
        <button class="btn btn--ghost" style="flex:1" onClick={() => setRetryCount((c) => c + 1)}>Coba Lagi</button>
        {phase === "error" && renderedNd && (
          <button class="btn btn--ghost" style="flex:1" onClick={() => setPhase("rendered")}>Kembali ke Dokumen</button>
        )}
      </div>
    </div>
  );
}
