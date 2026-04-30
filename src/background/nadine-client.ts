import { getToken, clearToken } from "./token-store";

const NADINE_BASE = "https://service.kemenkeu.go.id/nadine-nanas";

export class NadineHttpError extends Error {
  constructor(
    public status: number,
    public path: string,
    public body: string,
  ) {
    super(`Nadine ${status} ${path}`);
    this.name = "NadineHttpError";
  }
}

export class NadineNoTokenError extends Error {
  constructor() {
    super("Token Nadine belum tertangkap. Buka/refresh satu.kemenkeu.go.id.");
    this.name = "NadineNoTokenError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { token } = getToken();
  if (!token) throw new NadineNoTokenError();

  const url = path.startsWith("http") ? path : `${NADINE_BASE}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      ...init?.headers,
      Authorization: `Bearer ${token}`,
    },
  });

  if (res.status === 401 || res.status === 403) {
    await clearToken();
    const body = await res.text().catch(() => "");
    throw new NadineHttpError(res.status, path, body);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new NadineHttpError(res.status, path, body);
  }

  return (await res.json()) as T;
}

export interface MejaKuCounts {
  Amplop?: number;
  Disposisi?: number;
  Konsep?: number;
  [k: string]: unknown;
}

export interface MejaKuCountsResponse {
  Data?: MejaKuCounts;
  Success?: boolean;
  [k: string]: unknown;
}

export function getCounts(): Promise<MejaKuCountsResponse> {
  return request<MejaKuCountsResponse>("/mejaku/counts/mejaku");
}

export interface NaskahDetailResponse {
  Data?: unknown;
  Success?: boolean;
  [k: string]: unknown;
}

export function getNaskahDetail(ndId: string | number, tipedata = "AmplopDisposisi"): Promise<NaskahDetailResponse> {
  const enc = encodeURIComponent(String(ndId));
  return request<NaskahDetailResponse>(
    `/gateway/grid/konsepnaskah/DetailKonsepByNdId/${enc}?tipedata=${encodeURIComponent(tipedata)}`,
  );
}

export interface LampiranResponse {
  Data?: {
    Lampiran?: Array<{ Id?: number; NamaFile?: string; DownloadPath?: string; [k: string]: unknown }>;
    DataDukung?: unknown[];
  };
  Success?: boolean;
  [k: string]: unknown;
}

export function getAttachments(ndId: string | number): Promise<LampiranResponse> {
  const enc = encodeURIComponent(String(ndId));
  return request<LampiranResponse>(`/gateway/grid/konsepnaskah/LampiranDataDukung/${enc}`);
}

/**
 * Download a file (PDF) from Nadine as ArrayBuffer.
 * Handles both relative paths (PathKonsep) and full URLs (lampiran DownloadPath).
 */
export async function downloadFile(pathOrUrl: string): Promise<ArrayBuffer> {
  const { token } = getToken();
  if (!token) throw new NadineNoTokenError();

  // If it's already a full URL, use it directly; otherwise prepend NADINE_BASE
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `${NADINE_BASE}/${pathOrUrl.replace(/^\/+/, "")}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 401 || res.status === 403) {
    await clearToken();
    throw new NadineHttpError(res.status, pathOrUrl, "");
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new NadineHttpError(res.status, pathOrUrl, body);
  }

  return res.arrayBuffer();
}

// --- Phase 2: Naskah Creation APIs ---

export interface CreateNaskahResult {
  Data?: {
    KonsepNaskah?: {
      Id?: string;
      DataNd?: { NdId?: number; [k: string]: unknown };
      [k: string]: unknown;
    };
    [k: string]: unknown;
  };
  Success?: boolean;
  Error?: string;
  Message?: string;
  [k: string]: unknown;
}

