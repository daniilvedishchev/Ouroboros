# ZoethraDB

Peer-to-peer distributed database that runs in the browser. Each node stores its operation log locally in IndexedDB. Nodes sync through a minimal WebSocket relay — no central storage, no cloud dependency.

```
Browser A             Relay (Node.js)       Browser B
┌───────────┐         ┌───────────┐         ┌───────────┐
│ IndexedDB │◀──WS───▶│  router   │◀──WS───▶│ IndexedDB │
└───────────┘         └───────────┘         └───────────┘
```

## How it works

**Write** — A node signs an operation with its Ed25519 private key, writes it to local IndexedDB, and sends `SHARE_OPERATION` to the relay. The relay forwards it to all peers as `SHARED_OPERATION`. Receiving peers verify the signature before storing.

**Sync** — On connect, a node sends `SYNC_REQ` with its latest `ts`. The relay asks **every** connected peer for history since that timestamp. Each peer responds independently (`SYNC_REQ_FILLED`). The joiner merges all batches by `op.id` — deduplicating in a single IndexedDB transaction. When all peers have responded, the relay sends `SYNC_COMPLETE`.

**Identity** — Each node generates an Ed25519 key pair via Web Crypto on startup. Every operation is signed; every incoming operation is verified before being stored. Ops with a missing or invalid signature are dropped.

## Requirements

- Node.js ≥ 18
- npm

## Install

```bash
git clone https://github.com/your-username/ZoethraDB
cd ZoethraDB
npm install
```

## Run

```bash
# WebSocket relay (port 8080)
npm run relay

# WebRTC signaling server (port 8081) — optional, WIP
npm run relay:signaling
```

## Usage

### Start the relay programmatically

```js
import { createRelayServer } from "zoethradb/relay";

const { wss, close } = createRelayServer(8080);
```

### Connect a browser node

```js
import { openDB }               from "zoethradb/storage";
import { sync, shareOperation } from "zoethradb/sync";
import { createIdentity }       from "zoethradb/identity";

const identity = await createIdentity();
const db       = await openDB();

const ws = sync(db, identity, "ws://localhost:8080", {
    onConnect:    ()    => console.log("connected"),
    onSynced:     ()    => console.log("initial sync complete"),
    onOperation:  (op)  => console.log("live op:", op.id),
    onDisconnect: ()    => console.log("disconnected"),
    verify: true, // drop ops with missing/invalid signatures
});

ws.addEventListener("open", async () => {
    const op = await shareOperation(ws, db, identity, {
        data:    { source: "node-a", symbols: ["BTC"], timeframe: "1h" },
        signals: { entry: "RSI < 30", exit: "RSI > 70" },
    });
    // op = { id, ts, publicKey, sig, data, signals }
});
```

### WebRTC peer (direct, relay-free — WIP)

```js
import { WebRTCPeer } from "./src/webrtc/webrtc.js";

const peer = new WebRTCPeer("room-id", "ws://localhost:8081", {
    onMessage:    (data, peerId) => console.log(peerId, data),
    onPeerJoined: (peerId)       => console.log("joined:", peerId),
    onPeerLeft:   (peerId)       => console.log("left:", peerId),
});

peer.broadcast({ type: "ping" });
peer.sendTo(peerId, { type: "pong" });
```

## Message protocol

| Type | Direction | Description |
|---|---|---|
| `SYNC_REQ` | client → relay | Sent on connect. Carries `since` timestamp. |
| `SYNC_PEER` | relay → **all** peers | Ask every peer for history since `since`. |
| `SYNC_REQ_FILLED` | peer → relay → joiner | One peer's history batch. May arrive multiple times. |
| `SYNC_COMPLETE` | relay → joiner | All peers have responded. Sync is done. |
| `SHARE_OPERATION` | client → relay | Broadcast a signed op to all peers. |
| `SHARED_OPERATION` | relay → clients | Delivery of a peer's signed op. |

### Operation shape

```js
{
    id:        "uuid-v4",          // keyPath — globally unique, no collision
    ts:        1718000000000,      // Unix ms — indexed, used for sync range queries
    publicKey: "ed25519-hex",      // sender's public key
    sig:       "ed25519-sig-hex",  // signature over { id, ts, publicKey, ...payload }
    data:      { ... },            // application payload
    signals:   { ... },
}
```

## Storage schema

Operations are stored in IndexedDB object store `Operations`:

- **keyPath** `id` — UUID v4, globally unique, no collision between nodes writing at the same millisecond.
- **index** `by_ts` on `ts` — used for efficient range scans in `getAllOps(db, since)`.

Migration from v1 (ts keyPath) is handled automatically in `onupgradeneeded`.

## Project structure

```
src/
├── index.js               re-exports all public modules
├── relay/
│   ├── server.js          WebSocket relay — broadcast, multi-peer sync coordination
│   └── signaling.js       WebRTC signaling — room management, offer/answer/ICE
├── sync/
│   └── sync.js            sync protocol — multi-peer catch-up, dedup, sig verification
├── storage/
│   └── indexedDB.js       IndexedDB wrapper — UUID keyPath, ts index, mergeOps
├── identity/
│   └── identity.js        Ed25519 keygen, sign, verify (Web Crypto API)
├── messages/
│   └── messages.js        message type constants + envelope factory
└── webrtc/
    └── webrtc.js          WebRTC peer — data channels over signaling server
examples/
├── start-relay.js         start relay from CLI
└── browser-node.js        browser usage reference
```

## Exports

```js
import { createRelayServer }                                    from "zoethradb/relay";
import { sync, shareOperation }                                 from "zoethradb/sync";
import { createIdentity, signMessage, verifyMessage }           from "zoethradb/identity";
import { openDB, setData, getData, getLatestOp, getAllOps,
         mergeOps, hasOp }                                      from "zoethradb/storage";
import { makeMessage, MessageType }                             from "zoethradb/messages";
```

## Roadmap

- [x] UUID keyPath + `ts` index — no same-millisecond collisions
- [x] Multi-peer sync — relay asks all peers, joiner merges by `op.id`
- [x] Ed25519 signing on `shareOperation` + verification on receive
- [ ] WebRTC data channels as a sync transport (relay-free after handshake)
- [ ] Conflict resolution policy — last-write-wins → CRDT
- [ ] Richer query API — filters, ranges, projections over `Operations`
- [ ] Payload encryption

## License

MIT
