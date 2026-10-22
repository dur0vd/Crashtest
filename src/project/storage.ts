import type { ProjectFile } from './model';
const DB = 'crashtest-projects-v1';
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('projects');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function transaction<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDB();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction('projects', mode);
      const r = fn(tx.objectStore('projects'));
      tx.oncomplete = () => resolve(r.result);
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
// One write queue prevents an older asynchronous autosave from resurrecting a deleted project.
let writes: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = writes.then(fn, fn);
  writes = next.catch(() => undefined);
  return next;
}
export function saveLocal(id: string, file: ProjectFile): Promise<IDBValidKey> {
  const snapshot = structuredClone(file);
  return enqueue(() => transaction('readwrite', (s) => s.put(snapshot, id)));
}
export async function loadLocal(id: string): Promise<ProjectFile | undefined> {
  await writes;
  return transaction('readonly', (s) => s.get(id));
}
export function deleteLocal(id: string): Promise<undefined> {
  return enqueue(() => transaction('readwrite', (s) => s.delete(id)));
}
