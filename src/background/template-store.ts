/**
 * Template storage — CRUD operations for NaskahTemplate in chrome.storage.local.
 * Each template stores the full CreateNaskahPayload + optional konsep .docx files.
 */

import type { NaskahTemplate } from "@/shared/types";

const STORAGE_KEY = "asguard.templates";

function uuid(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

async function loadAll(): Promise<NaskahTemplate[]> {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return (data[STORAGE_KEY] as NaskahTemplate[] | undefined) ?? [];
}

async function saveAll(templates: NaskahTemplate[]): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: templates });
}

export async function getAll(): Promise<NaskahTemplate[]> {
  return loadAll();
}

export async function getById(id: string): Promise<NaskahTemplate | null> {
  const all = await loadAll();
  return all.find((t) => t.id === id) ?? null;
}

export async function save(
  partial: Omit<NaskahTemplate, "id" | "createdAt" | "updatedAt">,
): Promise<NaskahTemplate> {
  const template: NaskahTemplate = {
    ...partial,
    id: uuid(),
    createdAt: now(),
    updatedAt: now(),
  };
  const all = await loadAll();
  all.push(template);
  await saveAll(all);
  return template;
}

export async function update(
  id: string,
  updates: Partial<NaskahTemplate>,
): Promise<NaskahTemplate | null> {
  const all = await loadAll();
  const idx = all.findIndex((t) => t.id === id);
  if (idx === -1) return null;

  const merged = { ...all[idx], ...updates, id, updatedAt: now() };

  // Keys explicitly set to null or undefined mean "delete this field".
  // chrome.runtime.sendMessage uses JSON serialization which strips undefined
  // but preserves null, so the panel sends null to signal deletion.
  for (const key of Object.keys(updates) as (keyof NaskahTemplate)[]) {
    if (updates[key] === undefined || updates[key] === null) {
      delete (merged as Record<string, unknown>)[key];
    }
  }

  all[idx] = merged;
  await saveAll(all);
  return all[idx];
}

export async function remove(id: string): Promise<boolean> {
  const all = await loadAll();
  const filtered = all.filter((t) => t.id !== id);
  if (filtered.length === all.length) return false;
  await saveAll(filtered);
  return true;
}
