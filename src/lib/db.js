// Minimal IndexedDB wrapper for the meetings library.
const DB_NAME = 'openworld-minutes';
const STORE = 'meetings';

let dbPromise;
function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const s = db.createObjectStore(STORE, { keyPath: 'id' });
          s.createIndex('createdAt', 'createdAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const req = fn(store);
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}


export const db = {
  async list() {
    const all = await tx('readonly', (s) => s.getAll());
    // Library view does not need audio blobs in memory.
    return (all || []).map(({ audio, ...rest }) => ({ ...rest, hasAudio: !!audio })).sort((a, b) => b.createdAt - a.createdAt);
  },
  get(id) {
    return tx('readonly', (s) => s.get(id));
  },
  put(meeting) {
    return tx('readwrite', (s) => s.put(meeting));
  },
  async update(id, patch) {
    const m = await this.get(id);
    if (!m) return null;
    const next = { ...m, ...patch, updatedAt: Date.now() };
    await this.put(next);
    return next;
  },
  delete(id) {
    return tx('readwrite', (s) => s.delete(id));
  },
};

export function newId() {
  return (crypto.randomUUID && crypto.randomUUID()) || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
