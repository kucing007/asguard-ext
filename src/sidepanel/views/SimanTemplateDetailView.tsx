import { useState, useEffect, useRef } from "preact/hooks";
import type { SimanTemplate, SimanTipePengelolaan } from "@/shared/types";
import { scanPlaceholders } from "@/sidepanel/mailmerge/placeholder-scan";
import { Icon } from "../components/Icon";
import { useModalEscape } from "../components/useModalEscape";

function send<T>(msg: unknown): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

const SIMAN_VARIABLE_KEYS = [
  // Detail Permohonan
  "no_tiket","kd_satker","ur_satker","ur_satker_title","nm_jns_bmn","pemohon","pemohon_title",
  "ur_kl","ur_kl_title","id_satker","nama_tipe_pengelolaan","nama_jenis_pengelolaan",
  "termohon","deskripsi","durasi_penetapan",
  // Satker Referensi
  "alamat_satker","nm_kab_kota","email_kantor","no_telp_kantor","ur_eselon1",
  "ur_kel","ur_kec","ur_prov","alamat_lengkap","alamat_lengkap_title",
  // Aset Kalkulasi (raw)
  "jumlah_aset","sum_total_permohonan","sum_total_buku","sum_total_perolehan",
  "sum_nilai_persetujuan","sum_nilai_perolehan_proporsional","nilai_persetujuan_sewa",
  // Aset Kalkulasi (formatted)
  "sum_total_permohonan_fmt","sum_total_buku_fmt","sum_total_perolehan_fmt",
  "sum_nilai_persetujuan_fmt","sum_nilai_perolehan_proporsional_fmt","nilai_persetujuan_sewa_fmt",
  // Pembilang
  "pembilang_total_permohonan","pembilang_total_buku","pembilang_total_perolehan",
  "pembilang_nilai_persetujuan","pembilang_nilai_perolehan_proporsional","pembilang_nilai_sewa",
  // Surat Keputusan
  "no_surat","tgl_surat","tgl_surat_formal","perihal_sk","perihal_sk_title",
  "nama_penandatangan_sk","jabatan_penandatangan_sk","id_nadine",
  // Surat & Dokumen
  "perihal_surat","perihal_surat_title","nm_dok_ba","no_dok_ba","tgl_dokumen_ba",
];

const TRANSFORM_OPTIONS = [
  { value: "original",  label: "Tanpa Perubahan" },
  { value: "UPPERCASE", label: "HURUF KAPITAL SEMUA" },
  { value: "lowercase", label: "huruf kecil semua" },
  { value: "TitleCase", label: "Huruf Kapital Setiap Kata" },
  { value: "formatDate",label: "Format Tanggal (12 Januari 2024)" },
  { value: "riUPPER",   label: "Tambah REPUBLIK INDONESIA (kapital)" },
  { value: "riTitle",   label: "Tambah Republik Indonesia (judul)" },
];

type CustomVarDef = { outputKey: string; sourceKey: string; transform: string };

function autoOutputKey(sourceKey: string, transform: string): string {
  const suffixes: Record<string, string> = {
    UPPERCASE: "_upper", lowercase: "_lower", TitleCase: "_title",
    formatDate: "_formal", riUPPER: "_ri_upper", riTitle: "_ri_title", original: "_copy",
  };
  return sourceKey + (suffixes[transform] ?? "");
}

interface Props {
  templateId: string;
  onBack: () => void;
}

