/**
 * Persist the Mail-Merge Excel FileSystemFileHandle (File System Access API)
 * in IndexedDB so "Muat Ulang" can re-read the SAME file silently — no picker.
 *
 * Chrome-only (fine for this extension; sidePanel needs Chrome 114+, which has
 * the File System Access API). When the handle is missing, revoked, or the API
 * is unavailable, MailMergeView falls back to the regular <input type="file">.
 *
 * Note on permission: after a full browser restart Chrome may reset the handle's
 * permission to "prompt"; the first "Muat Ulang" click then re-requests it once
 * (a user gesture). Within a session it stays "granted" and refresh is silent.
 */
const DB_NAME = "asguard-mm";
const STORE = "excelHandles";
const VERSION = 1;

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function saveHandle(key: string, handle: FileSystemFileHandle): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(handle, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } finally {
    db.close();
  }
}

export async function loadHandle(key: string): Promise<FileSystemFileHandle | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    return await new Promise<FileSystemFileHandle | null>((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as FileSystemFileHandle) ?? null);
      req.onerror = () => resolve(null);
    });
  } finally {
    db.close();
  }
}

export async function clearHandle(key: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } finally {
    db.close();
  }
}

type PermissionHandle = {
  queryPermission?: (desc: { mode: "read" }) => Promise<PermissionState>;
  requestPermission?: (desc: { mode: "read" }) => Promise<PermissionState>;
};

/**
 * True if the handle can be read now, or can be granted via this user gesture.
 * (queryPermission/requestPermission are a Chromium extension not in TS lib, hence the cast.)
 */
export async function canRead(handle: FileSystemFileHandle): Promise<boolean> {
  const p = handle as unknown as PermissionHandle;
  if (!p.queryPermission) return true; // older API — assume readable
  try {
    if ((await p.queryPermission({ mode: "read" })) === "granted") return true;
    if (p.requestPermission) return (await p.requestPermission({ mode: "read" })) === "granted";
  } catch {
    return false;
  }
  return false;
}
