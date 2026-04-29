import type { SimanRole, SimanRoleContext, SimanPenetapan, SimanTipePengelolaan } from "@/shared/siman-types";
import { getSimanToken } from "./siman-store";
import { terbilangRupiah } from "./terbilang";

const SIMAN_BASE = "https://siman-svc.kemenkeu.go.id";

export class SimanHttpError extends Error {
  constructor(public status: number, public path: string, public body: string) {
    super(`SIMAN ${status} ${path}`);
    this.name = "SimanHttpError";
  }
}

export class SimanNoTokenError extends Error {
  constructor() {
    super("Token SIMAN belum tertangkap. Buka/refresh siman.kemenkeu.go.id.");
    this.name = "SimanNoTokenError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { token } = getSimanToken();
  if (!token) throw new SimanNoTokenError();
  const url = `${SIMAN_BASE}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...init?.headers,
      Authorization: `Bearer ${token}`,
      Origin: "https://siman.kemenkeu.go.id",
      Referer: "https://siman.kemenkeu.go.id/",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new SimanHttpError(res.status, path, body);
  }
  return (await res.json()) as T;
}

/** Use the role-scoped token (after set-role) for API calls that require it */
async function requestWithRole<T>(path: string, init?: RequestInit): Promise<T> {
  const state = getSimanToken();
  const token = state.role?.token ?? state.token;
  if (!token) throw new SimanNoTokenError();
  const url = `${SIMAN_BASE}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...init?.headers,
      Authorization: `Bearer ${token}`,
      Origin: "https://siman.kemenkeu.go.id",
      Referer: "https://siman.kemenkeu.go.id/",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new SimanHttpError(res.status, path, body);
  }
  return (await res.json()) as T;
}

/** Decode user info from JWT payload (base64url middle segment) */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const part = token.split(".")[1];
    const padded = part + "=".repeat((4 - (part.length % 4)) % 4);
    return JSON.parse(atob(padded.replace(/-/g, "+").replace(/_/g, "/")));
  } catch { return {}; }
}

export async function getRoles(userId: string): Promise<SimanRole[]> {
  // Match exactly what the browser sends (from Python CLI)
  const body = {
    id_user: userId,
    id_role: 0,
    id_struktur: 0,
    nama_unit: "",
    status_aktif: "true",
    limit: 100,
    offset: 0,
  };
  const res = await request<{ data?: unknown[] }>(
    `/smaset/api/get-list-role-active-new/${userId}/0/0`,
    { method: "POST", body: JSON.stringify(body) },
  );
  return (res.data ?? []) as SimanRole[];
}

export async function getRoleFilter(idUserDetail: string): Promise<Record<string, unknown>[]> {
  // Python CLI uses POST with NO body (json=None in httpx = no body sent)
  const res = await request<{ data?: unknown[] }>(`/smaset/api/user-detail-filter/${idUserDetail}`, {
    method: "POST",
    // deliberately no body — matching Python CLI which sends json=None
  });
  // Returns { data: [...array of filter objects] }
  return (res.data ?? []) as Record<string, unknown>[];
}

export async function setRole(
  role: SimanRole,
  filterData: Record<string, unknown>[],
  userlogin: string,
): Promise<{ token: string; context: SimanRoleContext }> {
  // Match the Python CLI payload format
  const payload = {
    id_role_struktur: role.id_role_struktur ?? role.id_role,
    filter_data: JSON.stringify(filterData),
    userlogin,
    id_user: role.id_user,
    id_role: role.id_role,
    id_struktur: role.id_struktur,
    id_user_detail_new: role.id_user_detail,
  };
  const res = await request<{ status?: boolean; tokens?: Record<string, unknown>; token?: string }>(
    "/swkf/auth/v1/jwt-roles",
    { method: "POST", body: JSON.stringify(payload) },
  );
  const newToken = String(res.tokens?.access_token ?? res.token ?? "");
  if (!newToken) throw new SimanHttpError(200, "/swkf/auth/v1/jwt-roles", "No token in response");
  // Prefer kpknl/kanwil from the role object itself, fallback to filter data
  const fd = Array.isArray(filterData) ? filterData[0] ?? {} : filterData;
  const context: SimanRoleContext = {
    idUserDetail: String(role.id_user_detail ?? fd.id_user_detail ?? ""),
    idUser: String(role.id_user ?? fd.id_user ?? ""),
    idRole: String(role.id_role),
    nmRole: role.nm_role,
    namaRoleStruktur: String(role.nama_role_struktur ?? role.nm_role ?? ""),
    idKpknl: String(role.id_kpknl ?? fd.id_kpknl ?? "0"),
    nmKpknl: String(role.nm_kpknl ?? role.nama_unit ?? ""),
    namaUnit: String(role.nama_unit ?? ""),
    idKanwil: String(role.id_kanwil ?? fd.id_kanwil ?? "0"),
    nmKanwil: String(role.nm_kanwil ?? role.ur_kanwil ?? ""),
    urKanwil: String(role.ur_kanwil ?? ""),
    idStruktur: String(role.id_struktur ?? "9"),
    token: newToken,
  };
  return { token: newToken, context };
}

