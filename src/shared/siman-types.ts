// Content script → background messages for SIMAN domain
export type SimanBgMessage =
  | { type: "siman/token"; token: string; origin: string }
  | { type: "siman/role-data"; roleData: Record<string, unknown> }
  | { type: "siman/penetapan-body"; body: Record<string, unknown> };

// Wire type — as returned by the SIMAN roles API (snake_case field names)
export interface SimanRole {
  id_role: string;
  nm_role: string;
  id_kpknl: string;
  nm_kpknl: string;
  id_kanwil: string;
  nm_kanwil: string;
  // Additional fields returned by the API (not always present)
  id_user?: string;
  id_user_detail?: string;
  id_struktur?: string;
  id_role_struktur?: string;
  nama_role_struktur?: string;
  nama_unit?: string;
  ur_kanwil?: string;
}

export interface SimanRoleContext {
  idRole: string;
  nmRole: string;
  namaRoleStruktur: string;  // nama_role_struktur from roles API
  idKpknl: string;           // numeric string, e.g. "123"
  nmKpknl: string;
  namaUnit: string;          // nama_unit from roles API
  idKanwil: string;          // numeric string
  nmKanwil: string;
  urKanwil: string;          // ur_kanwil from roles API
  idUserDetail: string;
  idUser: string;            // the user's login id (id_user from roles API)
  idStruktur: string;        // id_struktur_termohon, defaults to "9"
  token: string;
}

export interface SimanTokenState {
  token: string | null;
  capturedAt: number | null;
  userId: string | null;
  nip: string | null;
  fullname: string | null;
  jabatan: string | null;
  role: SimanRoleContext | null;
}

export interface SimanTemplate {
  id: string;
  name: string;
  idTipePengelolaan: number;
  namaTipe: string;
  konsepNd?: { name: string; base64: string };
  konsepNp?: { name: string; base64: string };
  mapping: Record<string, string>;        // "{no_tiket}" → "no_tiket"
  savedVariables: Record<string, string>; // manually filled, pre-filled on next run
  savedKdSatker?: string;                 // kd_satker when savedVariables were last written
  perihalVarKey?: string;                 // which SIMAN variable to use as Perihal naskah
  customVars?: Array<{ outputKey: string; sourceKey: string; transform: string }>;
  npPenandatangan?: Record<string, unknown>; // saved once, reused every run
  nadinePayload?: Record<string, unknown>;
  createdAt: string;
}

export interface SimanPenetapan {
  idPengelolaan: string;
  idTipePengelolaan: string;
  noTiket: string;
  tipe: string;
  satker: string;
  status: string;
  deskripsi?: string;  // raw deskripsi field — used to gate Lengkap Semua
  durasi?: string;
}

export interface SimanKelengkapanDoc {
  id_pengelolaan_dok: string | number;
  kd_dok: string;
  nm_dok: string;
  nm_file: string;
  no_dok: string;
  tgl_dokumen: string;
  perihal: string;
  jabatan_penandatangan: string;
  catatan: string;
  jns_alur: number;
  status_dok: number;
  [k: string]: unknown;
}

export interface SopExportRow {
  no_tiket: string;
  no_sk: string;
  tgl_sk: string;
  ur_satker: string;
  kd_satker: string;
  pemohon: string;
  ur_kl: string;
  nama_tipe_pengelolaan: string;
  tgl_dokumen_diterima: string;
  kategori_bmn: string;
  sum_nilai_persetujuan: number | string;
  sum_total_permohonan: number | string;
  nilai_persetujuan_sewa: number | string;
  jumlah_aset: number | string;
}

export interface SimanTipePengelolaan {
  id: string;    // id_tipe_pengelolaan from API
  nama: string;  // nama_tipe_pengelolaan from API
}

// --- SIMAN panel requests ---
export type SimanRequest =
  | { type: "siman/state" }
  | { type: "siman/token-clear" }
  | { type: "siman/get-roles" }
  | { type: "siman/set-role"; role: SimanRole; idKpknl: string; idKanwil: string }
  | { type: "siman/get-tipe-pengelolaan" }
  | { type: "siman/get-penetapan-list"; limit: number; offset: number; statusFilter?: string; idTipe?: string }
  | { type: "siman/get-penetapan-detail"; noTiket: string }
  | { type: "siman/get-kelengkapan"; idPengelolaan: string }
  | { type: "siman/get-download-token"; idPengelolaanDok: number; nmFile: string }
  | { type: "siman/get-download-token-model"; id: number; filename: string; model: string }
  | { type: "siman/get-templates" }
  | { type: "siman/save-template"; template: Omit<SimanTemplate, "id" | "createdAt"> }
  | { type: "siman/template-update"; id: string; updates: Partial<SimanTemplate> }
  | { type: "siman/delete-template"; id: string };

