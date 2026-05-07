/**
 * Persists user-facing notification preferences (per-source on/off + interval).
 * Mirrors the loadSettings/saveSettings idiom in state.ts.
 */
import type { NotificationSettings } from "@/shared/types";
import { DEFAULT_NOTIFICATION_SETTINGS } from "@/shared/types";

const SETTINGS_KEY = "asguard.notifSettings";

let cached: NotificationSettings = { ...DEFAULT_NOTIFICATION_SETTINGS };

export async function restore(): Promise<void> {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  if (data[SETTINGS_KEY]) {
    cached = { ...DEFAULT_NOTIFICATION_SETTINGS, ...(data[SETTINGS_KEY] as Partial<NotificationSettings>) };
  }
}

export function get(): NotificationSettings {
  return cached;
}

export async function save(partial: Partial<NotificationSettings>): Promise<NotificationSettings> {
  cached = { ...cached, ...partial };
  await chrome.storage.local.set({ [SETTINGS_KEY]: cached });
  return cached;
}
