// Read and write related artifacts as one IndexedDB transaction.
const DB_NAME = "fenceline";
const STORE = "artifacts";

async function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transact(mode, operation) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const result = {};
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error || new Error("Artifact transaction aborted"));
      tx.onerror = () => reject(tx.error || new Error("Artifact transaction failed"));
      try {
        operation(tx.objectStore(STORE), result);
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  } finally {
    db.close();
  }
}

export function readArtifacts(keys) {
  return transact("readonly", (store, result) => {
    for (const key of keys) {
      const request = store.get(key);
      request.onsuccess = () => {
        result[key] = request.result;
      };
    }
  });
}

export function writeArtifacts(values) {
  return transact("readwrite", (store) => {
    for (const [key, value] of Object.entries(values)) store.put(value, key);
  });
}