/** Create a new Naskah Dinas from a template payload */
export function createNaskah(payload: Record<string, unknown>): Promise<CreateNaskahResult> {
  return request<CreateNaskahResult>("/konsepnaskah", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/** Get naskah detail for edit link generation */
export function getNaskahDetailForEdit(ndId: number): Promise<NaskahDetailResponse> {
  return request<NaskahDetailResponse>(
    `/gateway/grid/konsepnaskah/DetailKonsepByNdId/${ndId}?tipedata=KonsepNaskah`,
  );
}

/** Generate an edit link (prepare document for editing/upload) */
export function generateEditLink(
  ndId: number,
  docId: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>(
    `/gateway/file/ndid/${ndId}/upload/konsepnaskah/GenerateLinkKonsep/${docId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

/** Sync/preview naskah dinas document — GET /gateway/stream/ndid/{ndId}/SyncDocKonsep/{docId} */
export async function syncDocKonsep(ndId: number, docId: string): Promise<void> {
  const { token } = getToken();
  if (!token) throw new NadineNoTokenError();

  const url = `${NADINE_BASE}/gateway/stream/ndid/${ndId}/upload/konsepnaskah/SyncDocKonsep/${docId}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 401 || res.status === 403) {
    await clearToken();
    throw new NadineHttpError(res.status, `SyncDocKonsep/${ndId}/${docId}`, "");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new NadineHttpError(res.status, `SyncDocKonsep/${ndId}/${docId}`, body);
  }
  // Response is binary — just drain it to confirm success
  await res.arrayBuffer().catch(() => {});
}

/**
 * Upload a konsep file (.docx) to a naskah dinas.
 * Uses multipart/form-data with field name "file".
 */
export async function uploadKonsepFile(
  ndId: number,
  fileName: string,
  fileBytes: Uint8Array,
): Promise<Record<string, unknown>> {
  const { token } = getToken();
  if (!token) throw new NadineNoTokenError();

  const url = `${NADINE_BASE}/konsepnaskah/UploadFileKonsep/${ndId}`;
  const formData = new FormData();
  const blob = new Blob([fileBytes.buffer as ArrayBuffer], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  formData.append("file", blob, fileName);

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });

  if (res.status === 401 || res.status === 403) {
    await clearToken();
    throw new NadineHttpError(res.status, `UploadFileKonsep/${ndId}`, "");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new NadineHttpError(res.status, `UploadFileKonsep/${ndId}`, body);
  }
  return (await res.json()) as Record<string, unknown>;
}

// --- Nota Pengantar APIs ---

/** GET /Auth/me — returns current user info including CurrentUnit.KodeOrganisasi */
export function getAuthMe(): Promise<{ Data?: { CurrentUnit?: { KodeOrganisasi?: string; Eselon?: number; [k: string]: unknown }; AllUnits?: Record<string, unknown>[]; [k: string]: unknown }; [k: string]: unknown }> {
  return request("/Auth/me");
}

/** PATCH /Auth/UpdateRole — switch active Nadine role */
export function switchRole(unitData: Record<string, unknown>): Promise<unknown> {
  return request("/Auth/UpdateRole", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(unitData),
  });
}

/**
 * Get org unit tree for a given kode organisasi.
 * Use the KodeOrganisasi from /Auth/me → Data.CurrentUnit, NOT from the pengirim payload.
 */
export function getRefUnitsTree(kodeOrganisasi: string): Promise<{ Data?: Record<string, unknown>[] }> {
  return request(`/gateway/general/Common/RefUnits/TreeInduk/${kodeOrganisasi}`);
}

