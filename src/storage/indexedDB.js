/**
 * ZoethraDB — IndexedDB storage layer (browser)
 *
 * Each node persists its full operation log locally.
 *
 * Schema (v2):
 *   keyPath : "id"  (UUID v4 — globally unique, no collision between nodes)
 *   index   : "ts"  (Unix ms — used for sync catchup queries)
 *
 * Migration from v1 (ts keyPath) is handled in onupgradeneeded.
 */

const DB_NAME        = "ZOETHRADB";
const DB_VERSION     = 2;
const STORE_OPS      = "Operations";
const INDEX_TS       = "by_ts";

// ------------------------------------------------------------------ //
// Open / upgrade
// ------------------------------------------------------------------ //

/**
 * Open (or create) the local database.
 * @returns {Promise<IDBDatabase>}
 */
export function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);

        req.onupgradeneeded = (event) => {
            const db      = event.target.result;
            const oldVer  = event.oldVersion;

            // v1 → v2: drop ts-keyed store, create id-keyed store with ts index
            if (oldVer < 2 && db.objectStoreNames.contains(STORE_OPS)) {
                db.deleteObjectStore(STORE_OPS);
            }

            if (!db.objectStoreNames.contains(STORE_OPS)) {
                const store = db.createObjectStore(STORE_OPS, { keyPath: "id" });
                store.createIndex(INDEX_TS, "ts", { unique: false });
            }
        };

        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror   = (e) => reject(e.target.error);
    });
}

// ------------------------------------------------------------------ //
// Read
// ------------------------------------------------------------------ //

/**
 * Get the most-recent operation by ts.
 * @param {IDBDatabase} db
 * @returns {Promise<object|null>}
 */
export function getLatestOp(db) {
    return new Promise((resolve, reject) => {
        const store = db
            .transaction(STORE_OPS, "readonly")
            .objectStore(STORE_OPS);
        const req = store.index(INDEX_TS).openCursor(null, "prev");
        req.onsuccess = () => resolve(req.result ? req.result.value : null);
        req.onerror   = () => reject(req.error);
    });
}

/**
 * Get all operations with ts > since.
 * Uses the ts index for an efficient range scan — no full table scan.
 * @param {IDBDatabase} db
 * @param {number} [since=0]
 * @returns {Promise<object[]>}
 */
export function getAllOps(db, since = 0) {
    return new Promise((resolve, reject) => {
        const range = IDBKeyRange.lowerBound(since, true); // exclusive
        const req   = db
            .transaction(STORE_OPS, "readonly")
            .objectStore(STORE_OPS)
            .index(INDEX_TS)
            .getAll(range);
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror   = (e) => reject(e.target.error);
    });
}

/**
 * Get all records from any named store (generic helper).
 * @param {IDBDatabase} db
 * @param {string} storeName
 * @returns {Promise<object[]>}
 */
export function getData(db, storeName) {
    return new Promise((resolve, reject) => {
        const req = db
            .transaction(storeName, "readonly")
            .objectStore(storeName)
            .getAll();
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror   = (e) => reject(e.target.error);
    });
}

/**
 * Check whether an operation with this id already exists.
 * @param {IDBDatabase} db
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export function hasOp(db, id) {
    return new Promise((resolve, reject) => {
        const req = db
            .transaction(STORE_OPS, "readonly")
            .objectStore(STORE_OPS)
            .count(id);
        req.onsuccess = (e) => resolve(e.target.result > 0);
        req.onerror   = (e) => reject(e.target.error);
    });
}

// ------------------------------------------------------------------ //
// Write
// ------------------------------------------------------------------ //

/**
 * Write (upsert) a record. Idempotent — safe to call with duplicate ops.
 * @param {IDBDatabase} db
 * @param {object} data   Must have { id: string, ts: number, ... }
 * @param {string} [storeName]
 * @returns {Promise<IDBValidKey>}
 */
export function setData(db, data, storeName = STORE_OPS) {
    return new Promise((resolve, reject) => {
        const req = db
            .transaction(storeName, "readwrite")
            .objectStore(storeName)
            .put(data);
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror   = (e) => reject(e.target.error);
    });
}

/**
 * Write multiple ops in a single transaction.
 * Skips ops whose id already exists (idempotent merge).
 * @param {IDBDatabase} db
 * @param {object[]} ops
 * @returns {Promise<number>} count of newly written ops
 */
export function mergeOps(db, ops) {
    return new Promise((resolve, reject) => {
        const tx    = db.transaction(STORE_OPS, "readwrite");
        const store = tx.objectStore(STORE_OPS);
        let written = 0;

        tx.onerror    = (e) => reject(e.target.error);
        tx.oncomplete = () => resolve(written);

        for (const op of ops) {
            const check = store.count(op.id);
            check.onsuccess = () => {
                if (check.result === 0) {
                    store.put(op);
                    written++;
                }
            };
        }
    });
}
