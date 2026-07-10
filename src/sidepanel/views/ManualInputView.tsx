/**
 * ManualInputView — Manually input placeholder values and run a single naskah.
 * Alternative to MailMergeView's Excel-based batch flow.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import type { NaskahTemplate, MailMergeProgressMsg, MailMergeRowMsg, PlaceholderConfig, OrgUnit } from "@/shared/types";
import { scanPlaceholders } from "../mailmerge/placeholder-scan";
import { renderDocx, uint8ToBase64 } from "../mailmerge/docx-render";
import { formatPlaceholderValue, getConfigForPlaceholder, placeholderTypeLabel } from "../mailmerge/format-value";
import { Icon } from "../components/Icon";

interface Props {
  templateId: string;
  onBack: () => void;
}

function send<T>(msg: unknown): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

function getPerihal(payload: Record<string, unknown>): string {
  const d = payload.Perihal as string | undefined;
  if (d?.trim()) return d.trim();
  const dn = payload.DataNd as Record<string, unknown> | undefined;
  return (dn?.Perihal as string | undefined)?.trim() || "—";
}

function mergePlaceholders(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])].sort();
}

type Step = "input" | "running" | "done";

export function ManualInputView({ templateId, onBack }: Props) {
  const [template, setTemplate] = useState<NaskahTemplate | null>(null);
  const [step, setStep] = useState<Step>("input");

  const [ndPlaceholders, setNdPlaceholders] = useState<string[]>([]);
  const [npPlaceholders, setNpPlaceholders] = useState<string[]>([]);
  const placeholders = mergePlaceholders(ndPlaceholders, npPlaceholders);

  // Input values (raw, before formatting)
  const [values, setValues] = useState<Record<string, string>>({});
  const [perihalOverride, setPerihalOverride] = useState("");

  // NP penandatangan picker
  const [showNpPicker, setShowNpPicker] = useState(false);
  const [npUnits, setNpUnits] = useState<OrgUnit[] | null>(null);
  const [npUnitsLoading, setNpUnitsLoading] = useState(false);
  const [chosenNpUnit, setChosenNpUnit] = useState<OrgUnit | null>(null);

  // Run
  const [runSteps, setRunSteps] = useState<string[]>([]);
  const [runDone, setRunDone] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runNdId, setRunNdId] = useState<number | null>(null);
  const portRef = useRef<chrome.runtime.Port | null>(null);

  const pengirimParam = template?.payload.PengirimNdParam as Record<string, unknown> | undefined;
  const pengirimData = (pengirimParam?.Pengirim ?? {}) as Record<string, unknown>;
  const eselon = pengirimData.Eselon as number | undefined;
  const needsNpPicker = eselon !== undefined && eselon <= 3 && !template?.notaPengantarData?.Penandatangan;

  async function fetchNpUnits() {
    setNpUnitsLoading(true);
    const kodeOrg = (pengirimData.KodeOrganisasi ?? pengirimData.KodeUnit ?? "") as string;
    const res = await send<{ ok: boolean; data?: OrgUnit[] }>({
      type: "template/units",
      kodeOrganisasi: kodeOrg,
      pengirimEselon: eselon as number,
    });
    setNpUnits(res.ok ? (res.data ?? []) : []);
    setNpUnitsLoading(false);
  }

  useEffect(() => {
    send<{ ok: boolean; data: NaskahTemplate }>({ type: "template/get", id: templateId }).then((r) => {
      if (!r.ok) return;
      const t = r.data;
      setTemplate(t);

      const ndPh = t.konsepFile ? scanPlaceholders(t.konsepFile.base64) : [];
      const npPh = t.konsepNotaFile ? scanPlaceholders(t.konsepNotaFile.base64) : [];
      setNdPlaceholders(ndPh);
      setNpPlaceholders(npPh);

      // Initialize values with defaults from placeholderConfigs
      const initial: Record<string, string> = {};
      const allPh = [...new Set([...ndPh, ...npPh])].sort();
      for (const ph of allPh) {
        const cfg = getConfigForPlaceholder(ph, t.placeholderConfigs);
        initial[ph] = cfg.defaultValue ?? "";
      }
      setValues(initial);
    });
  }, [templateId]);

  function getConfig(name: string): PlaceholderConfig {
    return getConfigForPlaceholder(name, template?.placeholderConfigs);
  }

  function updateValue(name: string, val: string) {
    setValues((prev) => ({ ...prev, [name]: val }));
  }

  function getFormattedValue(name: string): string {
    const cfg = getConfig(name);
    return formatPlaceholderValue(values[name] ?? "", cfg.type, cfg.dateFormat);
  }

  function allRequiredFilled(): boolean {
    for (const ph of placeholders) {
      const cfg = getConfig(ph);
      const required = cfg.required !== false;
      if (required && !(values[ph] ?? "").trim()) return false;
    }
    return true;
  }

  function handleRunClick() {
    if (needsNpPicker) {
      setShowNpPicker(true);
      if (!npUnits) fetchNpUnits();
    } else {
      startRun(null);
    }
  }

  async function startRun(penandatanganUnit: OrgUnit | null) {
    if (!template || !template.konsepFile) return;
    setShowNpPicker(false);
    setStep("running");
    setRunSteps([]);
    setRunDone(false);
    setRunError(null);
    setRunNdId(null);

    // Build formatted data
    const data: Record<string, string> = {};
    for (const ph of placeholders) {
      data[ph] = getFormattedValue(ph);
    }

    const port = chrome.runtime.connect({ name: "mail-merge-run" });
    portRef.current = port;

    port.onMessage.addListener((msg: MailMergeProgressMsg) => {
      if (msg.type === "mm/row-step") {
        setRunSteps((prev) => [...prev, msg.step]);
      } else if (msg.type === "mm/row-done") {
        if (msg.error) setRunError(msg.error);
        if (msg.ndId) setRunNdId(msg.ndId);
      } else if (msg.type === "mm/complete") {
        setRunDone(true);
        if (msg.failed > 0 && !runError) setRunError(`${msg.failed} gagal`);
        if (msg.ndIds.length > 0 && !runNdId) setRunNdId(msg.ndIds[0]);
        port.disconnect();
      }
    });

    port.onDisconnect.addListener(() => {
      setRunDone(true);
    });

    // Send start
    port.postMessage({
      type: "mm/start", templateId: template.id, total: 1,
      ...(penandatanganUnit ? { penandatanganUnit: penandatanganUnit as Record<string, unknown> } : {}),
    } satisfies MailMergeRowMsg);

    // Build payload
    const payload = { ...template.payload };
    const perihal = perihalOverride.trim() || getPerihal(payload);
    payload.Perihal = perihal;

    // Render docx
    const konsepBase64 = template.konsepFile.base64;
    const konsepName = template.konsepFile.name;
    let docxBase64 = konsepBase64;
    try {
      docxBase64 = uint8ToBase64(renderDocx(konsepBase64, data));
    } catch (e) {
      console.error("[asguard] manual ND render failed:", e);
      setRunSteps((prev) => [...prev, `⚠️ Render ND gagal: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`]);
    }

    const filename = konsepName.replace(/\.docx?$/i, "_manual.docx");

    // Render NP if available
    const npBase64 = template.konsepNotaFile?.base64;
    const npName = template.konsepNotaFile?.name;
    let npDocxBase64: string | undefined;
    let npFilename: string | undefined;
    if (npBase64 && npName) {
      npDocxBase64 = npBase64;
      if (npPlaceholders.length > 0) {
        try { npDocxBase64 = uint8ToBase64(renderDocx(npBase64, data)); }
        catch (e) {
          console.error("[asguard] manual NP render failed:", e);
          setRunSteps((prev) => [...prev, `⚠️ Render NP gagal: ${e instanceof Error ? e.message.slice(0, 60) : String(e)}`]);
        }
      }
      npFilename = npName.replace(/\.docx?$/i, "_manual.docx");
    }

    port.postMessage({
      type: "mm/row", index: 0, payload, docxBase64, filename,
      ...(npDocxBase64 ? { npDocxBase64, npFilename } : {}),
    } satisfies MailMergeRowMsg);
  }

  // ─────────────────── Views ───────────────────

  if (!template) return <div class="view-template fade-in"><p class="hint">Memuat template…</p></div>;

  if (!template.konsepFile) {
    return (
      <div class="view-template fade-in">
        <button class="btn btn--ghost btn--sm back-btn" onClick={onBack}><Icon name="chevron-left" size={16} /> Kembali</button>
        <div class="mm-notice">
          <p>Template ini tidak memiliki file konsep (.docx).</p>
          <p class="hint">Upload file konsep di Detail Template terlebih dahulu.</p>
        </div>
      </div>
    );
  }

  // ── Input ──────────────────────────────────────────────
  if (step === "input") {
    return (
      <div class="view-template fade-in">
        <button class="btn btn--ghost btn--sm back-btn" onClick={onBack}><Icon name="chevron-left" size={16} /> Kembali</button>
        <h2 class="section-title"><Icon name="pencil" /> Input Manual</h2>

        <div class="mm-info-card">
          <div class="mm-info-row"><span class="mm-info-label">Template</span><span>{template.name}</span></div>
          <div class="mm-info-row"><span class="mm-info-label">Perihal</span><span class="mm-info-value--muted">{getPerihal(template.payload)}</span></div>
          <div class="mm-info-row"><span class="mm-info-label">File ND</span><span><Icon name="file-text" /> {template.konsepFile.name}</span></div>
          {template.konsepNotaFile && (
            <div class="mm-info-row"><span class="mm-info-label">File NP</span><span><Icon name="file-text" /> {template.konsepNotaFile.name}</span></div>
          )}
        </div>

        {/* Perihal override */}
        <div class="field manual-field">
          <span class="field__label">Perihal <span class="manual-field__type-badge">opsional</span></span>
          <input
            class="field__input"
            type="text"
            placeholder={getPerihal(template.payload)}
            value={perihalOverride}
            onInput={(e) => setPerihalOverride((e.target as HTMLInputElement).value)}
          />
          <span class="manual-field__hint">Kosongkan untuk menggunakan perihal bawaan template</span>
        </div>

        {/* Placeholder inputs */}
        {placeholders.length > 0 ? (
          <div class="manual-form">
            <h3 class="manual-form__title">Isi Placeholder</h3>
            {placeholders.map((ph) => {
              const cfg = getConfig(ph);
              const isNp = npPlaceholders.includes(ph) && !ndPlaceholders.includes(ph);
              const required = cfg.required !== false;
              const formatted = getFormattedValue(ph);
              const raw = values[ph] ?? "";

              return (
                <div key={ph} class="manual-field">
                  <span class="field__label">
                    {cfg.label || ph}
                    {isNp && <span class="mm-ph mm-ph--np" style="margin-left:6px;font-size:10px">NP</span>}
                    {required && <span class="manual-field__required">*</span>}
                    <span class="manual-field__type-badge">{placeholderTypeLabel(cfg.type)}</span>
                  </span>

                  {cfg.type === "date" ? (
                    <input
                      class="field__input"
                      type="date"
                      value={raw}
                      onInput={(e) => updateValue(ph, (e.target as HTMLInputElement).value)}
                    />
                  ) : cfg.type === "number" || cfg.type === "currency" || cfg.type === "terbilang" ? (
                    <input
                      class="field__input"
                      type="number"
                      placeholder={cfg.type === "currency" ? "cth. 1250000" : cfg.type === "terbilang" ? "cth. 1400" : "0"}
                      value={raw}
                      onInput={(e) => updateValue(ph, (e.target as HTMLInputElement).value)}
                    />
                  ) : (
                    <input
                      class="field__input"
                      type="text"
                      placeholder={cfg.defaultValue || `Isi ${cfg.label || ph}…`}
                      value={raw}
                      onInput={(e) => updateValue(ph, (e.target as HTMLInputElement).value)}
                    />
                  )}

                  {/* Show formatted preview for non-text types */}
                  {cfg.type !== "text" && raw.trim() && (
                    <span class="manual-field__preview">→ {formatted}</span>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <p class="hint">Tidak ada placeholder di dokumen — dokumen akan di-upload apa adanya.</p>
        )}

        {/* Preview */}
        {placeholders.length > 0 && Object.values(values).some((v) => v.trim()) && (
          <div class="mm-preview">
            <p class="mm-preview__label">Preview Substitusi</p>
            {placeholders.map((ph) => {
              const formatted = getFormattedValue(ph);
              return (
                <div key={ph} class="mm-preview__row">
                  <span class="mm-preview__col">{`{${ph}}`}</span>
                  <span class="mm-preview__val">{formatted || <em>kosong</em>}</span>
                </div>
              );
            })}
          </div>
        )}

        <div class="mm-run-footer">
          <button
            class="btn btn--primary"
            onClick={handleRunClick}
            disabled={placeholders.length > 0 && !allRequiredFilled()}
          >
            <Icon name="play" /> Jalankan
          </button>
        </div>

        {/* NP penandatangan picker modal */}
        {showNpPicker && (
          <div class="modal-overlay">
            <div class="modal">
              <h2 class="modal__title"><Icon name="memo" /> Pilih Penandatangan NP</h2>
              <p class="modal__sub">Eselon {eselon} → pilih pejabat eselon {(eselon ?? 0) + 1} di bawahnya</p>

              {npUnitsLoading && <p class="modal__hint">Memuat daftar unit…</p>}

              {npUnits && npUnits.length === 0 && (
                <p class="modal__hint" style="color: var(--color-warning)">Tidak ada unit ditemukan.</p>
              )}

              {npUnits && npUnits.length > 0 && (
                <div class="unit-picker">
                  {npUnits.map((u, i) => (
                    <button key={i}
                      class={`unit-picker__item ${chosenNpUnit === u ? "unit-picker__item--active" : ""}`}
                      onClick={() => setChosenNpUnit(u)}>
                      <span class="unit-picker__jabatan">{u.NamaJabatan || "—"}</span>
                      <span class="unit-picker__meta">{u.NamaPejabat || "—"} · Es.{u.Eselon}</span>
                    </button>
                  ))}
                </div>
              )}

              <div class="modal__actions">
                <button class="btn btn--ghost" onClick={() => setShowNpPicker(false)}>Batal</button>
                <button class="btn btn--primary"
                  disabled={!!npUnits && npUnits.length > 0 && !chosenNpUnit}
                  onClick={() => startRun(chosenNpUnit)}>
                  Jalankan
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Running / Done ─────────────────────────────────────
  return (
    <div class="view-template fade-in">
      <button class="btn btn--ghost btn--sm back-btn" onClick={onBack}><Icon name="chevron-left" size={16} /> Kembali</button>
      <h2 class="section-title">
        {runDone ? (runError ? <><Icon name="circle-x" /> Gagal</> : <><Icon name="circle-check" /> Selesai</>) : <><span class="run-spin"><Icon name="loader" /></span> Menjalankan…</>}
      </h2>

      <div class="run-progress">
        {runSteps.map((s, i) => (
          <div key={i} class={`run-step ${i === runSteps.length - 1 && !runDone ? "run-step--active" : "run-step--done"}`}>
            <span class="run-step__icon">{i === runSteps.length - 1 && !runDone ? <Icon name="loader" /> : <Icon name="check" />}</span>
            <span>{s}</span>
          </div>
        ))}
      </div>

      {runDone && !runError && runNdId && (
        <p class="run-progress__success">Naskah berhasil dibuat (ID: {runNdId})</p>
      )}
      {runError && <p class="run-progress__error">{runError}</p>}

      {runDone && (
        <div class="modal__actions" style="margin-top: var(--sp-3)">
          <button class="btn btn--ghost" onClick={onBack}><Icon name="chevron-left" size={16} /> Kembali ke Template</button>
          <button class="btn btn--primary" onClick={() => { setStep("input"); setRunSteps([]); setRunDone(false); setRunError(null); setRunNdId(null); }}>
            <Icon name="pencil" /> Input Lagi
          </button>
        </div>
      )}
    </div>
  );
}