export async function getTipePengelolaan(): Promise<SimanTipePengelolaan[]> {
  const res = await requestWithRole<{ data?: unknown[] }>(
    "/skel/api/referensi-pengelolaan/tipe-pengelolaan/get-all",
  );
  const raw = (res.data ?? []) as Record<string, unknown>[];
  // API returns {id_tipe_pengelolaan, nama_tipe_pengelolaan, ...}
  return raw.map((r) => ({
    id: String(r.id_tipe_pengelolaan ?? r.id ?? ""),
    nama: String(r.nama_tipe_pengelolaan ?? r.nama ?? ""),
  }));
}

export async function getPenetapanList(
  role: SimanRoleContext,
  limit: number,
  offset: number,
  statusFilter?: string,
  idTipe?: string,
  capturedBody?: Record<string, unknown>,
): Promise<{ data: SimanPenetapan[]; total: number }> {
  let body: Record<string, unknown>;

  if (capturedBody) {
    // Use SIMAN's own captured body — it has the exact kpknl, id_role, id_struktur values
    // Just override limit, offset, and any filters we want to apply
    body = { ...capturedBody, limit, offset };
    if (idTipe) body.id_tipe_pengelolaan = Number(idTipe);
    if (statusFilter) {
      body.filter_type_mn_dash = statusFilter;
    } else {
      delete body.filter_type_mn_dash;
    }
    console.log("[asguard] using captured body, filter_id:", body.filter_id, "id_role:", body.id_role);
  } else {
    // Fallback: build body from role context (Python CLI format)
    body = {
      order: "tgl_created DESC",
      filter_obj: {},
      filter_type_mn_dash: statusFilter ?? "",
      tahun_anggaran: "0",
      id_struktur_termohon: Number(role.idStruktur) || 9,
      id_status: 0,
      id_jns_pengelolaan: 0,
      id_tipe_pengelolaan: idTipe ? Number(idTipe) : 0,
      filter_fil: "id_kpknl",
      filter_id: Number(role.idKpknl) || 0,
      id_login: role.idUser || role.idUserDetail,
      id_role: Number(role.idRole) || 1,
      column_filter: "",
      value_filter: "",
      pemohon: 0,
      termohon: 0,
      limit,
      offset,
    };
    console.log("[asguard] using fallback body, filter_id:", body.filter_id);
  }

  const res = await requestWithRole<{ data?: unknown[]; count?: number; total?: number }>(
    `/skel/api/pengelolaan/penetapan-pengelolaan/get-data/${limit}/${offset}`,
    { method: "POST", body: JSON.stringify(body) },
  );
  const raw = (res.data ?? []) as Record<string, unknown>[];
  const data: SimanPenetapan[] = raw.map((r) => ({
    idPengelolaan: String(r.id_pengelolaan ?? ""),
    idTipePengelolaan: String(r.id_tipe_pengelolaan ?? ""),
    noTiket: String(r.no_tiket ?? ""),
    tipe: String(r.nama_tipe_pengelolaan ?? r.tipe ?? ""),
    satker: String(r.ur_satker ?? r.kd_satker ?? ""),
    status: String(r.status ?? r.deskripsi ?? ""),
    durasi: r.durasi_penetapan ? String(r.durasi_penetapan) : undefined,
  }));
  return { data, total: res.count ?? res.total ?? data.length };
}

