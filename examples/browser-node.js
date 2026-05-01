/**
 * Example: connect a browser node, sync, and share an operation.
 *
 * This file is a browser ESM snippet — it depends on IndexedDB, WebSocket,
 * and crypto.subtle. Import it via a bundler or <script type="module">.
 */

import { openDB }                  from "../src/storage/indexedDB.js";
import { sync, shareOperation }    from "../src/sync/sync.js";
import { createIdentity }          from "../src/identity/identity.js";

async function main() {
    // 1. Generate an Ed25519 identity for this node
    const identity = await createIdentity();
    console.log("[node] public key:", identity.publicKey);

    // 2. Open the local IndexedDB store
    const db = await openDB();

    // 3. Connect to the relay; sync completes when SYNC_COMPLETE arrives
    //    (i.e. after ALL peers have responded — not just the first one)
    const ws = sync(db, identity, "ws://localhost:8080", {
        onConnect:    ()      => console.log("[node] connected"),
        onSynced:     ()      => console.log("[node] initial sync complete"),
        onOperation:  (op)    => console.log("[node] live op received:", op.id),
        onDisconnect: ()      => console.log("[node] disconnected"),

        // Set to false to accept ops without verifying signatures (dev mode)
        verify: true,
    });

    // 4. Share an operation once connected
    ws.addEventListener("open", async () => {
        const op = await shareOperation(ws, db, identity, {
            data: {
                source:    "example-node",
                symbols:   ["BTC", "ETH"],
                timeframe: "1h",
                range:     { from: "2024-01-01", to: "2024-12-31" },
            },
            signals: { entry: "RSI < 30", exit: "RSI > 70" },
        });

        console.log("[node] op shared:", op.id);
        // op now has { id, ts, publicKey, sig, data, signals }
    });
}

main().catch(console.error);
