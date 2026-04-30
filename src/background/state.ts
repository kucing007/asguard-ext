/**
 * Shared mutable state and utility functions for the background service worker.
 * All handlers and port modules import from here instead of sharing closures.
 */
import * as store from "./token-store";
import * as simanStore from "./siman-store";
import * as licenseClient from "./license-client";
import { NadineHttpError, NadineNoTokenError } from "./nadine-client";
import type { ApiResult, LlmSettings, PanelSnapshot } from "@/shared/types";
import { DEFAULT_LLM_SETTINGS } from "@/shared/types";
import type { LicenseStatus } from "./license-client";

// --- Shared mutable state ---

const SETTINGS_KEY = "asguard.llmSettings";
export let llmSettings: LlmSettings = { ...DEFAULT_LLM_SETTINGS };
export let pendingPayload: Record<string, unknown> | null = null;
export let activeTab: "nadine" | "siman" = "nadine";
export let licenseStatus: LicenseStatus | null = null;
export let capturedPenetapanBody: Record<string, unknown> | null = null;
export const capturedPdfs = new Map<string, { base64: string; url: string; capturedAt: number }>();
export const naskahTextCache = new Map<string, { body: string; meta: Record<string, string | undefined> }>();

// --- State accessors ---

export async function loadSettings(): Promise<void> {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  if (data[SETTINGS_KEY]) {
    llmSettings = { ...DEFAULT_LLM_SETTINGS, ...(data[SETTINGS_KEY] as Partial<LlmSettings>) };
  }
}

export async function saveSettings(partial: Partial<LlmSettings>): Promise<LlmSettings> {
  llmSettings = { ...llmSettings, ...partial };
  await chrome.storage.local.set({ [SETTINGS_KEY]: llmSettings });
  return llmSettings;
}

export function snapshot(): PanelSnapshot {
  return {
    token: store.getToken(),
    lastPage: store.getPage(),
    currentNdId: store.getCurrentNdId(),
    pendingPayload: !!pendingPayload,
    simanToken: simanStore.getSimanToken(),
    activeTab,
    licenseStatus,
  };
}

export function broadcastState() {
  chrome.runtime
    .sendMessage({ type: "state/changed", snapshot: snapshot() })
    .catch(() => {
      /* no panel open */
    });
}

export async function refreshLicense(nip: string): Promise<void> {
  licenseStatus = await licenseClient.checkLicense(nip);
  console.log("[asguard] license:", licenseStatus.status, licenseStatus.message);
}

// --- API helper ---

export async function runApi<T>(fn: () => Promise<T>): Promise<ApiResult<T>> {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (e) {
    if (e instanceof NadineHttpError) {
      return { ok: false, error: e.message, status: e.status };
    }
    if (e instanceof NadineNoTokenError) {
      return { ok: false, error: e.message };
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// --- State setters (imported `let` bindings are read-only) ---

export function setActiveTab(tab: "nadine" | "siman"): void {
  activeTab = tab;
}

export function setPendingPayload(p: Record<string, unknown> | null): void {
  pendingPayload = p;
}

export function setLicenseStatus(s: LicenseStatus | null): void {
  licenseStatus = s;
}

export function setCapturedPenetapanBody(b: Record<string, unknown> | null): void {
  capturedPenetapanBody = b;
}

// --- Utility ---

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
