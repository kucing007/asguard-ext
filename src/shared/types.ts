import type { SimanBgMessage, SimanRole, SimanTemplate, SimanTokenState } from "./siman-types";

export type PageKind =
  | { kind: "inbox"; tab: "amplop" | "disposisi" | "konsep" | "unknown" }
  | { kind: "detail"; ndId: string }
  | { kind: "create" }
  | { kind: "beranda" }
  | { kind: "siman" }
  | { kind: "other" };

export interface PageContext {
  url: string;
  page: PageKind;
}

export interface TokenState {
  token: string | null;
  capturedAt: number | null;
  origin: string | null;
  nip: string | null;
  fullname: string | null;
}

// --- License ---

export interface LicenseStatus {
  valid: boolean;
  status: string;  // "trial" | "active" | "expired" | "blocked" | "offline" | "error"
  message: string;
  days_remaining: number;
  expires?: string;
  cachedAt?: number;
}

// --- LLM Settings ---

export interface LlmSettings {
  llamaUrl: string;
  modelName: string;
  maxTokens: number;
  systemPrompt: string;    // empty = use default
  temperature: number;     // 0.0–1.0; lower = faster & more deterministic
  maxPages: number;        // max PDF pages to extract; 0 = all
  maxInputChars: number;   // max chars sent to LLM; 0 = unlimited
}

export const DEFAULT_LLM_SETTINGS: LlmSettings = {
  llamaUrl: "http://localhost:8080",
  modelName: "gemma",
  maxTokens: 512,
  systemPrompt: "",
  temperature: 0.2,
  maxPages: 7,
  maxInputChars: 4000,
};

// --- Notification settings ---

export type NotifSource = "disposisi" | "amplop" | "siman";

export interface NotificationSettings {
  disposisi: boolean;
  amplop: boolean;
  siman: boolean;
  intervalMinutes: number;  // poll cadence; v1 fixed at 5 in UI but stored for future tweaks
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  disposisi: true,
  amplop: true,
  siman: true,
  intervalMinutes: 1,
};

// --- Naskah Template ---

export interface KonsepFile {
  name: string;
  base64: string;
  size: number;
}

export interface MailMergeExcel {
  filename: string;
  sheetName: string;
  headers: string[];
  rows: Record<string, string>[];
}

export interface NaskahTemplate {
  id: string;
  name: string;
  description: string;
  payload: Record<string, unknown>; // CreateNaskahPayload dict
  konsepFile?: KonsepFile;          // stored .docx
  notaPengantarData?: Record<string, unknown>; // NP Penandatangan/Pengirim config
  konsepNotaFile?: KonsepFile;      // stored NP .docx
  mailMergeMapping?: Record<string, string>; // saved placeholder → excel column
  mailMergeExcel?: MailMergeExcel;           // saved excel data (headers + rows)
  createdAt: string;
  updatedAt: string;
}

// --- Messages from content script → background ---

export type BgMessage =
  | { type: "token/capture"; token: string; origin: string }
  | { type: "page/changed"; ctx: PageContext }
  | { type: "viewing/ndId"; ndId: string }
  | { type: "pdf/captured"; base64: string; url: string; size: number }
  | { type: "naskah/created"; payload: Record<string, unknown>; url: string }
  | SimanBgMessage;

// --- Messages from panel → background (request/response) ---

