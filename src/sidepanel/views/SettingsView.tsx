import { useEffect, useState } from "preact/hooks";
import type { ApiResult, LlmSettings } from "@/shared/types";
import { DEFAULT_LLM_SETTINGS } from "@/shared/types";
import { SUMMARY_SYSTEM_PROMPT } from "@/shared/prompts";

function send<T>(msg: unknown): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

interface SettingsViewProps {
  onBack: () => void;
}

export function SettingsView({ onBack }: SettingsViewProps) {
  const [settings, setSettings] = useState<LlmSettings>({ ...DEFAULT_LLM_SETTINGS });
  const [healthStatus, setHealthStatus] = useState<"idle" | "checking" | "ok" | "fail">("idle");
  const [saved, setSaved] = useState(false);
  const [cacheCleared, setCacheCleared] = useState(false);

  useEffect(() => {
    send<ApiResult<LlmSettings>>({ type: "settings/get" }).then((res) => {
      if (res.ok) setSettings(res.data);
    });
  }, []);

  async function handleSave() {
    await send({ type: "settings/set", settings });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function handleTestConnection() {
    setHealthStatus("checking");
    const res = await send<ApiResult<boolean>>({ type: "llm/health" });
    setHealthStatus(res.ok && res.data ? "ok" : "fail");
    setTimeout(() => setHealthStatus("idle"), 3000);
  }

  async function handleClearCache() {
    await send({ type: "cache/clear" });
    setCacheCleared(true);
    setTimeout(() => setCacheCleared(false), 2000);
  }

  return (
    <div class="settings-view fade-in">
      <button class="btn btn--ghost" onClick={onBack}>
        ← Kembali
      </button>

      <section class="card">
        <h2 class="card__title">Pengaturan LLM</h2>

        <label class="field">
          <span class="field__label">URL llama.cpp</span>
          <input
            class="input"
            type="text"
            value={settings.llamaUrl}
            onInput={(e) =>
              setSettings({ ...settings, llamaUrl: (e.target as HTMLInputElement).value })
            }
          />
        </label>

        <label class="field">
          <span class="field__label">Nama Model</span>
          <input
            class="input"
            type="text"
            value={settings.modelName}
            onInput={(e) =>
              setSettings({ ...settings, modelName: (e.target as HTMLInputElement).value })
            }
          />
        </label>

        <label class="field">
          <span class="field__label">Max Tokens (output)</span>
          <input
            class="input"
            type="number"
            min={128}
            max={8192}
            value={settings.maxTokens}
            onInput={(e) =>
              setSettings({
                ...settings,
                maxTokens: parseInt((e.target as HTMLInputElement).value, 10) || 512,
              })
            }
          />
          <span class="field__hint">Token output AI. Lebih kecil = lebih cepat.</span>
        </label>

        <label class="field">
          <span class="field__label">Temperatur</span>
          <input
            class="input"
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={settings.temperature ?? 0.2}
            onInput={(e) =>
              setSettings({
                ...settings,
                temperature: parseFloat((e.target as HTMLInputElement).value) || 0.2,
              })
            }
          />
          <span class="field__hint">Lebih rendah = lebih cepat & konsisten. Default: 0.2</span>
        </label>

        <label class="field">
          <span class="field__label">Maks Halaman PDF</span>
          <input
            class="input"
            type="number"
            min={0}
            max={50}
            step={1}
            value={settings.maxPages ?? 7}
            onInput={(e) =>
              setSettings({
                ...settings,
                maxPages: parseInt((e.target as HTMLInputElement).value, 10) || 7,
              })
            }
          />
          <span class="field__hint">Halaman pertama yang dibaca AI. 0 = semua halaman.</span>
        </label>

        <label class="field">
          <span class="field__label">Batas Teks Input</span>
          <input
            class="input"
            type="number"
            min={0}
            max={20000}
            step={500}
            value={settings.maxInputChars ?? 4000}
            onInput={(e) =>
              setSettings({
                ...settings,
                maxInputChars: parseInt((e.target as HTMLInputElement).value, 10),
              })
            }
          />
          <span class="field__hint">Karakter maks dikirim ke AI. 0 = tanpa batas.</span>
        </label>

        <label class="field">
          <span class="field__label">System Prompt (kosongkan untuk default)</span>
          <textarea
            class="textarea"
            rows={5}
            placeholder={SUMMARY_SYSTEM_PROMPT.slice(0, 200) + "…"}
            value={settings.systemPrompt}
            onInput={(e) =>
              setSettings({ ...settings, systemPrompt: (e.target as HTMLTextAreaElement).value })
            }
          />
        </label>

        <div class="settings-actions">
          <button class="btn" onClick={handleSave}>
            {saved ? "✅ Tersimpan" : "Simpan"}
          </button>
          <button class="btn btn--secondary" onClick={handleTestConnection}>
            {healthStatus === "checking"
              ? "Menguji…"
              : healthStatus === "ok"
                ? "✅ Terhubung"
                : healthStatus === "fail"
                  ? "❌ Gagal"
                  : "Test Koneksi"}
          </button>
        </div>
      </section>

      <section class="card">
        <h2 class="card__title">Cache</h2>
        <p class="hint">Ringkasan yang sudah dibuat disimpan secara lokal.</p>
        <button class="btn btn--secondary" onClick={handleClearCache}>
          {cacheCleared ? "✅ Terhapus" : "Hapus Cache Ringkasan"}
        </button>
      </section>

      <BackupSection />
      <UpdateSection />
    </div>
  );
}

function BackupSection() {
  const [exporting, setExporting] = useState(false);
  const [importStatus, setImportStatus] = useState<"idle" | "done" | "error">("idle");
  const [importMsg, setImportMsg] = useState("");

  async function handleExport() {
    setExporting(true);
    try {
      const res = await (chrome.runtime.sendMessage({ type: "backup/export" }) as Promise<{ ok: boolean; data: Record<string, unknown> }>);
      if (!res.ok) throw new Error("Export failed");
      const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `asguard-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch { /* ignore */ }
    setExporting(false);
  }

  function handleImport() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text) as Record<string, unknown>;
        // Validate: must have at least one known key
        const validKeys = ["asguard.templates", "asguard.simanTemplates", "asguard.llmSettings"];
        const hasValid = validKeys.some((k) => k in data);
        if (!hasValid) { setImportStatus("error"); setImportMsg("File tidak valid"); return; }
        // Only import known keys
        const filtered: Record<string, unknown> = {};
        for (const k of validKeys) { if (k in data) filtered[k] = data[k]; }
        await chrome.runtime.sendMessage({ type: "backup/import", data: filtered });
        setImportStatus("done");
        setImportMsg(`Berhasil: ${Object.keys(filtered).length} data diimpor`);
      } catch {
        setImportStatus("error");
        setImportMsg("Gagal membaca file");
      }
      setTimeout(() => setImportStatus("idle"), 3000);
    };
    input.click();
  }

  return (
    <section class="card">
      <h2 class="card__title">Backup &amp; Restore</h2>
      <p class="hint">Ekspor template &amp; pengaturan ke file JSON. Impor untuk memulihkan.</p>
      <div style="display:flex;gap:8px;margin-top:6px">
        <button class="btn btn--secondary" onClick={handleExport} disabled={exporting}>
          {exporting ? "Mengekspor…" : "⬆ Ekspor"}
        </button>
        <button class="btn btn--secondary" onClick={handleImport}>
          ⬇ Impor
        </button>
      </div>
      {importStatus !== "idle" && (
        <p class="hint" style={`margin-top:6px;color:${importStatus === "done" ? "var(--color-primary)" : "var(--error)"}`}>
          {importStatus === "done" ? "✅" : "❌"} {importMsg}
        </p>
      )}
    </section>
  );
}

function UpdateSection() {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ available: boolean; latestVersion: string; currentVersion: string; downloadUrl: string | null; changelog: string | null } | null>(null);

  async function check() {
    setChecking(true);
    try {
      const r = await (chrome.runtime.sendMessage({ type: "update/check" }) as Promise<typeof result>);
      setResult(r);
    } catch { /* ignore */ }
    setChecking(false);
  }

  return (
    <section class="card">
      <h2 class="card__title">Pembaruan</h2>
      <p class="hint">Versi saat ini: <strong>v{chrome.runtime.getManifest().version}</strong></p>
      <button class="btn btn--secondary" style="margin-top:6px" onClick={check} disabled={checking}>
        {checking ? "Memeriksa…" : "🔄 Cek Pembaruan"}
      </button>

      {result && !result.available && (
        <p class="hint" style="margin-top:6px;color:var(--color-primary)">✅ Sudah versi terbaru</p>
      )}

      {result?.available && (
        <div style="margin-top:8px;padding:10px;background:color-mix(in srgb, #f59e0b 8%, transparent);border:1px solid color-mix(in srgb, #f59e0b 30%, transparent);border-radius:var(--radius-sm)">
          <div style="font-size:12px;font-weight:600;color:#f59e0b">📦 v{result.latestVersion} tersedia</div>
          {result.changelog && <div style="font-size:11px;color:var(--muted);margin-top:4px">{result.changelog}</div>}
          {result.downloadUrl && (
            <button
              class="btn btn--primary"
              style="margin-top:8px;font-size:11px;padding:5px 14px;background:#f59e0b;border-color:#f59e0b"
              onClick={() => chrome.tabs.create({ url: result.downloadUrl! })}
            >
              ⬇ Unduh Update
            </button>
          )}
          <div style="margin-top:10px;padding-top:8px;border-top:1px solid color-mix(in srgb, #f59e0b 20%, transparent)">
            <div style="font-size:11px;font-weight:600;color:var(--text-primary);margin-bottom:4px">Cara Install:</div>
            <ol style="font-size:11px;color:var(--muted);margin:0;padding-left:18px;display:flex;flex-direction:column;gap:3px">
              <li>Unduh file ZIP di atas</li>
              <li>Ekstrak, timpa folder <code>dist/</code> lama</li>
              <li>Buka <code>chrome://extensions</code></li>
              <li>Klik 🔄 pada Asguard untuk reload</li>
            </ol>
            <p class="hint" style="margin-top:6px">💡 Template &amp; pengaturan tidak akan hilang saat update.</p>
          </div>
        </div>
      )}
    </section>
  );
}
