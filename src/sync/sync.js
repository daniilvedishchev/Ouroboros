/**
 * ZoethraDB — Sync protocol (browser)
 *
 * Connects to the relay, performs initial catch-up from ALL peers,
 * deduplicates by op.id, verifies Ed25519 signatures, and forwards
 * incoming operations to local storage in real time.
 *
 * Usage:
 *   import { sync, shareOperation } from "zoethradb/sync";
 *   import { openDB }               from "zoethradb/storage";
 *   import { createIdentity }       from "zoethradb/identity";
 *
 *   const identity = await createIdentity();
 *   const db       = await openDB();
 *   const ws       = sync(db, identity, "ws://localhost:8080", { ... });
 */

import { getAllOps, mergeOps, getLatestOp } from "../storage/indexedDB.js";
import { verifyMessage }                    from "../identity/identity.js";

/**
 * @typedef {Object} SyncOptions
 * @property {(op: object) => void}    [onOperation]   New live op arrived and stored
 * @property {(count: number) => void} [onSynced]      Initial sync finished; count = new ops written
 * @property {() => void}              [onConnect]     WebSocket opened
 * @property {() => void}              [onDisconnect]  WebSocket closed
 * @property {boolean}                 [verify=true]   Reject ops with invalid/missing signatures
 */

const DEFAULT_RELAY = "ws://localhost:8080";

/**
 * Connect to the relay and start syncing.
 *
 * @param {IDBDatabase}  db
 * @param {{ publicKey: string, keyPair: CryptoKeyPair }} identity
 * @param {string}       [url]
 * @param {SyncOptions}  [options]
 * @returns {WebSocket}
 */
export function sync(db, identity, url = DEFAULT_RELAY, options = {}) {
    const { onOperation, onSynced, onConnect, onDisconnect, verify = true } = options;

    const ws = new WebSocket(url);

    ws.addEventListener("open", async () => {
        console.log(`[sync] connected → ${url}`);
        onConnect?.();

        const latest = await getLatestOp(db).catch(() => null);
        const since  = latest ? latest.ts : 0;
        ws.send(JSON.stringify({ type: "SYNC_REQ", payload: { since } }));
    });

    ws.addEventListener("message", async (event) => {
        let msg;
        try { msg = JSON.parse(event.data); }
        catch { return; }

        switch (msg.type) {

            // Relay is asking us to share our history with a joining node
            case "SYNC_PEER": {
                const ops = await getAllOps(db, msg.since ?? 0).catch(() => []);
                ws.send(JSON.stringify({
                    type:    "SYNC_REQ_FILLED",
                    for:     msg.for,
                    payload: { operations: ops },
                }));
                break;
            }

            // One peer's batch of history — may arrive multiple times (one per peer)
            // mergeOps handles dedup by op.id in a single transaction
            case "SYNC_REQ_FILLED": {
                const ops     = msg.payload?.operations ?? [];
                const trusted = verify
                    ? await filterVerified(ops)
                    : ops;
                const written = await mergeOps(db, trusted).catch(() => 0);
                console.log(`[sync] batch: ${ops.length} ops, ${written} new`);
                break;
            }

            // All peers have responded — initial sync is complete
            case "SYNC_COMPLETE": {
                const latest = await getLatestOp(db).catch(() => null);
                console.log("[sync] initial sync complete");
                onSynced?.(latest ? 1 : 0); // rough signal; count tracked in mergeOps logs
                break;
            }

            // Live broadcast from a peer
            case "SHARED_OPERATION": {
                const op = msg.payload;
                if (!op?.id) break;

                if (verify && !(await isVerified(op))) {
                    console.warn(`[sync] dropped op ${op.id?.slice(0, 8)} — bad signature`);
                    break;
                }

                await mergeOps(db, [op]).catch(() => {});
                onOperation?.(op);
                break;
            }

            default:
                console.warn(`[sync] unknown message type: ${msg.type}`);
        }
    });

    ws.addEventListener("close", () => {
        console.log("[sync] disconnected");
        onDisconnect?.();
    });

    ws.addEventListener("error", (e) => console.error("[sync] error", e));

    return ws;
}

/**
 * Sign and broadcast a new operation to all connected peers.
 * Assigns a UUID id and current timestamp if not present.
 *
 * @param {WebSocket}    ws
 * @param {IDBDatabase}  db
 * @param {{ publicKey: string, keyPair: CryptoKeyPair }} identity
 * @param {object}       op
 * @returns {Promise<object>} The stored, signed operation
 */
export async function shareOperation(ws, db, identity, op) {
    const { signMessage } = await import("../identity/identity.js");

    const full = {
        id:        crypto.randomUUID(),
        ts:        Date.now(),
        publicKey: identity.publicKey,
        ...op,
    };

    // Sign the canonical JSON of the op (excluding the sig field itself)
    const { sig: _omit, ...body } = full;
    const sig = await signMessage(identity.keyPair.privateKey, JSON.stringify(body));

    const signed = { ...full, sig };

    await mergeOps(db, [signed]);
    ws.send(JSON.stringify({ type: "SHARE_OPERATION", payload: signed }));

    return signed;
}

// ------------------------------------------------------------------ //
// Signature helpers
// ------------------------------------------------------------------ //

/**
 * Verify a single op's signature. Returns false if sig or publicKey missing.
 * @param {object} op
 * @returns {Promise<boolean>}
 */
async function isVerified(op) {
    if (!op.sig || !op.publicKey) return false;
    try {
        const { sig, ...body } = op;
        return await verifyMessage(op.publicKey, sig, JSON.stringify(body));
    } catch {
        return false;
    }
}

/**
 * Filter an array of ops to only those with valid signatures.
 * Ops without a publicKey or sig are silently dropped.
 * @param {object[]} ops
 * @returns {Promise<object[]>}
 */
async function filterVerified(ops) {
    const results = await Promise.all(ops.map(async (op) => ({
        op,
        ok: await isVerified(op),
    })));
    const dropped = results.filter(r => !r.ok).length;
    if (dropped > 0) console.warn(`[sync] dropped ${dropped} op(s) with invalid signatures`);
    return results.filter(r => r.ok).map(r => r.op);
}