export function SimanTemplateDetailView({ templateId, onBack }: Props) {
  const isNew = templateId === "new";
  const [tipes, setTipes] = useState<SimanTipePengelolaan[]>([]);
  const [name, setName] = useState("");
  const [idTipe, setIdTipe] = useState(0);
  const [namaTipe, setNamaTipe] = useState("");
  const [konsepNd, setKonsepNd] = useState<{ name: string; base64: string } | undefined>();
  const [konsepNp, setKonsepNp] = useState<{ name: string; base64: string } | undefined>();
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [savedVariables, setSavedVariables] = useState<Record<string, string>>({});
  const [perihalVarKey, setPerihalVarKey] = useState("perihal_sk");
  const [customVars, setCustomVars] = useState<CustomVarDef[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState("");
  const [showDiscard, setShowDiscard] = useState(false);
  useModalEscape(showDiscard, () => setShowDiscard(false));
  const ndFileRef = useRef<HTMLInputElement>(null);
  const npFileRef = useRef<HTMLInputElement>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    send<{ ok: boolean; data?: SimanTipePengelolaan[] }>({ type: "siman/get-tipe-pengelolaan" })
      .then((r) => { if (r.ok) setTipes(r.data ?? []); });

    if (!isNew) {
      send<{ ok: boolean; data?: SimanTemplate[] }>({ type: "siman/get-templates" })
        .then((r) => {
          if (r.ok && r.data) {
            const t = r.data.find((x) => x.id === templateId);
            if (t) {
              setName(t.name);
              setIdTipe(t.idTipePengelolaan);
              setNamaTipe(t.namaTipe);
              setKonsepNd(t.konsepNd);
              setKonsepNp(t.konsepNp);
              setMapping(t.mapping ?? {});
              setSavedVariables(t.savedVariables ?? {});
              setPerihalVarKey(t.perihalVarKey ?? "perihal_sk");
              // Migrate old Record<string,string> format to array
              if (Array.isArray(t.customVars)) {
                setCustomVars(t.customVars as CustomVarDef[]);
              }
              setSnapshot(JSON.stringify({ name: t.name, idTipe: t.idTipePengelolaan, konsepNd: t.konsepNd?.name, konsepNp: t.konsepNp?.name, mapping: t.mapping ?? {}, customVars: Array.isArray(t.customVars) ? (t.customVars as CustomVarDef[]) : [] }));
            }
          }
        });
    }
  }, [templateId]);

  // Snapshot for dirty-check (new templates start from empty defaults)
  useEffect(() => {
    if (isNew) setSnapshot(JSON.stringify({ name: "", idTipe: 0, konsepNd: undefined, konsepNp: undefined, mapping: {}, customVars: [] }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function readDocx(file: File): Promise<{ name: string; base64: string }> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(",")[1];
        resolve({ name: file.name, base64 });
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function handleNdUpload(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const docx = await readDocx(file);
    setKonsepNd(docx);
    const placeholders = scanPlaceholders(docx.base64);
    const newMapping: Record<string, string> = {};
    for (const ph of placeholders) newMapping[ph] = mapping[ph] ?? "";
    if (konsepNp) {
      for (const ph of scanPlaceholders(konsepNp.base64)) {
        if (!newMapping[ph]) newMapping[ph] = mapping[ph] ?? "";
      }
    }
    setMapping(newMapping);
  }

  async function handleNpUpload(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const docx = await readDocx(file);
    setKonsepNp(docx);
    const newMapping = { ...mapping };
    for (const ph of scanPlaceholders(docx.base64)) {
      if (!newMapping[ph]) newMapping[ph] = "";
    }
    setMapping(newMapping);
  }

  async function save() {
    setError(null);
    if (!name || !idTipe || !konsepNd) {
      setError("Nama, tipe, dan konsep ND wajib diisi.");
      return;
    }
    setSaving(true);
    const partial: Omit<SimanTemplate, "id" | "createdAt"> = {
      name, idTipePengelolaan: idTipe, namaTipe,
      konsepNd, konsepNp, mapping, savedVariables,
      perihalVarKey,
      customVars: customVars.filter((cv) => cv.outputKey && cv.sourceKey),
      nadinePayload: {},
    };
    let res: { ok: boolean; error?: string };
    if (isNew) {
      res = await send<{ ok: boolean; error?: string }>({ type: "siman/save-template", template: partial });
    } else {
      res = await send<{ ok: boolean; error?: string }>({ type: "siman/template-update", id: templateId, updates: partial });
    }
    setSaving(false);
    if (!res.ok) {
      setError(`Gagal menyimpan: ${res.error ?? "unknown error"}`);
      return;
    }
    setSaved(true);
    setTimeout(() => onBack(), 800);
  }

  function updateCustomVar(i: number, patch: Partial<CustomVarDef>) {
    setCustomVars((prev) => prev.map((cv, idx) => {
      if (idx !== i) return cv;
      const updated = { ...cv, ...patch };
      // Auto-fill outputKey if it was auto-generated (matches the old auto pattern)
      const oldAuto = autoOutputKey(cv.sourceKey, cv.transform);
      if (!patch.outputKey && cv.outputKey === oldAuto) {
        updated.outputKey = autoOutputKey(updated.sourceKey, updated.transform);
      }
      return updated;
    }));
  }

  const dirty = snapshot !== "" && JSON.stringify({ name, idTipe: Number(idTipe), konsepNd: konsepNd?.name, konsepNp: konsepNp?.name, mapping, customVars }) !== snapshot;
  function handleCancel() {
    if (dirty) setShowDiscard(true);
    else onBack();
  }

  return (
    <div style="padding:12px;display:flex;flex-direction:column;gap:12px">
      <div class="field">
        <label class="field__label">Nama Template <span style="color:var(--error)">*</span></label>
        <input
          class="field__input"
          value={name}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
          placeholder="cth: Template PSP Standar"
        />
      </div>

      <div class="field">
        <label class="field__label">Tipe Pengelolaan <span style="color:var(--error)">*</span></label>
        <select
          class="field__input"
          value={idTipe}
          onChange={(e) => {
            const v = Number((e.target as HTMLSelectElement).value);
            setIdTipe(v);
            setNamaTipe(tipes.find((t) => Number(t.id) === v)?.nama ?? "");
          }}
        >
          <option value={0}>— Pilih tipe —</option>
          {tipes.map((t) => (
            <option key={t.id} value={Number(t.id)}>{t.nama}</option>
          ))}
        </select>
      </div>

      <div class="card">
        <div class="row">
          <span class="row__label">Konsep ND (.docx) <span style="color:var(--error)">*</span></span>
          {konsepNd && (
            <span class="row__value" style="font-size:11px;color:var(--color-primary);display:inline-flex;align-items:center;gap:4px">
              <Icon name="check" size={12} /> {konsepNd.name}
              <button class="btn-icon btn-icon--sm" style="margin-left:2px" onClick={() => setKonsepNd(undefined)} title="Hapus file" aria-label="Hapus file ND"><Icon name="x" size={12} /></button>
            </span>
          )}
        </div>
        <button class="btn btn--ghost btn--sm" style="margin-top:6px" onClick={() => ndFileRef.current?.click()}>
          <Icon name="upload" size={14} /> {konsepNd ? "Ganti" : "Pilih file…"}
        </button>
        <input ref={ndFileRef} type="file" accept=".docx" onChange={handleNdUpload} style="display:none" />
      </div>

      <div class="card">
        <div class="row">
          <span class="row__label">Konsep NP (.docx) <span class="hint">(opsional)</span></span>
          {konsepNp && (
            <span class="row__value" style="font-size:11px;color:var(--color-primary);display:inline-flex;align-items:center;gap:4px">
              <Icon name="check" size={12} /> {konsepNp.name}
              <button class="btn-icon btn-icon--sm" style="margin-left:2px" onClick={() => setKonsepNp(undefined)} title="Hapus file" aria-label="Hapus file NP"><Icon name="x" size={12} /></button>
            </span>
          )}
        </div>
        <button class="btn btn--ghost btn--sm" style="margin-top:6px" onClick={() => npFileRef.current?.click()}>
          <Icon name="upload" size={14} /> {konsepNp ? "Ganti" : "Pilih file…"}
        </button>
        <input ref={npFileRef} type="file" accept=".docx" onChange={handleNpUpload} style="display:none" />
      </div>


{Object.keys(mapping).length > 0 && (
        <div class="card">
          <div style="font-weight:600;font-size:12px;margin-bottom:4px">Pemetaan Placeholder → Variabel SIMAN</div>
          <div style="font-size:10px;color:var(--muted);margin-bottom:8px">
            Ketik nama variabel atau pilih dari daftar. Gunakan "Debug Semua Variabel" saat run untuk melihat semua field API yang tersedia.
          </div>
          <datalist id="siman-vars-list">
            <option value="__ask__" />
            {SIMAN_VARIABLE_KEYS.map((k) => <option key={k} value={k} />)}
            {customVars.filter((cv) => cv.outputKey).map((cv) => (
              <option key={cv.outputKey} value={cv.outputKey} />
            ))}
          </datalist>
          {Object.entries(mapping).map(([ph, varKey]) => (
            <div key={ph} style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
              <code style="flex:0 0 140px;font-size:11px;color:var(--color-primary)">{ph}</code>
              <input
                list="siman-vars-list"
                style="flex:1;font-size:11px;padding:3px 6px;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-sm);color:var(--text-primary)"
                value={varKey}
                placeholder="ketik atau pilih…"
                onInput={(e) => setMapping({ ...mapping, [ph]: (e.target as HTMLInputElement).value })}
              />
            </div>
          ))}
        </div>
      )}

      <div class="card">
        <div style="font-weight:600;font-size:12px;margin-bottom:4px">Variabel Custom</div>
        <div style="font-size:11px;color:var(--muted);margin-bottom:8px">
          Buat variabel baru dari variabel SIMAN yang sudah ada, dengan mengubah formatnya.
        </div>

        {customVars.map((cv, i) => (
          <div key={i} class="sub-card">
            <div style="display:flex;gap:6px;margin-bottom:6px">
              <div style="flex:1">
                <div class="field-mini-label">Variabel sumber</div>
                <input
                  list="siman-vars-list"
                  style="width:100%;font-size:11px;padding:3px 6px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-sm);color:var(--text-primary);box-sizing:border-box"
                  value={cv.sourceKey}
                  placeholder="ketik atau pilih…"
                  onInput={(e) => updateCustomVar(i, { sourceKey: (e.target as HTMLInputElement).value })}
                />
              </div>
              <button
                style="align-self:flex-end;display:inline-flex;align-items:center;justify-content:center;font-size:11px;padding:3px 8px;background:transparent;border:1px solid var(--error);color:var(--error);border-radius:var(--radius-sm);cursor:pointer"
                onClick={() => setCustomVars((prev) => prev.filter((_, idx) => idx !== i))}
                title="Hapus variabel custom" aria-label="Hapus variabel custom"
              ><Icon name="x" size={12} /></button>
            </div>

            <div style="margin-bottom:6px">
              <div class="field-mini-label">Transformasi</div>
              <select
                style="width:100%;font-size:11px;padding:3px 6px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-sm);color:var(--text-primary)"
                value={cv.transform}
                onChange={(e) => updateCustomVar(i, { transform: (e.target as HTMLSelectElement).value })}
              >
                {TRANSFORM_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>

            <div>
              <div class="field-mini-label">Nama variabel hasil</div>
              <input
                style="width:100%;font-size:11px;padding:3px 6px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-sm);color:var(--text-primary);font-family:monospace;box-sizing:border-box"
                value={cv.outputKey}
                placeholder="nama_variabel_baru"
                onInput={(e) => updateCustomVar(i, { outputKey: (e.target as HTMLInputElement).value })}
              />
            </div>
          </div>
        ))}

        <button
          style="font-size:11px;padding:4px 10px;background:var(--surface-2);border:1px solid var(--line);border-radius:var(--radius-sm);cursor:pointer;color:var(--text-primary)"
          onClick={() => {
            const def: CustomVarDef = { sourceKey: "", transform: "TitleCase", outputKey: "" };
            setCustomVars((prev) => [...prev, def]);
          }}
        >+ Tambah Variabel Custom</button>
      </div>

      {error && <p class="error-text" role="alert">{error}</p>}
      <div style="display:flex;gap:8px">
        <button class="btn btn--ghost" onClick={handleCancel} disabled={saving}>Batal</button>
        <button class="btn btn--primary" style="flex:1" onClick={save} disabled={saving}>
          {saving ? "Menyimpan…" : saved ? <><Icon name="check" /> Tersimpan</> : isNew ? "Simpan Template" : "Update Template"}
        </button>
      </div>

      {showDiscard && (
        <div class="modal-overlay" onClick={() => setShowDiscard(false)}>
          <div class="modal" onClick={(e) => e.stopPropagation()}>
            <h2 class="modal__title"><Icon name="alert" /> Buang Perubahan?</h2>
            <p class="modal__sub">Perubahan template belum disimpan.</p>
            <div class="modal__actions">
              <button class="btn btn--ghost" onClick={() => setShowDiscard(false)}>Batal</button>
              <button class="btn btn--danger" onClick={onBack}><Icon name="trash" size={14} /> Buang</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
