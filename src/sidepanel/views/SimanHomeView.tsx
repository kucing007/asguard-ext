import { useState, useEffect } from "preact/hooks";
import type { PanelSnapshot, SimanRole } from "@/shared/types";

function send<T>(msg: unknown): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

interface Props {
  snap: PanelSnapshot;
  onGoTemplates: () => void;
  onGoDaftar: () => void;
  onGoEvaluasi: () => void;
  onGantiRole?: () => void;
}

export function SimanHomeView({ snap, onGoTemplates, onGoDaftar, onGoEvaluasi }: Props) {
  const { simanToken } = snap;
  const hasToken = !!simanToken.token;
  const hasRole = !!simanToken.role;

  if (!hasToken) {
    return (
      <section class="card card--warn fade-in" style="margin:12px">
        <div class="row">
          <span class="row__label">Sesi SIMAN</span>
          <span class="row__value"><span class="dot dot--warn" /> menunggu</span>
        </div>
        <p class="hint">
          Buka/refresh <code>siman.kemenkeu.go.id</code> — token tertangkap otomatis.
        </p>
      </section>
    );
  }

  if (!hasRole) {
    return <RolePicker />;
  }

  return (
    <div>
      <div class="card" style="margin:12px;padding:12px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <div style="width:36px;height:36px;border-radius:50%;background:color-mix(in srgb, var(--siman-accent) 15%, transparent);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">🏛</div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:13px;color:var(--text-primary)">{simanToken.fullname || simanToken.nip || "Pengguna SIMAN"}</div>
            {simanToken.jabatan && <div style="font-size:11px;color:var(--muted);margin-top:1px">{simanToken.jabatan}</div>}
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;padding:8px;background:var(--surface-2);border-radius:var(--radius-sm)">
          <div style="display:flex;align-items:center;gap:6px">
            <span style="font-size:10px;color:var(--muted);width:44px;flex-shrink:0">Role</span>
            <span style="font-size:12px;font-weight:600;color:var(--siman-accent)">{simanToken.role!.namaRoleStruktur || simanToken.role!.nmRole}</span>
          </div>
          {simanToken.role!.nmKpknl && (
            <div style="display:flex;align-items:center;gap:6px">
              <span style="font-size:10px;color:var(--muted);width:44px;flex-shrink:0">KPKNL</span>
              <span style="font-size:12px;color:var(--text-primary)">{simanToken.role!.nmKpknl}</span>
            </div>
          )}
          {(simanToken.role!.urKanwil || simanToken.role!.nmKanwil) && (
            <div style="display:flex;align-items:center;gap:6px">
              <span style="font-size:10px;color:var(--muted);width:44px;flex-shrink:0">Kanwil</span>
              <span style="font-size:12px;color:var(--text-primary)">{simanToken.role!.urKanwil || simanToken.role!.nmKanwil}</span>
            </div>
          )}
        </div>
      </div>
      <div class="action-cards" style="padding:0 12px 12px">
        <button class="action-card" onClick={onGoTemplates}>
          <div class="action-card__icon">📋</div>
          <div class="action-card__body">
            <div class="action-card__label">Template Pengelolaan</div>
            <div class="action-card__desc">Kelola template dokumen pengelolaan BMN</div>
          </div>
          <span class="action-card__arrow">›</span>
        </button>
        <button class="action-card" onClick={onGoDaftar}>
          <div class="action-card__icon">📜</div>
          <div class="action-card__body">
            <div class="action-card__label">Daftar Pengelolaan</div>
            <div class="action-card__desc">Lihat penetapan &amp; buat naskah otomatis</div>
          </div>
          <span class="action-card__arrow">›</span>
        </button>
        <button class="action-card" onClick={onGoEvaluasi}>
          <div class="action-card__icon">📈</div>
          <div class="action-card__body">
            <div class="action-card__label">Evaluasi Kinerja BMN</div>
            <div class="action-card__desc">Evaluasi &amp; automasi scorecard aset</div>
          </div>
          <span class="action-card__arrow">›</span>
        </button>
      </div>
    </div>
  );
}

function RolePicker() {
  const [roles, setRoles] = useState<SimanRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    send<{ ok: boolean; data?: SimanRole[]; error?: string }>({ type: "siman/get-roles" })
      .then((r) => { if (r.ok) setRoles(r.data ?? []); else setError(r.error ?? "Error"); })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  async function pickRole(role: SimanRole) {
    setPicking(true);
    try {
      await send({ type: "siman/set-role", role, idKpknl: "", idKanwil: "" });
    } catch (e) {
      setError(String(e));
    } finally {
      setPicking(false);
    }
  }

  if (loading || picking) return <p class="hint" style="padding:12px">Memuat daftar role…</p>;
  if (error) return <p class="hint" style="padding:12px;color:var(--error)">{error}</p>;

  return (
    <section class="card fade-in" style="margin:12px">
      <p class="hint" style="margin-bottom:8px">Pilih role SIMAN:</p>
      {roles.map((r) => (
        <button
          key={r.id_role}
          class="btn btn--ghost"
          style="width:100%;margin-bottom:6px;text-align:left"
          onClick={() => pickRole(r)}
        >
          <strong>{r.nama_role_struktur || r.nm_role}</strong><br />
          <small style="color:var(--muted)">
            {r.nama_unit || r.nm_kpknl}
            {(r.ur_kanwil) && <> · {r.ur_kanwil}</>}
          </small>
        </button>
      ))}
    </section>
  );
}
