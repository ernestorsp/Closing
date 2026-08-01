const DEFAULT_DB = 'aaxi-closing-offline-v1';
const STORE = 'operations';

function openDatabase(name = DEFAULT_DB) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
        store.createIndex('state', 'state');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transaction(db, mode, callback) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let result;
    try { result = callback(store); } catch (error) { reject(error); return; }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted.'));
  });
}

export class OfflineOperationQueue {
  constructor({ dbName = DEFAULT_DB, maxAttempts = 8 } = {}) {
    this.dbName = dbName;
    this.maxAttempts = maxAttempts;
    this.processing = false;
  }

  async add(type, payload, { id = crypto.randomUUID() } = {}) {
    const db = await openDatabase(this.dbName);
    const operation = {
      id, type, payload, state: 'Pending', attempts: 0,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      lastError: null
    };
    await transaction(db, 'readwrite', store => store.put(operation));
    db.close();
    return operation;
  }

  async list() {
    const db = await openDatabase(this.dbName);
    const rows = await new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  async remove(id) {
    const db = await openDatabase(this.dbName);
    await transaction(db, 'readwrite', store => store.delete(id));
    db.close();
  }

  async update(operation) {
    const db = await openDatabase(this.dbName);
    await transaction(db, 'readwrite', store => store.put({ ...operation, updatedAt: new Date().toISOString() }));
    db.close();
  }

  async process(handlers) {
    if (this.processing || !navigator.onLine) return;
    this.processing = true;
    try {
      const operations = await this.list();
      for (const operation of operations) {
        const handler = handlers[operation.type];
        if (!handler) continue;
        try {
          operation.state = 'Uploading';
          await this.update(operation);
          await handler(operation.payload, operation);
          await this.remove(operation.id);
        } catch (error) {
          operation.attempts += 1;
          operation.lastError = { code: error?.code || 'UNKNOWN', message: error?.message || String(error) };
          operation.state = operation.attempts >= this.maxAttempts ? 'NeedsAttention' : 'Pending';
          await this.update(operation);
          if (operation.state === 'NeedsAttention') continue;
          const retryable = !['INVALID_ARGUMENT', 'USER_DISABLED', 'ADMIN_REQUIRED'].includes(error?.code);
          if (!retryable) {
            operation.state = 'NeedsAttention';
            await this.update(operation);
          }
        }
      }
    } finally {
      this.processing = false;
    }
  }

  installAutoSync(handlers) {
    const sync = () => this.process(handlers).catch(console.error);
    window.addEventListener('online', sync);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') sync();
    });
    return sync;
  }
}
