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
  durasi?: string;
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