export async function getPermohonanDetail(idPengelolaan: string): Promise<Record<string, unknown>> {
  // Python CLI sends { id_pengelolaan } — NOT { no_tiket } despite endpoint name
  const res = await requestWithRole<{ data?: unknown[] | unknown }>(
    "/skel/api/pengelolaan/permohonan-pengelolaan-detail/by-no-tiket",
    { method: "POST", body: JSON.stringify({ id_pengelolaan: idPengelolaan }) },
  );
  // data is an array — take first item
  const arr = Array.isArray(res.data) ? res.data : (res.data ? [res.data] : []);
  return (arr[0] ?? {}) as Record<string, unknown>;
}

export async function getDaftarAset(
  _role: SimanRoleContext,
  idPengelolaan: string,
  idTipe: string,
  limit = 100,
): Promise<{ data: Record<string, unknown>[]; total: number }> {
  // Python CLI: { penghapusan_setuju: null, id_tipe_pengelolaan: int, id_pengelolaan: str }
  const res = await requestWithRole<{ data?: unknown[]; count?: number; total?: number }>(
    `/skel/api/pengelolaan/permohonan-pengelolaan-detail/get-aset-by-no-tiket/${limit}/0`,
    { method: "POST", body: JSON.stringify({
      penghapusan_setuju: null,
      id_tipe_pengelolaan: Number(idTipe) || 0,
      id_pengelolaan: idPengelolaan,
    }) },
  );
  return { data: (res.data ?? []) as Record<string, unknown>[], total: res.count ?? res.total ?? 0 };
}

export async function getSkByTiket(
  idPengelolaan: string,
  limit = 10,
): Promise<Record<string, unknown>[]> {
  const res = await requestWithRole<{ data?: unknown[] }>(
    `/skel/api/pengelolaan/surat-keputusan/get-sk-by-no-tiket/${idPengelolaan}/${limit}/0`,
    { method: "POST", body: JSON.stringify({}) },
  );
  return (res.data ?? []) as Record<string, unknown>[];
}

export async function getKelengkapanDokumen(
  idPengelolaan: string,
  limit = 20,
): Promise<Record<string, unknown>[]> {
  const res = await requestWithRole<{ data?: unknown[] }>(
    `/skel/api/pengelolaan/kelengkapan-dokumen-per-tiket/${idPengelolaan}/${limit}/0`,
    { method: "POST", body: JSON.stringify({}) },
  );
  return (res.data ?? []) as Record<string, unknown>[];
}

// --- Formatting helpers (mirrors CLI pengelolaan.py) ---

