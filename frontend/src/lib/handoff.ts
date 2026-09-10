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
 *   2. Anything left behind expires after TTL_MS. The next open removes it;
 *      a closed browser cannot run a background cleanup timer.
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
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = run(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error ?? new Error('Local file storage failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Local file storage was interrupted.'));
  });
}

/** Drops anything older than the TTL. Cheap, and runs on every open. */
async function sweep(db: IDBDatabase): Promise<void> {
  const all = await tx<Stashed[]>(db, 'readonly', (store) => store.getAll() as IDBRequest<Stashed[]>);
  const stale = all.filter((entry) => Date.now() - entry.at > TTL_MS);
  if (stale.length === 0) return;
  await tx(db, 'readwrite', (store) => {
    for (const entry of stale.slice(0, -1)) store.delete(entry.key);
    return store.delete(stale[stale.length - 1].key);
  });
}

/** Returns a key the next page can claim the file with, or null if unavailable. */
export async function stash(file: File | Blob, name: string): Promise<string | null> {
  if (typeof indexedDB === 'undefined') return null;
  let db: IDBDatabase | undefined;
  try {
    db = await open();
    await sweep(db);
    const key = `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    await tx(db, 'readwrite', (store) =>
      store.put({ key, name, type: file.type || 'application/pdf', blob: file, at: Date.now() } satisfies Stashed)
    );
    return key;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** Claims and immediately deletes a handoff. */
export async function claim(key: string): Promise<File | null> {
  if (typeof indexedDB === 'undefined') return null;
  let db: IDBDatabase | undefined;
  try {
    db = await open();
    await sweep(db);
    // Serialize read + delete together: two tabs must not claim the same PDF.
    const entry = await new Promise<Stashed | undefined>((resolve, reject) => {
      const transaction = db!.transaction(STORE, 'readwrite');
      const store = transaction.objectStore(STORE);
      const request = store.get(key) as IDBRequest<Stashed | undefined>;
      let found: Stashed | undefined;
      request.onsuccess = () => {
        const candidate = request.result;
        if (candidate && Date.now() - candidate.at <= TTL_MS) found = candidate;
        if (candidate) store.delete(key);
      };
      transaction.oncomplete = () => resolve(found);
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not open the local handoff.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('The local handoff was interrupted.'));
    });
    if (!entry) return null;
    return new File([entry.blob], entry.name, { type: entry.type });
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** Removes every unclaimed local handoff when a person clears Filozy data. */
export async function clearHandoffs(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('Could not clear local PDF handoffs.'));
    request.onblocked = () => reject(new Error('Close other Filozy tabs, then try again.'));
  });
}