export type PanelRequest =
  | { type: "state/get" }
  | { type: "token/clear" }
  | { type: "api/counts" }
  | { type: "api/naskah"; ndId: string }
  | { type: "api/me" }
  | { type: "api/switch-role"; unitData: Record<string, unknown> }
  | { type: "settings/get" }
  | { type: "settings/set"; settings: Partial<LlmSettings> }
  | { type: "llm/health" }
  | { type: "cache/clear" }
  // Template CRUD
  | { type: "template/list" }
  | { type: "template/get"; id: string }
  | { type: "template/save"; template: Omit<NaskahTemplate, "id" | "createdAt" | "updatedAt"> }
  | { type: "template/update"; id: string; updates: Partial<NaskahTemplate> }
  | { type: "template/delete"; id: string }
  | { type: "template/pending" }  // get pending captured payload
  | { type: "template/units"; kodeOrganisasi: string; pengirimEselon: number }  // fetch subordinate units for NP picker
  // Arsiparis
  | { type: "arsip/fetch"; docType: ArsipDocType; startDate: string; endDate: string; perihal?: string; limit?: number }
  | { type: "arsip/berkas-list" }
  | { type: "arsip/berkas-create"; klasifikasiArsipId: number; uraianBerkas: string; kurunWaktu: string }
  | { type: "arsip/klasifikasi-fav" }
  | { type: "arsip/klasifikasi-all" }
  | { type: "arsip/bulk"; docType: ArsipDocType; berkasId: number; items: Array<{ Id: string; NdId: number }> }
  | { type: "arsip/list-berkas-ids"; year: number; kodeOrganisasi: string }
  | { type: "arsip/download-berkas"; format: "xls" | "pdf"; berkasIds: number[]; kodeOrganisasi: string }
  // SIMAN
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
  | { type: "siman/get-kanwil-list" }
  | { type: "siman/get-kpknl-list" }
  | { type: "siman/get-templates" }
  | { type: "siman/save-template"; template: Omit<SimanTemplate, "id" | "createdAt"> }
  | { type: "siman/template-update"; id: string; updates: Partial<SimanTemplate> }
  | { type: "siman/delete-template"; id: string }
  // Evaluasi BMN
  | { type: "eval/paket-list"; limit: number; offset: number; tahun?: number; statusPaket?: string }
  | { type: "eval/aset-list"; noPaket: string }
  | { type: "eval/laksana"; idSiapBmn: string }
  | { type: "eval/ref-skor"; kdSubSub: string }
  | { type: "eval/edit-evaluasi"; aset: Record<string, unknown>; caraEvaluasi: string }
  | { type: "eval/edit-survey"; aset: Record<string, unknown>; tglSurvey: string }
  | { type: "eval/edit-status"; aset: Record<string, unknown> }
  | { type: "eval/edit-laksana"; payload: Record<string, unknown> }
  | { type: "eval/generate15"; aset: Record<string, unknown> }
  // Monitoring Pengelolaan
  | { type: "siman/get-monitoring-list"; filterId: number; idTipePengelolaan?: number; idStatus?: number; termohon?: number; limit: number; offset: number }
  | { type: "siman/get-monitoring-status-tiket" }
  | { type: "siman/get-all-tipe-pengelolaan" }
  | { type: "siman/get-struktur-termohon" }
  | { type: "siman/get-dok-analisis"; idPengelolaan: string; idStruktur?: number }
  | { type: "siman/get-sk-by-tiket-monitoring"; idPengelolaan: string }
  | { type: "siman/check-tinjut-batch"; noTikets: string[] }
  // EWS Notes Sync
  | { type: "ews/notes-fetch"; kpknlId: number; author?: string }
  | { type: "ews/note-upsert"; note: { no_tiket: string; kpknl_id: number; note: string; status: string; choice?: string; author: string } }
  | { type: "ews/note-delete"; noTiket: string; kpknlId: number }
  | { type: "ews/note-sync-one"; noTiket: string; kpknlId: number }
  // Notifications
  | { type: "notif/settings/get" }
  | { type: "notif/settings/set"; settings: Partial<NotificationSettings> }
  // License
  | { type: "license/check" }
  | { type: "license/clear-cache" }
  // Update
  | { type: "update/check" }
  | { type: "update/get-cached" }
  // Backup
  | { type: "backup/export" }
  | { type: "backup/import"; data: Record<string, unknown> };

// --- Messages sent over chrome.runtime.Port for LLM streaming ---

export type LlmPortRequest =
  | { type: "llm/summarize"; ndId: string; skipCache?: boolean }
  | { type: "llm/chat"; ndId: string; history: ChatMessage[]; userMessage: string }
  | { type: "pdf/text"; text: string; ndId: string };  // sidepanel → background: extracted text

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export type LlmStreamMsg =
  | { type: "llm/cached"; text: string }
  | { type: "llm/meta"; noNd?: string; perihal?: string; pengirim?: string; tanggal?: string }
  | { type: "llm/status"; status: string }
  | { type: "pdf/extract"; base64: string; maxPages?: number }  // background → sidepanel: please extract this PDF
  | { type: "llm/chunk"; text: string }
  | { type: "llm/done" }
  | { type: "llm/error"; error: string };

// --- Template run progress (port: template-run) ---

export type MailMergeRowMsg =
  | { type: "mm/start"; templateId: string; total: number; penandatanganUnit?: Record<string, unknown> }
  | { type: "mm/row"; index: number; payload: Record<string, unknown>; docxBase64: string; filename: string; npDocxBase64?: string; npFilename?: string }
  | { type: "mm/abort" };

