// Persists the user-uploaded baku LEK template to chrome.storage.local (single,
// replaceable). Mirrors the existing Nadine/SIMAN template-store pattern.
const KEY = "asguard.lekTemplate";

export interface LekTemplateMeta {
  name: string;
  savedAt: number;
}
interface Stored extends LekTemplateMeta {
  base64: string;
}

export async function getLekTemplateMeta(): Promise<LekTemplateMeta | null> {
  const v = (await chrome.storage.local.get(KEY))[KEY] as Stored | undefined;
  return v ? { name: v.name, savedAt: v.savedAt } : null;
}

export async function getLekTemplateBytes(): Promise<ArrayBuffer | null> {
  const v = (await chrome.storage.local.get(KEY))[KEY] as Stored | undefined;
  if (!v) return null;
  return base64ToBuffer(v.base64);
}

export async function saveLekTemplate(file: File): Promise<LekTemplateMeta | null> {
  const base64 = await fileToBase64(file);
  const stored: Stored = { name: file.name, savedAt: Date.now(), base64 };
  try {
    await chrome.storage.local.set({ [KEY]: stored });
  } catch {
    return null; // quota exceeded / storage error — caller proceeds without persisting
  }
  return { name: stored.name, savedAt: stored.savedAt };
}

export async function clearLekTemplate(): Promise<void> {
  await chrome.storage.local.remove(KEY);
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Gagal membaca file template."));
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result as ArrayBuffer);
      let s = "";
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      resolve(btoa(s));
    };
    reader.readAsArrayBuffer(file);
  });
}

function base64ToBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
