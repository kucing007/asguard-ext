/** Settings, health check, and cache handlers. */
import * as state from "../state";
import * as llama from "../llama-client";
import * as cache from "../summary-cache";
import type { LlmSettings } from "@/shared/types";

export async function handleSettingsGet(sendResponse: (r: unknown) => void): Promise<void> {
  sendResponse({ ok: true, data: state.llmSettings });
}

export async function handleSettingsSet(
  raw: { settings: Partial<LlmSettings> },
  sendResponse: (r: unknown) => void,
): Promise<void> {
  const updated = await state.saveSettings(raw.settings);
  sendResponse({ ok: true, data: updated });
}

export async function handleLlmHealth(sendResponse: (r: unknown) => void): Promise<void> {
  const healthy = await llama.checkHealth(state.llmSettings.llamaUrl);
  sendResponse({ ok: true, data: healthy });
}

export async function handleCacheClear(sendResponse: (r: unknown) => void): Promise<void> {
  await cache.clearCache();
  sendResponse({ ok: true });
}
