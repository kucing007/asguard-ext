import { useState, useEffect } from "preact/hooks";
import type { PanelSnapshot, SimanRole } from "@/shared/types";

function send<T>(msg: unknown): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

interface Props {
  snap: PanelSnapshot;
  onGoTemplates: () => void;
  onGoDaftar: () => void;
  onGantiRole?: () => void;
}

export function SimanHomeView({ snap, onGoTemplates, onGoDaftar }: Props) {
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
      <div class="user-strip">
        <div class="user-strip__name">{simanToken.fullname || simanToken.nip || "Pengguna SIMAN"}</div>
        <div class="user-strip__role">{simanToken.jabatan}</div>
        <div class="role-badge">
          🏛 {simanToken.role!.namaRoleStruktur || simanToken.role!.nmRole}
          {simanToken.role!.namaUnit && (
            <span style="font-size:10px;opacity:0.7;margin-left:4px">· {simanToken.role!.namaUnit}</span>
          )}
          {simanToken.role!.urKanwil && (
            <span style="font-size:10px;opacity:0.7;margin-left:4px">· {simanToken.role!.urKanwil}</span>
          )}
        </div>
      </div>
      <div class="action-cards" style="padding:12px">
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