// --- siman-run port messages ---
export type SimanRunPortRequest =
  | { type: "siman/run"; noTiket: string; idPengelolaan: string; idTipePengelolaan: string; templateId: string }
  | { type: "siman/run-render"; templateId: string; variables: Record<string, string>; ndDocxBase64: string; ndFilename: string; npDocxBase64?: string; npFilename?: string; npPenandatangan?: Record<string, unknown> }
  | { type: "siman/upload-nd"; templateId: string; variables: Record<string, string>; ndId: number; ndDocxBase64: string; ndFilename: string; npDocxBase64?: string; npFilename?: string; npPenandatangan?: Record<string, unknown> };

export interface SimanRunProgressMsg {
  step: string;
  status: "pending" | "running" | "done" | "error";
  message?: string;
  variables?: Record<string, string>;
  ndId?: number;
}

// --- siman-dok-lengkap port messages ---
export type SimanDokLengkapPortRequest =
  | { type: "siman/dok-lengkap-run"; idPengelolaan: string; noTiket: string }
  | { type: "siman/dok-lengkap-abort" };

export type SimanDokLengkapMsg =
  | { type: "dok/progress"; done: number; total: number; nmDok: string }
  | { type: "dok/done"; success: number; failed: number }
  | { type: "dok/error"; error: string };

// --- siman-sop-tarik port messages ---
export type SimanSopTarikPortRequest =
  | { type: "siman/sop-tarik-run"; tahunAnggaran: string; idKanwil: number; idKpknl: number };

export type SimanSopTarikMsg =
  | { type: "sop/status"; message: string }
  | { type: "sop/sk-progress"; done: number; total: number }
  | { type: "sop/detail-progress"; done: number; total: number; noTiket: string }
  | { type: "sop/rows"; rows: SopExportRow[] }
  | { type: "sop/done" }
  | { type: "sop/error"; error: string };

// --- Evaluasi BMN types ---

export interface EvalPaket {
  no_paket: string;
  ur_satker: string;
  ur_kl: string;
  ur_kpknl: string;
  tahun: number;
  jml_bmn: number;
  status_paket: string;
  deskripsi: string;
}

export interface EvalAset {
  id_siap_bmn: string;
  kd_brg: string;
  no_aset: string;
  ur_sskel: string;
  ur_satker: string;
  kd_satker: string;
  cara_evaluasi: string;
  tgl_survey: string;
  kinerja_aset: string;
  status_evaluasi: string;
  status_validasi: string;
  no_paket: string;
  tahun: number;
  id_aset: string;
  id_satker: string;
  id_kpknl: string;
  ur_kpknl: string;
  id_kanwil: string;
  kd_jns_bmn: string;
  kd_peruntukan: string;
  ur_peruntukan: string;
  [k: string]: unknown;
}

export interface EvalLaksana {
  id_laksana: string;
  id_laks_ind: string;
  no_paket: string;
  kd_indikator: string;
  ur_indikator: string;
  kd_sub_sub: string;
  ur_sub_sub: string;
  nilai_sub_sub: number;
  nilai_sub_sub2: number;
  skor: number;
  score_color: string;
  status_na_nu: string;
  [k: string]: unknown;
}

// --- siman-eval port messages ---

export type SimanEvalPortRequest = { type: "siman/eval-run"; noPaket: string; excelRows: Record<string, string>[] };

export type SimanEvalMsg =
  | { type: "eval/status"; message: string }
  | { type: "eval/log"; message: string }
  | { type: "eval/aset-progress"; done: number; total: number; kdBrg: string; step: string }
  | { type: "eval/aset-done"; done: number; total: number; kinerja: string }
  | { type: "eval/done"; success: number; failed: number }
  | { type: "eval/error"; error: string };

// --- Monitoring Pengelolaan types ---

export interface MonitoringStatusTiket {
  id: number;
  kd_status_tiket: number;
  nm_status_tiket: string;
}

export interface StrukturTermohon {
  id_struktur: number;
  level: number;
  nama_alias: string;
  nama_level: string;
  id_jns_role: number;
  filter_column: string;
  penetapan: string;
}

export interface MonitoringPengelolaanItem {
  id_pengelolaan: string;
  no_tiket: string;
  id_tipe_pengelolaan: number;
  nama_tipe_pengelolaan: string;
  ur_satker: string;
  kd_satker: string;
  pemohon: string;
  termohon: string;
  deskripsi: string;
  status: string;
  tgl_created: string;
  [k: string]: unknown;
}

export interface MonitoringDokAnalisis {
  id_pengelolaan_dok_analisis: string;
  id_pengelolaan: string;
  no_tiket: string;
  nm_surat: string;
  tgl_surat: string;
  no_surat: string;
  perihal_surat: string;
  nm_file: string;
  url: string;
  status_dokumen: string;
  kd_dok: number;
  nm_dok: string;
  id_struktur: number;
  [k: string]: unknown;
}

