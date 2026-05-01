# Ouroboros

> **Semi-decentralized, cryptographically signed, browser-native peer-to-peer database.**

Each node is a full replica. Data lives in the browser. The network heals itself.

```
Browser A             Relay (Node.js)       Browser B             Browser C
┌─────────────┐       ┌─────────────┐       ┌─────────────┐       ┌─────────────┐
│  IndexedDB  │◀─WS─▶ │   router    │◀─WS─▶ │  IndexedDB  │       │  IndexedDB  │
│  full copy  │       │  stateless  │       │  full copy  │ ◀─WS─▶│  full copy  │
└─────────────┘       └─────────────┘       └─────────────┘       └─────────────┘
      ▲                                             ▲                     ▲
      └────────────── every write replicates ───────┴─────────────────────┘
```

---

## Design

Ouroboros is built on three browser-native primitives — no external dependencies for the data layer:

**IndexedDB** — each node holds the complete operation log. Reads are local and synchronous from the application's perspective. Data survives page refreshes and browser restarts.

**WebSocket relay** — a stateless router. It holds no data. Its only job is to forward messages between peers and coordinate the initial sync handshake. It can go down without data loss; peers reconnect and catch up automatically.

**Web Crypto (Ed25519)** — every node generates a keypair on startup. Every write is signed with the node's private key. Every incoming operation is verified against the sender's public key before it touches storage. Invalid or unsigned operations are silently dropped.

---

## Sync protocol

```
Joiner                    Relay                     Peer A        Peer B
  │                         │                          │              │
  │──── SYNC_REQ(since) ───▶│                          │              │
  │                         │──── SYNC_PEER(since) ───▶│              │
  │                         │──── SYNC_PEER(since) ────────────────▶  │
  │                         │                          │              │
  │◀─── SYNC_REQ_FILLED ────│◀─── ops[] ────────────── │              │
  │   merge by op.id        │                          │              │
  │◀─── SYNC_REQ_FILLED ────│◀─── ops[] ────────────────────────────  │
  │   merge by op.id        │                          │              │
  │◀─── SYNC_COMPLETE ──────│  (all peers responded)   │              │
  │                         │                          │              │
```

The relay asks **every** connected peer simultaneously. Each peer responds independently. The joiner merges all incoming batches in a single IndexedDB transaction, deduplicating by `op.id`. No peer is a bottleneck — even if one peer is behind, the joiner receives the full log from the others.

If a peer disconnects mid-sync, the relay decrements its pending counter and sends `SYNC_COMPLETE` when the remaining peers finish. No joiner is left waiting.

---

## Storage schema

```
ObjectStore: "Operations"
  keyPath : id       UUID v4 — globally unique across all nodes
  index   : by_ts    ts (non-unique) — range scans for sync catchup
```

```js
{
    id:        "e3d4f1a2-...",     // keyPath
    ts:        1718000000000,      // Unix ms, indexed
    publicKey: "a3f8c2...",        // Ed25519 public key (hex)
    sig:       "9b2e47...",        // Ed25519 signature (hex) over body without sig
    // application payload:
    data:    { ... },
    signals: { ... },
}
```

UUID keyPath eliminates same-millisecond write collisions across nodes. The `by_ts` index makes `getAllOps(db, since)` an efficient range scan — not a full table scan.

`mergeOps(db, ops[])` performs batch upsert in a single transaction and skips ops whose `id` already exists — making sync idempotent regardless of how many peers send the same operation.

---

## Requirements

- Node.js ≥ 18
- npm

## Install

```bash
git clone https://github.com/daniilvedishchev/Ouroboros
cd Ouroboros
npm install
```

## Run

```bash
npm run relay            # WebSocket relay      → ws://localhost:8080
npm run relay:signaling  # WebRTC signaling     → ws://localhost:8081  (WIP)
```

---

## Usage

### Relay (Node.js)

```js
import { createRelayServer } from "ouroboros/relay";

const { wss, close } = createRelayServer(8080);
// close() shuts down gracefully
```

### Browser node