export type MailMergeProgressMsg =
  | { type: "mm/row-step"; index: number; step: string }
  | { type: "mm/row-done"; index: number; ndId?: number; error?: string }
  | { type: "mm/complete"; success: number; failed: number; ndIds: number[] };

export type TemplateRunRequest = {
  type: "template/run";
  templateId: string;
  perihalOverride?: string;
  /** Penandatangan unit chosen by user in the RunModal picker */
  penandatanganUnit?: Record<string, unknown>;
};

export type TemplateRunMsg =
  | { type: "run/step"; step: number; total: number; label: string }
  | { type: "run/done"; ndId: number }
  | { type: "run/error"; error: string };

// --- Arsiparis ---

export type ArsipDocType = "konsep" | "amplop" | "disposisi";

export interface ArsipItem {
  Id: string;
  NdId: number;
  NoNd?: string;
  Perihal?: string;
  Pengirim?: string;
  Penandatangan?: string;
  TanggalKirim?: string;
  KodeKlasifikasi?: string;
  [k: string]: unknown;
}

export interface ArsipBerkas {
  Id: number;
  UraianBerkas?: string;
  KurunWaktu?: string | number;
  KlasifikasiArsip?: { KodeKlasifikasi?: string; Nama?: string; [k: string]: unknown };
  UnitPengolah?: { NamaOrganisasi?: string; [k: string]: unknown };
  JumlahBerkas?: string;
  [k: string]: unknown;
}

export interface ArsipKlasifikasi {
  Id: number;
  KodeKlasifikasi?: string;
  Nama?: string;
  Children?: ArsipKlasifikasi[];
  [k: string]: unknown;
}

export interface ArsipGroup {
  kode: string;
  count: number;
  berkasId?: number;
  berkasExists: boolean;
}

export type ArsipPortMsg =
  | { type: "arsip/start-auto"; docType: ArsipDocType; startDate: string; endDate: string; useAI?: boolean }
  | { type: "arsip/confirm" }
  | { type: "arsip/abort" }
  | { type: "arsip/pdf-text"; text: string; ndId: number };  // panel → bg: extracted PDF text

export type ArsipProgressMsg =
  | { type: "arsip/status"; message: string }
  | { type: "arsip/classify-progress"; done: number; total: number }
  | { type: "arsip/groups"; groups: ArsipGroup[] }
  | { type: "arsip/group-step"; index: number; total: number; kode: string; step: string }
  | { type: "arsip/complete"; success: number; skipped: number; created: number; failed: number }
  | { type: "arsip/error"; error: string }
  | { type: "arsip/pdf-extract"; base64: string; maxPages: number; ndId: number };  // bg → panel: extract this PDF

/** Org unit entry returned from getRefUnitsTree */
export interface OrgUnit {
  NamaJabatan?: string;
  NamaPejabat?: string;
  NamaOrganisasi?: string;
  KodeOrganisasi?: string;
  Eselon?: number;
  [k: string]: unknown;
}

// --- Generic result wrapper ---

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status?: number };

// --- Panel state snapshot ---

export interface PanelSnapshot {
  token: TokenState;
  lastPage: PageContext | null;
  currentNdId: string | null;
  pendingPayload?: boolean;  // true if a create-naskah payload was captured
  simanToken: SimanTokenState;
  activeTab: "nadine" | "siman";
  licenseStatus: LicenseStatus | null;
}

// --- SIMAN ---
export type {
  SimanRole,
  SimanRoleContext,
  SimanTokenState,
  SimanTemplate,
  SimanPenetapan,
  SimanKelengkapanDoc,
  SopExportRow,
  SimanTipePengelolaan,
  SimanBgMessage,
  SimanRequest,
  SimanRunPortRequest,
  SimanRunProgressMsg,
  SimanDokLengkapPortRequest,
  SimanDokLengkapMsg,
  SimanSopTarikPortRequest,
  SimanSopTarikMsg,
  EvalPaket,
  EvalAset,
  EvalLaksana,
  SimanEvalPortRequest,
  SimanEvalMsg,
  MonitoringStatusTiket,
  StrukturTermohon,
  MonitoringPengelolaanItem,
  MonitoringDokAnalisis,
  MonitoringSK,
  MonitoringExportRow,
  SimanMonitoringPortRequest,
  SimanMonitoringMsg,
  EwsRow,
  EwsRenewalInfo,
  SimanEwsPortRequest,
  SimanEwsMsg,
} from "./siman-types";