function titleCase(s: string): string {
  if (!s) return "";
  return s.split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

function formatNumber(n: number): string {
  return Math.round(n).toLocaleString("id-ID");
}

function formatDateFormal(dateStr: string): string {
  if (!dateStr) return "";
  const bulan = ["Januari","Februari","Maret","April","Mei","Juni","Juli","Agustus","September","Oktober","November","Desember"];
  const raw = dateStr.slice(0, 10);
  let d: Date | null = null;
  for (const sep of ["-", "/"]) {
    const parts = raw.split(sep);
    if (parts.length === 3) {
      const [a, b, c] = parts.map(Number);
      d = a > 31 ? new Date(a, b - 1, c) : new Date(c, b - 1, a);
      if (!isNaN(d.getTime())) break;
      d = null;
    }
  }
  if (!d) return dateStr;
  return `${d.getDate()} ${bulan[d.getMonth()]} ${d.getFullYear()}`;
}

function addRiSuffixUpper(s: string): string {
  if (!s) return "";
  const u = s.trim().toUpperCase();
  if (u.endsWith("REPUBLIK INDONESIA") || u.endsWith(" RI")) return s.trim();
  return `${s.trim()} REPUBLIK INDONESIA`;
}

function addRiSuffixTitle(s: string): string {
  if (!s) return "";
  const u = s.trim().toUpperCase();
  if (u.endsWith("REPUBLIK INDONESIA") || u.endsWith(" RI")) return titleCase(s.trim());
  return `${titleCase(s.trim())} Republik Indonesia`;
}

function getStrField(obj: Record<string, unknown>, key: string): string {
  const val = obj[key];
  if (val && typeof val === "object" && "String" in (val as Record<string, unknown>)) {
    const v = val as { String: string; Valid: boolean };
    return v.Valid ? v.String : "";
  }
  return val ? String(val) : "";
}

export async function getSatkerDetail(
  idSatker: string,
  idKpknl: string,
): Promise<Record<string, unknown>> {
  const endpoint = `/smaset/api/pengaturan-referensi-pengguna-barang/satker/by-pengelola/9999999/0/0/${idKpknl}`;
  try {
    const res = await requestWithRole<{ data?: unknown[] }>(endpoint, { method: "POST" });
    const data = (res.data ?? []) as Record<string, unknown>[];
    const found = data.find((s) => String(s.id_satker ?? "") === String(idSatker));
    if (found) return found;
    // Retry without kpknl filter
    const res2 = await requestWithRole<{ data?: unknown[] }>(
      `/smaset/api/pengaturan-referensi-pengguna-barang/satker/by-pengelola/9999999/0/0/0`,
      { method: "POST" },
    );
    return (res2.data ?? []).find((s) => String((s as Record<string,unknown>).id_satker ?? "") === String(idSatker)) as Record<string, unknown> ?? {};
  } catch {
    return {};
  }
}

/** Build the full variable map for a penetapan */
export async function buildVariableMap(
  role: SimanRoleContext,
  idPengelolaan: string,
  idTipePengelolaan: string,
): Promise<Record<string, string>> {
  const results = await Promise.allSettled([
    getPermohonanDetail(idPengelolaan),
    getDaftarAset(role, idPengelolaan, idTipePengelolaan),
    getSkByTiket(idPengelolaan),
    getKelengkapanDokumen(idPengelolaan),
  ]);

  const detail = results[0].status === "fulfilled" ? results[0].value : {};
  const asetResult = results[1].status === "fulfilled" ? results[1].value : { data: [], total: 0 };
  const skList = results[2].status === "fulfilled" ? results[2].value : [];
  const dokList = results[3].status === "fulfilled" ? results[3].value : [];

  const vars: Record<string, string> = {};

  // 1. Detail Permohonan — first expose ALL flat fields from the API response
  for (const [k, v] of Object.entries(detail)) {
    if (v !== null && v !== undefined && typeof v !== "object") {
      vars[k] = String(v);
    }
  }
  // Then overlay derived/formatted versions (may overwrite raw with cleaned value)
  for (const key of ["no_tiket","kd_satker","ur_satker","nm_jns_bmn","pemohon","ur_kl",
    "nama_tipe_pengelolaan","nama_jenis_pengelolaan","termohon","deskripsi","durasi_penetapan","id_satker"]) {
    vars[key] = String(detail[key] ?? "");
  }
  vars.ur_satker_title = titleCase(vars.ur_satker);
  vars.pemohon_title = titleCase(vars.pemohon);
  vars.ur_kl = addRiSuffixUpper(vars.ur_kl);
  vars.ur_kl_title = addRiSuffixTitle(String(detail.ur_kl ?? ""));

  // 2. Satker reference (address etc.) — raced against 2s timeout; large API call
  if (vars.id_satker) {
    const satker = await Promise.race([
      getSatkerDetail(vars.id_satker, role.idKpknl),
      new Promise<Record<string, unknown>>((resolve) => setTimeout(() => resolve({}), 2000)),
    ]).catch(() => ({} as Record<string, unknown>));
    if (Object.keys(satker).length > 0) {
      vars.alamat_satker = getStrField(satker, "alamat") || String(satker.alamat ?? "");
      vars.nm_kab_kota = getStrField(satker, "nm_kab_kota") || String(satker.nm_kab_kota ?? "");
      vars.email_kantor = getStrField(satker, "email_kantor") || String(satker.email_kantor ?? "");
      vars.no_telp_kantor = getStrField(satker, "no_telp_kantor") || String(satker.no_telp_kantor ?? "");
      vars.ur_eselon1 = String(satker.ur_eselon1 ?? "");
      vars.ur_kel = getStrField(satker, "ur_kel") || String(satker.ur_kel ?? "");
      vars.ur_kec = getStrField(satker, "ur_kec") || String(satker.ur_kec ?? "");
      vars.ur_prov = getStrField(satker, "ur_prov") || String(satker.ur_prov ?? "");
      const alamatParts = [vars.alamat_satker, vars.ur_kel, vars.ur_kec, vars.nm_kab_kota, vars.ur_prov].filter(Boolean);
      vars.alamat_lengkap = alamatParts.join(", ");
      vars.alamat_lengkap_title = titleCase(vars.alamat_lengkap);
    }
  }

  // 3. Aset kalkulasi
  const aset = asetResult.data;
  vars.jumlah_aset = String(aset.length);
  const sumPermohonan = aset.reduce((s, a) => s + (Number(a.nilai_permohonan) || 0), 0);
  const sumBuku = aset.reduce((s, a) => s + (Number(a.nilai_buku) || 0), 0);
  const sumPerolehan = aset.reduce((s, a) => s + (Number(a.nilai_perolehan) || 0), 0);
  const sumPersetujuan = aset.reduce((s, a) => s + (Number(a.nilai_persetujuan) || 0), 0);
  const sumProporsional = aset.reduce((s, a) => s + (Number(a.nilai_perolehan_proporsional) || 0), 0);
  const sumSewa = aset.reduce((s, a) =>
    s + (Number(a.nilai_sewa_setuju_tahun) || 0) +
    (Number(a.nilai_sewa_setuju_bulan) || 0) * 12 +
    (Number(a.nilai_sewa_setuju_hari) || 0) * 365 / 12 +
    (Number(a.nilai_sewa_setuju_jam) || 0), 0);
  vars.sum_total_permohonan = String(sumPermohonan);
  vars.sum_total_buku = String(sumBuku);
  vars.sum_total_perolehan = String(sumPerolehan);
  vars.sum_nilai_persetujuan = String(sumPersetujuan);
  vars.sum_nilai_perolehan_proporsional = String(sumProporsional);
  vars.nilai_persetujuan_sewa = String(sumSewa);
  vars.sum_total_permohonan_fmt = formatNumber(sumPermohonan);
  vars.sum_total_buku_fmt = formatNumber(sumBuku);
  vars.sum_total_perolehan_fmt = formatNumber(sumPerolehan);
  vars.sum_nilai_persetujuan_fmt = formatNumber(sumPersetujuan);
  vars.sum_nilai_perolehan_proporsional_fmt = formatNumber(sumProporsional);
  vars.nilai_persetujuan_sewa_fmt = formatNumber(sumSewa);
  vars.pembilang_total_permohonan = terbilangRupiah(sumPermohonan);
  vars.pembilang_total_buku = terbilangRupiah(sumBuku);
  vars.pembilang_total_perolehan = terbilangRupiah(sumPerolehan);
  vars.pembilang_nilai_persetujuan = terbilangRupiah(sumPersetujuan);
  vars.pembilang_nilai_perolehan_proporsional = terbilangRupiah(sumProporsional);
  vars.pembilang_nilai_sewa = terbilangRupiah(sumSewa);

  // 4. SK Data
  if (skList.length > 0) {
    const sk = skList[0];
    // Expose all flat SK fields with sk_ prefix so they don't collide with detail fields
    for (const [k, v] of Object.entries(sk)) {
      if (v !== null && v !== undefined && typeof v !== "object") {
        vars[`sk_${k}`] = String(v);
      }
    }
    // Also expose the important ones under their canonical names
    for (const key of ["no_surat","tgl_surat","id_nadine","nama_penandatangan_sk","jabatan_penandatangan_sk"]) {
      vars[key] = String(sk[key] ?? "");
    }
    // API returns `perihal` field; we expose it as perihal_sk
    vars.perihal_sk = String(sk.perihal ?? sk.perihal_sk ?? "");
    vars.tgl_surat_formal = formatDateFormal(vars.tgl_surat);
    vars.perihal_sk_title = titleCase(vars.perihal_sk);
  }

  // 5. Kelengkapan Dokumen
  const ba = dokList.find((d) => String(d.nm_dok ?? "").toLowerCase().includes("berita acara"));
  if (ba) {
    vars.nm_dok_ba = String(ba.nm_dok ?? "");
    vars.no_dok_ba = String(ba.no_dok ?? "");
    vars.tgl_dokumen_ba = String(ba.tgl_dokumen ?? "");
  }
  if (vars.no_surat) {
    const suratDok = dokList.find((d) => d.no_dok === vars.no_surat);
    if (suratDok) {
      vars.perihal_surat = String(suratDok.perihal ?? "");
      vars.perihal_surat_title = titleCase(vars.perihal_surat);
    }
  }

  return vars;
}
