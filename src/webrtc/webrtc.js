/**
 * ZoethraDB — WebRTC peer layer (browser)
 *
 * Establishes direct data channels between peers using the signaling server.
 * Works alongside the relay; once channels are open, sync can flow peer-to-peer.
 *
 * Usage:
 *   import { WebRTCPeer } from "zoethradb/webrtc";
 *
 *   const peer = new WebRTCPeer("my-room", "ws://localhost:8081", {
 *     onMessage: (data, fromPeerId) => console.log(fromPeerId, data),
 *   });
 */

const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

/**
 * @typedef {Object} WebRTCOptions
 * @property {(data: object, peerId: string) => void} [onMessage]   Incoming data channel message
 * @property {(peerId: string) => void}               [onPeerJoined]
 * @property {(peerId: string) => void}               [onPeerLeft]
 */

export class WebRTCPeer {
    /**
     * @param {string}        roomId
     * @param {string}        signalingUrl  WebSocket URL of the signaling server
     * @param {WebRTCOptions} [options]
     */
    constructor(roomId, signalingUrl, options = {}) {
        this.options = options;

        /** @type {Map<string, RTCPeerConnection>} */
        this.peerConnections = new Map();
        /** @type {Map<string, RTCDataChannel>} */
        this.dataChannels = new Map();
        /** @type {Set<string>} */
        this.knownPeers = new Set();

        this._ws = new WebSocket(signalingUrl);
        this._setupSignaling(roomId);
    }

    // ---------------------------------------------------------------- //
    // Public API
    // ---------------------------------------------------------------- //

    /**
     * Send data to all connected peers.
     * @param {object} data
     */
    broadcast(data) {
        const raw = JSON.stringify(data);
        for (const channel of this.dataChannels.values()) {
            if (channel.readyState === "open") channel.send(raw);
        }
    }

    /**
     * Send data to a specific peer.
     * @param {string} peerId
     * @param {object} data
     */
    sendTo(peerId, data) {
        const channel = this.dataChannels.get(peerId);
        if (channel?.readyState === "open") channel.send(JSON.stringify(data));
    }

    close() {
        for (const pc of this.peerConnections.values()) pc.close();
        this._ws.close();
    }

    // ---------------------------------------------------------------- //
    // Signaling
    // ---------------------------------------------------------------- //

    _setupSignaling(roomId) {
        this._ws.addEventListener("open", () => {
            this._send({ type: "join", payload: { roomId } });
        });

        this._ws.addEventListener("message", (event) => {
            let msg;
            try { msg = JSON.parse(event.data); }
            catch { return; }
            this._handleSignal(msg);
        });
    }

    async _handleSignal(msg) {
        switch (msg.type) {
            case "peers":
                this.knownPeers = new Set(msg.payload.peers);
                this._initPeerConnections();
                break;

            case "peerJoined": {
                const peerId = msg.payload.peer;
                this.knownPeers.add(peerId);
                this._initPeerConnections();
                await this._createOffer(peerId);
                this.options.onPeerJoined?.(peerId);
                break;
            }

            case "offer": {
                const { offer, from } = msg.payload;
                if (!from) return;
                this._ensurePC(from);
                await this.peerConnections.get(from).setRemoteDescription(offer);
                const answer = await this.peerConnections.get(from).createAnswer();
                await this.peerConnections.get(from).setLocalDescription(answer);
                this._send({ type: "answer", payload: { answer, for: from } });
                break;
            }

            case "answer": {
                const { answer, from } = msg.payload;
                if (from) await this.peerConnections.get(from)?.setRemoteDescription(answer);
                break;
            }

            case "signal": {
                const { candidate, from } = msg.payload.data;
                if (from && candidate) {
                    await this.peerConnections.get(from)?.addIceCandidate(candidate);
                }
                break;
            }

            case "peerLeft": {
                const peerId = msg.payload.peer;
                this._removePeer(peerId);
                this.options.onPeerLeft?.(peerId);
                break;
            }
        }
    }

    // ---------------------------------------------------------------- //
    // Peer connection helpers
    // ---------------------------------------------------------------- //

    _initPeerConnections() {
        for (const peerId of this.knownPeers) {
            if (!this.peerConnections.has(peerId)) this._ensurePC(peerId);
        }
    }

    _ensurePC(peerId) {
        if (this.peerConnections.has(peerId)) return;

        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        this.peerConnections.set(peerId, pc);

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this._send({ type: "signal", payload: { to: peerId, data: { candidate: event.candidate } } });
            }
        };

        pc.ondatachannel = (event) => {
            this._attachChannel(event.channel, peerId);
        };
    }

    async _createOffer(peerId) {
        this._ensurePC(peerId);
        const pc      = this.peerConnections.get(peerId);
        const channel = pc.createDataChannel("zoethradb");
        this._attachChannel(channel, peerId);

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this._send({ type: "offer", payload: { offer, for: peerId } });
    }

    _attachChannel(channel, peerId) {
        this.dataChannels.set(peerId, channel);

        channel.onopen    = () => console.log(`[webrtc] channel open ↔ ${peerId.slice(0, 8)}`);
        channel.onclose   = () => console.log(`[webrtc] channel closed ↔ ${peerId.slice(0, 8)}`);
        channel.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.options.onMessage?.(data, peerId);
            } catch {
                console.warn("[webrtc] non-JSON message received");
            }
        };
    }

    _removePeer(peerId) {
        this.peerConnections.get(peerId)?.close();
        this.peerConnections.delete(peerId);
        this.dataChannels.get(peerId)?.close();
        this.dataChannels.delete(peerId);
        this.knownPeers.delete(peerId);
    }

    _send(payload) {
        if (this._ws.readyState === WebSocket.OPEN) {
            this._ws.send(JSON.stringify(payload));
        }
    }
}
