/**
 * ZoethraDB — WebSocket Relay Server
 *
 * Routes messages between peers and coordinates initial sync.
 *
 * Sync strategy: when a node joins, the relay asks ALL connected peers
 * for their history. Each peer responds independently. The relay forwards
 * every batch to the joiner, which merges by op.id (dedup). This way,
 * even if one peer is stale, the joiner still gets the full log.
 *
 * Message flow:
 *   SYNC_REQ         client → relay         "I joined, here is my latest timestamp"
 *   SYNC_PEER        relay → ALL peers      "New node joined — share history since ts"
 *   SYNC_REQ_FILLED  peer → relay → joiner  "Here are the ops I have since ts"
 *   SYNC_COMPLETE    relay → joiner          "All peers have responded"
 *   SHARE_OPERATION  client → relay → all   "New op — broadcast to everyone"
 *   SHARED_OPERATION relay → clients        "A peer wrote this op — store it"
 */

import { WebSocketServer } from "ws";
import crypto from "crypto";

const DEFAULT_PORT = 8080;

/**
 * Start the relay server.
 * @param {number} [port]
 * @returns {{ wss: WebSocketServer, close: () => void }}
 */
export function createRelayServer(port = DEFAULT_PORT) {
    const wss = new WebSocketServer({ port });

    /** @type {Map<string, import("ws").WebSocket>} peerId → socket */
    const clients = new Map();

    /**
     * @type {Map<string, { socket: import("ws").WebSocket, pending: number }>}
     * requesterId → { socket, pending count of peers still to respond }
     */
    const syncQueue = new Map();

    // ------------------------------------------------------------------ //
    // Helpers
    // ------------------------------------------------------------------ //

    function send(socket, payload) {
        if (socket.readyState === 1) {
            socket.send(JSON.stringify(payload));
        }
    }

    function broadcast(op, senderId) {
        for (const [id, socket] of clients) {
            if (id !== senderId) {
                send(socket, { type: "SHARED_OPERATION", payload: op });
            }
        }
    }

    /**
     * Ask EVERY connected peer (except requester) for history since `since`.
     * Returns how many peers were asked.
     */
    function requestSyncFromAll(requesterId, since) {
        let asked = 0;
        for (const [id, socket] of clients) {
            if (id !== requesterId) {
                send(socket, { type: "SYNC_PEER", for: requesterId, since });
                asked++;
            }
        }
        return asked;
    }

    function finishSync(requesterId) {
        const entry = syncQueue.get(requesterId);
        if (entry) {
            send(entry.socket, { type: "SYNC_COMPLETE" });
            syncQueue.delete(requesterId);
        }
    }

    // ------------------------------------------------------------------ //
    // Connection handling
    // ------------------------------------------------------------------ //

    wss.on("connection", (socket) => {
        const id = crypto.randomUUID();
        clients.set(id, socket);
        console.log(`[relay] +peer ${id.slice(0, 8)} (total: ${clients.size})`);

        socket.on("message", (raw) => {
            let msg;
            try { msg = JSON.parse(raw.toString()); }
            catch { return; }

            switch (msg.type) {

                case "SHARE_OPERATION":
                    broadcast(msg.payload, id);
                    break;

                case "SYNC_REQ": {
                    const since = msg.payload?.since ?? 0;
                    const asked = requestSyncFromAll(id, since);
                    if (asked === 0) {
                        // First node in the network — nothing to sync
                        send(socket, { type: "SYNC_COMPLETE" });
                    } else {
                        syncQueue.set(id, { socket, pending: asked });
                    }
                    break;
                }

                case "SYNC_REQ_FILLED": {
                    const entry = syncQueue.get(msg.for);
                    if (!entry) break;

                    // Forward this peer's batch directly to the joiner
                    send(entry.socket, { type: "SYNC_REQ_FILLED", payload: msg.payload });

                    entry.pending--;
                    if (entry.pending <= 0) finishSync(msg.for);
                    break;
                }

                default:
                    console.warn(`[relay] unknown message type: ${msg.type}`);
            }
        });

        socket.on("close", () => {
            clients.delete(id);

            // If this peer was supposed to respond to a joiner, decrement its count
            for (const [requesterId, entry] of syncQueue) {
                entry.pending--;
                if (entry.pending <= 0) finishSync(requesterId);
            }

            console.log(`[relay] -peer ${id.slice(0, 8)} (total: ${clients.size})`);
        });

        socket.on("error", (err) => {
            console.error(`[relay] socket error (${id.slice(0, 8)}):`, err.message);
        });
    });

    console.log(`[relay] listening on ws://localhost:${port}`);

    return {
        wss,
        close: () => wss.close(),
    };
}

// Run directly:  node src/relay/server.js [port]
if (process.argv[1] === new URL(import.meta.url).pathname) {
    const port = parseInt(process.env.PORT ?? process.argv[2] ?? DEFAULT_PORT, 10);
    createRelayServer(port);
}
