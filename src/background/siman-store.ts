import type { SimanTemplate, SimanTokenState, SimanRoleContext } from "@/shared/siman-types";

const TOKEN_KEY = "asguard.simanTokenState";
const TEMPLATES_KEY = "asguard.simanTemplates";

let simanTokenState: SimanTokenState = {
  token: null, capturedAt: null, userId: null, nip: null,
  fullname: null, jabatan: null, role: null,
};

export async function restoreSimanToken(): Promise<void> {
  const data = await chrome.storage.session.get(TOKEN_KEY);
  if (data[TOKEN_KEY]) simanTokenState = data[TOKEN_KEY] as SimanTokenState;
}

export async function setSimanToken(
  token: string,
  meta: { userId: string; nip: string; fullname: string; jabatan: string },
): Promise<boolean> {
  const same =
    simanTokenState.token === token &&
    simanTokenState.userId === meta.userId &&
    simanTokenState.nip === meta.nip;
  if (same) return false;
  simanTokenState = { token, capturedAt: Date.now(), ...meta, role: simanTokenState.role };
  await chrome.storage.session.set({ [TOKEN_KEY]: simanTokenState });
  return true;
}

export async function setSimanRole(role: SimanRoleContext, newToken: string): Promise<void> {
  simanTokenState = { ...simanTokenState, token: newToken, role, capturedAt: Date.now() };
  await chrome.storage.session.set({ [TOKEN_KEY]: simanTokenState });
}

export async function clearSimanToken(): Promise<void> {
  simanTokenState = {
    token: null, capturedAt: null, userId: null, nip: null,
    fullname: null, jabatan: null, role: null,
  };
  await chrome.storage.session.remove(TOKEN_KEY);
}

export function getSimanToken(): SimanTokenState {
  return simanTokenState;
}

// --- Template CRUD ---

async function loadTemplates(): Promise<SimanTemplate[]> {
  const data = await chrome.storage.local.get(TEMPLATES_KEY);
  return (data[TEMPLATES_KEY] as SimanTemplate[] | undefined) ?? [];
}

async function saveTemplates(templates: SimanTemplate[]): Promise<void> {
  await chrome.storage.local.set({ [TEMPLATES_KEY]: templates });
}

export async function getAllSimanTemplates(): Promise<SimanTemplate[]> {
  return loadTemplates();
}

export async function getSimanTemplateById(id: string): Promise<SimanTemplate | null> {
  const all = await loadTemplates();
  return all.find((t) => t.id === id) ?? null;
}

export async function saveSimanTemplate(
  partial: Omit<SimanTemplate, "id" | "createdAt">,
): Promise<SimanTemplate> {
  const template: SimanTemplate = {
    ...partial,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  const all = await loadTemplates();
  all.push(template);
  await saveTemplates(all);
  return template;
}

export async function updateSimanTemplate(
  id: string,
  updates: Partial<SimanTemplate>,
): Promise<SimanTemplate | null> {
  const all = await loadTemplates();
  const idx = all.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  all[idx] = { ...all[idx], ...updates, id };
  await saveTemplates(all);
  return all[idx];
}

export async function deleteSimanTemplate(id: string): Promise<boolean> {
  const all = await loadTemplates();
  const filtered = all.filter((t) => t.id !== id);
  if (filtered.length === all.length) return false;
  await saveTemplates(filtered);
  return true;
}
