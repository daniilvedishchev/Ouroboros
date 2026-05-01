/**
 * ZoethraDB — WebRTC Signaling Server (Node.js)
 *
 * Handles room management and forwards WebRTC offer/answer/ICE messages
 * between peers so they can establish direct data channels.
 *
 * Message types  (client ↔ server):
 *   join        client → server   Join or create a room
 *   peers       server → client   List of peers already in the room
 *   peerJoined  server → peers    Notify existing peers of a newcomer
 *   peerLeft    server → peers    Notify peers of a departure
 *   offer       client → server → peer   WebRTC offer
 *   answer      client → server → peer   WebRTC answer
 *   signal      client → server → peer   ICE candidate
 *   leave       client → server   Explicit leave
 */

import { WebSocketServer } from "ws";
import crypto from "crypto";

const DEFAULT_PORT = 8081;

// ------------------------------------------------------------------ //
// RoomManager
// ------------------------------------------------------------------ //

class RoomManager {
    /** @param {number} maxParticipants */
    constructor(maxParticipants = 10) {
        this.maxParticipants = maxParticipants;
        /** @type {Map<string, Set<string>>} roomId → peerIds */
        this.rooms = new Map();
        /** @type {Map<string, string>} peerId → roomId */
        this.peerRoom = new Map();
    }

    isFull(roomId) {
        const peers = this.rooms.get(roomId);
        return peers ? peers.size >= this.maxParticipants : false;
    }

    ensureRoom(roomId) {
        if (!this.rooms.has(roomId)) this.rooms.set(roomId, new Set());
    }

    join(roomId, peerId) {
        if (!this.rooms.has(roomId) || this.isFull(roomId)) {
            roomId = this._firstAvailable() ?? roomId;
        }
        this.ensureRoom(roomId);
        this.rooms.get(roomId).add(peerId);
        this.peerRoom.set(peerId, roomId);
        return roomId;
    }

    leave(peerId) {
        const roomId = this.peerRoom.get(peerId);
        this.peerRoom.delete(peerId);
        if (roomId) {
            this.rooms.get(roomId)?.delete(peerId);
            if (this.rooms.get(roomId)?.size === 0) this.rooms.delete(roomId);
        }
        return roomId;
    }

    getPeers(roomId) {
        return this.rooms.get(roomId) ?? new Set();
    }

    _firstAvailable() {
        for (const [roomId] of this.rooms) {
            if (!this.isFull(roomId)) return roomId;
        }
        const id = crypto.randomUUID();
        this.ensureRoom(id);
        return id;
    }
}

// ------------------------------------------------------------------ //
// Signaling Server
// ------------------------------------------------------------------ //

/**
 * Start the signaling server.
 * @param {number} [port]
 * @returns {{ wss: WebSocketServer, close: () => void }}
 */
export function createSignalingServer(port = DEFAULT_PORT) {
    const wss = new WebSocketServer({ port });
    const roomManager = new RoomManager();

    /** @type {Map<string, import("ws").WebSocket>} peerId → socket */
    const clients = new Map();

    function send(socket, payload) {
        if (socket?.readyState === 1) socket.send(JSON.stringify(payload));
    }

    function notifyPeers(peerId, roomId, type) {
        for (const neighbour of roomManager.getPeers(roomId)) {
            if (neighbour !== peerId) {
                send(clients.get(neighbour), { type, payload: { peer: peerId } });
            }
        }
    }

    wss.on("connection", (socket) => {
        const peerId = crypto.randomUUID();
        clients.set(peerId, socket);
        console.log(`[signaling] +peer ${peerId.slice(0, 8)}`);

        socket.on("message", (raw) => {
            let msg;
            try { msg = JSON.parse(raw.toString()); }
            catch { return; }

            switch (msg.type) {
                case "join": {
                    const peers = roomManager.getPeers(msg.payload.roomId);
                    send(socket, { type: "peers", payload: { peers: [...peers] } });
                    notifyPeers(peerId, msg.payload.roomId, "peerJoined");
                    roomManager.join(msg.payload.roomId, peerId);
                    break;
                }
                case "offer":
                case "answer": {
                    const target = clients.get(msg.payload.for);
                    send(target, { ...msg, payload: { ...msg.payload, from: peerId } });
                    break;
                }
                case "signal": {
                    const target = clients.get(msg.payload.to);
                    send(target, { ...msg, payload: { ...msg.payload, data: { ...msg.payload.data, from: peerId } } });
                    break;
                }
                case "leave": {
                    const leftRoom = roomManager.leave(peerId);
                    if (leftRoom) notifyPeers(peerId, leftRoom, "peerLeft");
                    break;
                }
                default:
                    console.warn(`[signaling] unknown type: ${msg.type}`);
            }
        });

        socket.on("close", () => {
            const leftRoom = roomManager.leave(peerId);
            if (leftRoom) notifyPeers(peerId, leftRoom, "peerLeft");
            clients.delete(peerId);
            console.log(`[signaling] -peer ${peerId.slice(0, 8)}`);
        });

        socket.on("error", (err) => {
            console.error(`[signaling] error (${peerId.slice(0, 8)}):`, err.message);
        });
    });

    console.log(`[signaling] listening on ws://localhost:${port}`);
    return { wss, close: () => wss.close() };
}

// ------------------------------------------------------------------ //
// Run directly:  node src/relay/signaling.js [port]
// ------------------------------------------------------------------ //

if (process.argv[1] === new URL(import.meta.url).pathname) {
    const port = parseInt(process.env.SIGNALING_PORT ?? process.argv[2] ?? DEFAULT_PORT, 10);
    createSignalingServer(port);
}
