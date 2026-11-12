import type { Simulation } from './simulate.ts';

const DB_NAME = 'simulator.cache.v1';
const STORE_NAME = 'simulations';
const MAX_STORED_ENTRIES = 28;

interface StoredEntry {
  key: string;
  generationKey: string;
  savedAt: number;
  result: Simulation;
}

function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

function openCacheDb(): Promise<IDBDatabase | null> {
  if (!hasIndexedDb()) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function validSimulationShape(sim: unknown): sim is Simulation {
  if (!sim || typeof sim !== 'object') return false;
  const candidate = sim as Partial<Simulation>;
  return (
    Array.isArray(candidate.awayTotals) &&
    Array.isArray(candidate.homeTotals) &&
    Array.isArray(candidate.combinedTotals) &&
    candidate.playerDraws instanceof Map
  );
}

/**
 * Loads all persisted simulations matching the current `(input_hash, model_hash)` generation
 * into memory, and purges stale generations or excess entries in the background.
 */
export async function hydrateSimulationCache(
  generationKey: string,
  target: Map<string, Simulation>,
): Promise<number> {
  const db = await openCacheDb();
  if (!db) return 0;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      let loaded = 0;
      req.onsuccess = () => {
        const rows = Array.isArray(req.result) ? (req.result as StoredEntry[]) : [];
        const validCurrent: StoredEntry[] = [];
        for (const row of rows) {
          if (!row?.key || row.generationKey !== generationKey || !validSimulationShape(row.result)) {
            store.delete(row?.key);
            continue;
          }
          validCurrent.push(row);
        }
        validCurrent.sort((a, b) => a.savedAt - b.savedAt);
        while (validCurrent.length > MAX_STORED_ENTRIES) {
          const oldest = validCurrent.shift();
          if (oldest) store.delete(oldest.key);
        }
        for (const row of validCurrent) {
          if (!target.has(row.key)) {
            target.set(row.key, row.result);
            loaded += 1;
          }
        }
      };
      tx.oncomplete = () => {
        db.close();
        resolve(loaded);
      };
      tx.onerror = () => {
        db.close();
        resolve(loaded);
      };
      tx.onabort = () => {
        db.close();
        resolve(loaded);
      };
    } catch {
      db.close();
      resolve(0);
    }
  });
}

export async function persistSimulationEntry(
  key: string,
  generationKey: string,
  result: Simulation,
): Promise<void> {
  const db = await openCacheDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const entry: StoredEntry = { key, generationKey, savedAt: Date.now(), result };
      store.put(entry);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
      tx.onabort = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}