```js
import { openDB }               from "ouroboros/storage";
import { sync, shareOperation } from "ouroboros/sync";
import { createIdentity }       from "ouroboros/identity";

// Ed25519 keypair — generated fresh each session, or persist to localStorage
const identity = await createIdentity();
const db       = await openDB();

const ws = sync(db, identity, "ws://localhost:8080", {
    onConnect:    ()    => console.log("connected to relay"),
    onSynced:     ()    => console.log("caught up with the network"),
    onOperation:  (op)  => console.log("live op received:", op.id),
    onDisconnect: ()    => console.log("relay unreachable — local reads still work"),
    verify: true,       // reject ops with missing or invalid signatures
});

ws.addEventListener("open", async () => {
    const op = await shareOperation(ws, db, identity, {
        data:    { source: "node-a", symbols: ["BTC", "ETH"], timeframe: "1h" },
        signals: { entry: "RSI < 30", exit: "RSI > 70" },
    });
    // op = { id, ts, publicKey, sig, data, signals }
});
```

### WebRTC peer — direct, relay-free (WIP)

Once signaling is complete, peers communicate over RTCDataChannel — no relay hop.

```js
import { WebRTCPeer } from "./src/webrtc/webrtc.js";

const peer = new WebRTCPeer("room-id", "ws://localhost:8081", {
    onMessage:    (data, peerId) => console.log("direct:", peerId, data),
    onPeerJoined: (peerId)       => console.log("peer joined:", peerId),
    onPeerLeft:   (peerId)       => console.log("peer left:", peerId),
});

peer.broadcast({ type: "SHARE_OPERATION", payload: op });
peer.sendTo(peerId, { type: "ping" });
```

---

## Message protocol

| Message | Direction | Description |
|---|---|---|
| `SYNC_REQ` | client → relay | Connect handshake. Carries `since` (latest local `ts`). |
| `SYNC_PEER` | relay → **all** peers | Request history since `since` for a joiner. Sent in parallel. |
| `SYNC_REQ_FILLED` | peer → relay → joiner | One peer's history batch. Joiner merges by `op.id`. |
| `SYNC_COMPLETE` | relay → joiner | All peers have responded. Initial sync is finished. |
| `SHARE_OPERATION` | client → relay | Broadcast a signed op. |
| `SHARED_OPERATION` | relay → clients | Delivery of a peer's signed op. Verified before storage. |

---

## Module map

```
src/
├── index.js               public re-exports
├── relay/
│   ├── server.js          stateless WS relay — broadcast + multi-peer sync
│   └── signaling.js       WebRTC signaling — rooms, offer/answer/ICE forwarding
├── sync/
│   └── sync.js            sync protocol — parallel catch-up, dedup, sig verification
├── storage/
│   └── indexedDB.js       IndexedDB — UUID keyPath, ts index, mergeOps batch upsert
├── identity/
│   └── identity.js        Ed25519 — keygen, sign, verify (Web Crypto API)
├── messages/
│   └── messages.js        message type constants + signed envelope factory
└── webrtc/
    └── webrtc.js          WebRTC peer — RTCDataChannel management
examples/
├── start-relay.js
└── browser-node.js
```

---

## Exports

```js
import { createRelayServer }                              from "ouroboros/relay";
import { sync, shareOperation }                           from "ouroboros/sync";
import { createIdentity, signMessage, verifyMessage }     from "ouroboros/identity";
import { openDB, setData, getData,
         getLatestOp, getAllOps, mergeOps, hasOp }        from "ouroboros/storage";
import { makeMessage, MessageType }                       from "ouroboros/messages";
```

---

## Roadmap

- [x] UUID keyPath + `by_ts` index — no same-millisecond write collisions
- [x] Parallel multi-peer sync — every peer asked simultaneously, joiner deduplicates
- [x] Ed25519 signing on write, verification on receive — invalid ops dropped
- [ ] WebRTC data channels as sync transport — relay used for signaling only
- [ ] Conflict resolution — last-write-wins → CRDT (likely a vector clock approach)
- [ ] Query API — predicate filters, range scans, projections over `Operations`
- [ ] Persistent identity — keypair survives sessions via encrypted localStorage
- [ ] Payload encryption — ops encrypted at rest and in transit

---

## Why "semi-decentralized"

The data layer is fully decentralized — every peer holds a complete, independently readable replica. The relay is a stateless message router, not a database. It stores nothing. Losing it loses no data.

The remaining centralization is **peer discovery**: new nodes need a known relay address to find the network. The WebRTC layer (in progress) removes the relay from the data path entirely — after the initial handshake, peers sync directly over RTCDataChannel. True relay-free discovery (DHT or hardcoded bootstrap nodes) is the final step toward full decentralization.

---

## License

MIT