export interface MonitoringSK {
  id_pengelolaan_sk: string;
  no_tiket: string;
  no_sk: string;
  tgl_sk: string;
  ur_jns_sk: string;
  perihal: string;
  nama_penandatangan_sk: string;
  jabatan_penandatangan_sk: string;
  nama_status_surat: string;
  url_sk_minio: string;
  url_lampiran_minio: string;
  url_sk: string;
  url_lampiran: string;
  nm_file_sk: string;
  id_pengelolaan: string;
  [k: string]: unknown;
}

export interface MonitoringExportRow {
  // Ticket-level info
  no_tiket: string;
  nama_tipe_pengelolaan: string;
  ur_satker: string;
  kd_satker: string;
  pemohon: string;
  termohon: string;
  deskripsi: string;
  status: string;
  no_sk: string;
  tgl_sk: string;
  jumlah_aset: number | string;
  jumlah_dok_analisis: number | string;
  jumlah_dok_kelengkapan: number | string;
  tgl_dokumen_diterima: string;
  // Per-asset detail fields
  kd_brg: string;
  nup: string;
  ur_sskel: string;
  merk: string;
  catatan: string;
  alamat: string;
  ur_kondisi: string;
  no_psp: string;
  tgl_perlh: string;
  luas_aset: number | string;
  ref_luas: number | string;
  ref_luas_sewa: number | string;
  ref_jenis: string;
  ref_jangka_waktu: string;
  ref_periode_label: string;
  tujuan_permohonan: string;
  nilai_perolehan: number | string;
  nilai_buku: number | string;
  nilai_permohonan: number | string;
  nilai_persetujuan: number | string;
  nilai_perolehan_proporsional: number | string;
  nm_jns_bmn: string;
  status_asuransi: string;
  status_kib: string;
  status_tindak_lanjut: string;
}

// --- Monitoring port messages ---
export type SimanMonitoringPortRequest =
  | {
      type: "siman/monitoring-run";
      idTipePengelolaan: number;
      filterId: number;
      idStatus: number;
      termohon: number;
      downloadKelengkapan: boolean;
      downloadAnalisis: boolean;
      downloadSk: boolean;
      downloadTindakLanjut: boolean;
      tahunSk: string;
    };

export type SimanMonitoringMsg =
  | { type: "monitoring/status"; message: string }
  | { type: "monitoring/list-progress"; done: number; total: number }
  | { type: "monitoring/detail-progress"; done: number; total: number; noTiket: string }
  | { type: "monitoring/download-progress"; done: number; total: number; filename: string }
  | { type: "monitoring/rows"; rows: MonitoringExportRow[] }
  | { type: "monitoring/done"; success: number; failed: number; totalRows: number }
  | { type: "monitoring/error"; error: string };

// --- EWS Waktu Pemanfaatan ---

export interface EwsRow {
  no_tiket: string;
  id_pengelolaan: string;
  nama_tipe_pengelolaan: string;
  ur_satker: string;
  kd_satker: string;
  pemohon: string;
  no_sk: string;
  tgl_sk: string;
  id_aset: string;
  kd_brg: string;
  nup: string;
  ur_sskel: string;
  tujuan_permohonan: string;
  keterangan: string;
  ref_luas_sewa: string;
  ref_jangka_waktu: number;
  tgl_berakhir: string;
  sisa_hari: number;
  sisa_label: string;
  status_ews: "lewat" | "kritis" | "perhatian" | "aman";
  nilai_persetujuan: number;
  /** Renewal info from list-pengelolaan API (only for lewat/kritis) */
  renewal: EwsRenewalInfo | null;
  /** PKS (Perjanjian Kerja Sama) data from rekam-tindak-lanjut kd_dok_tindak_lanjut=25 */
  pks_tgl_perjanjian: string | null;
  pks_tgl_berakhir: string | null;
  pks_sisa_hari: number | null;
  pks_sisa_label: string | null;
}

export interface EwsRenewalInfo {
  no_tiket: string;
  no_surat: string;
  tgl_surat: string;
  nama_tipe_pengelolaan: string;
  /** Comparison data from new ticket's asset */
  new_tujuan: string;
  new_luas: string;
  new_keterangan: string;
  /** Match results */
  match_luas: boolean;
  match_tujuan: boolean;
  match_keterangan: boolean;
  /** Overall: true = genuine renewal, false = different purpose */
  is_renewal: boolean;
}

export type SimanEwsPortRequest =
  | { type: "siman/ews-run"; idTipePengelolaan: number; idStatus: number };

export type SimanEwsMsg =
  | { type: "ews/status"; message: string }
  | { type: "ews/progress"; done: number; total: number }
  | { type: "ews/rows"; rows: EwsRow[]; kpknlId: number }
  | { type: "ews/done" }
  | { type: "ews/error"; error: string };