/** Create nota pengantar for a naskah */
export function createNotaPengantar(
  ndId: number,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>(`/notapengantar/${ndId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/** Get nota pengantar for a naskah */
export function getNotaPengantar(ndId: number): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>(`/gateway/grid/notapengantar/${ndId}`);
}

/** Upload nota pengantar file */
export async function uploadNotaPengantarFile(
  ndId: number,
  npId: string,
  fileName: string,
  fileBytes: Uint8Array,
): Promise<Record<string, unknown>> {
  const { token } = getToken();
  if (!token) throw new NadineNoTokenError();

  const url = `${NADINE_BASE}/notapengantar/UploadFileNp/${ndId}/${npId}`;
  const formData = new FormData();
  const blob = new Blob([fileBytes.buffer as ArrayBuffer], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  formData.append("file", blob, fileName);

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });

  if (res.status === 401 || res.status === 403) {
    await clearToken();
    throw new NadineHttpError(res.status, `UploadFileNotaPengantar/${ndId}/${npId}`, "");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new NadineHttpError(res.status, `UploadFileNotaPengantar/${ndId}/${npId}`, body);
  }
  return (await res.json()) as Record<string, unknown>;
}

// --- E-Arsip / Arsiparis APIs ---

interface ArsipListResponse { Data?: unknown[]; [k: string]: unknown }
interface ArsipMutateResponse { Success?: boolean; Message?: string; Error?: string; [k: string]: unknown }

function arsipParams(params: { limit?: number; startDate?: string; endDate?: string; perihal?: string }): URLSearchParams {
  return new URLSearchParams({
    limit: String(params.limit ?? 200),
    offset: "0",
    general: "",
    startDate: params.startDate ?? "",
    endDate: params.endDate ?? "",
    kodeOrganisasi: "",
    perihal: params.perihal ?? "",
    noNd: "",
    unitPengirim: "",
    ndId: "",
  });
}

export function getArsipUnitUnarchived(params: { limit?: number; startDate?: string; endDate?: string; perihal?: string }): Promise<ArsipListResponse> {
  return request<ArsipListResponse>(`/Gateway/grid/mejaku/arsip-unit/unarchived?${arsipParams(params)}`);
}

export function getArsipAmplopUnarchived(params: { limit?: number; startDate?: string; endDate?: string; perihal?: string }): Promise<ArsipListResponse> {
  return request<ArsipListResponse>(`/Gateway/grid/mejaku/arsip-unit-amplop/unarchived?${arsipParams(params)}`);
}

export function getArsipDisposisiUnarchived(params: { limit?: number; startDate?: string; endDate?: string; perihal?: string }): Promise<ArsipListResponse> {
  return request<ArsipListResponse>(`/Gateway/grid/mejaku/arsip-unit-amplopdisposisi/unarchived?${arsipParams(params)}`);
}

export function getListBerkas(params?: { limit?: number; berkasAktif?: number }): Promise<ArsipListResponse> {
  const p = new URLSearchParams({
    offset: "0",
    limit: String(params?.limit ?? 1000),
    berkasAktif: String(params?.berkasAktif ?? 1),
    isFromManajemenBerkas: "0",
  });
  return request<ArsipListResponse>(`/Gateway/EArsip/ManajemenBerkas/ListBerkas?${p}`);
}

export function createBerkas(payload: {
  KlasifikasiArsipId: number;
  UraianBerkas: string;
  JumlahBerkas?: string;
  KurunWaktu: string;
  KeteranganId?: number;
}): Promise<ArsipMutateResponse> {
  return request<ArsipMutateResponse>("/Gateway/EArsip/ManajemenBerkas", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      KlasifikasiArsipId: payload.KlasifikasiArsipId,
      UraianBerkas: payload.UraianBerkas,
      JumlahBerkas: payload.JumlahBerkas ?? "1 Berkas",
      KurunWaktu: payload.KurunWaktu,
      KeteranganId: payload.KeteranganId ?? 3,
    }),
  });
}

export function getRefKlasifikasiArsipFav(): Promise<ArsipListResponse> {
  return request<ArsipListResponse>("/gateway/EArsip/refklasifikasiarsip/favourite");
}

export function getRefKlasifikasiArsipAll(): Promise<ArsipListResponse> {
  return request<ArsipListResponse>("/Gateway/General/EArsip/RefKlasifikasiArsip/getAllRootNew");
}

export function berkaskanMultiple(
  docType: string,
  berkasId: number,
  items: Array<{ Id: string; NdId: number }>,
): Promise<ArsipMutateResponse> {
  const suffix = docType === "amplop" ? "amplopnd" : docType === "disposisi" ? "amplopdisposisi" : "konsep";
  return request<ArsipMutateResponse>(`/EArsip/MultipleBerkaskan/${suffix}/${berkasId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(items.map(i => ({ Id: String(i.Id), NdId: i.NdId }))),
  });
}
