/**
 * Passing a result from one tool to the next, without a server.
 *
 * The site is a static multi-page app, so "Compress → Sign → Protect" means a
 * real navigation between documents, and a File cannot survive that in memory.
 * The usual answer — upload it and pass an id — is the one thing this product
 * does not do.
 *
 * IndexedDB can hold a Blob, is same-origin, and never touches the network, so
 * the bytes stay on the device exactly as they would if the person had saved
 * the file and re-picked it. Two rules keep that honest:
 *
 *   1. A handoff is deleted the moment it is claimed.
 *   2. Anything left behind — a closed tab, a back button — is purged after
 *      TTL_MS, and every open sweeps the store.
 *
 * Nothing is written unless someone clicks "continue with", so this never
 * stores a document on its own initiative.
 */

const DB = 'projectpdf-handoff';
const STORE = 'files';
const TTL_MS = 60 * 60 * 1000;

interface Stashed {
  key: string;
  name: string;
  type: string;
  blob: Blob;
  at: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = run(db.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Drops anything older than the TTL. Cheap, and runs on every open. */
async function sweep(db: IDBDatabase): Promise<void> {
  const all = await tx<Stashed[]>(db, 'readonly', (store) => store.getAll() as IDBRequest<Stashed[]>);
  const stale = all.filter((entry) => Date.now() - entry.at > TTL_MS);
  if (stale.length === 0) return;
  const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
  for (const entry of stale) store.delete(entry.key);
}

/** Returns a key the next page can claim the file with, or null if unavailable. */
export async function stash(file: File | Blob, name: string): Promise<string | null> {
  if (typeof indexedDB === 'undefined') return null;
  try {
    const db = await open();
    await sweep(db);
    const key = `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    await tx(db, 'readwrite', (store) =>
      store.put({ key, name, type: file.type || 'application/pdf', blob: file, at: Date.now() } satisfies Stashed)
    );
    db.close();
    return key;
  } catch {
    return null;
  }
}

/** Claims and immediately deletes a handoff. */
export async function claim(key: string): Promise<File | null> {
  if (typeof indexedDB === 'undefined') return null;
  try {
    const db = await open();
    await sweep(db);
    const entry = await tx<Stashed | undefined>(db, 'readonly', (store) => store.get(key) as IDBRequest<Stashed | undefined>);
    if (entry) await tx(db, 'readwrite', (store) => store.delete(key));
    db.close();
    if (!entry) return null;
    return new File([entry.blob], entry.name, { type: entry.type });
  } catch {
    return null;
  }
}

/** Removes every unclaimed local handoff when a person clears HatePDF data. */
export async function clearHandoffs(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('Could not clear local PDF handoffs.'));
    request.onblocked = () => reject(new Error('Close other HatePDF tabs, then try again.'));
  });
}
