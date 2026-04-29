import type { PageContext, TokenState } from "@/shared/types";

const STORAGE_KEY = "asguard.tokenState";
const PAGE_KEY = "asguard.lastPage";
const NDID_KEY = "asguard.currentNdId";

let tokenState: TokenState = { token: null, capturedAt: null, origin: null, nip: null, fullname: null };
let lastPage: PageContext | null = null;
let currentNdId: string | null = null;

export async function restore(): Promise<void> {
  const data = await chrome.storage.session.get([STORAGE_KEY, PAGE_KEY, NDID_KEY]);
  if (data[STORAGE_KEY]) tokenState = data[STORAGE_KEY] as TokenState;
  if (data[PAGE_KEY]) lastPage = data[PAGE_KEY] as PageContext;
  if (data[NDID_KEY]) currentNdId = data[NDID_KEY] as string;
}

export async function setToken(token: string, origin: string): Promise<boolean> {
  if (tokenState.token === token) return false;
  tokenState = { token, capturedAt: Date.now(), origin, nip: tokenState.nip, fullname: tokenState.fullname };
  await chrome.storage.session.set({ [STORAGE_KEY]: tokenState });
  return true;
}

export async function setNipFromMe(nip: string, fullname: string): Promise<void> {
  tokenState = { ...tokenState, nip, fullname };
  await chrome.storage.session.set({ [STORAGE_KEY]: tokenState });
}

export async function clearToken(): Promise<void> {
  tokenState = { token: null, capturedAt: null, origin: null, nip: null, fullname: null };
  await chrome.storage.session.remove(STORAGE_KEY);
}

export function getToken(): TokenState {
  return tokenState;
}

export async function setPage(ctx: PageContext): Promise<void> {
  lastPage = ctx;
  await chrome.storage.session.set({ [PAGE_KEY]: ctx });
}

export function getPage(): PageContext | null {
  return lastPage;
}

export async function setCurrentNdId(ndId: string): Promise<boolean> {
  if (currentNdId === ndId) return false;
  currentNdId = ndId;
  await chrome.storage.session.set({ [NDID_KEY]: ndId });
  return true;
}

export function getCurrentNdId(): string | null {
  return currentNdId;
}
