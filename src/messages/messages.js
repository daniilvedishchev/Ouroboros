/**
 * ZoethraDB — Message definitions and factory
 *
 * Works in both browser (Web Crypto) and Node.js 18+ (globalThis.crypto).
 *
 * @typedef {Object} Operation
 * @property {{ source: string, symbols: string[], timeframe: string, range: {from: string, to: string} }} data
 * @property {{ entry: string, exit: string }} signals
 *
 * @typedef {"SYNC_REQ"|"SHARE_OPERATION"|"SYNC_PEER"|"SYNC_REQ_FILLED"|"SHARED_OPERATION"} MsgType
 */

export const MessageType = Object.freeze({
    SYNC_REQ:        "SYNC_REQ",
    SHARE_OPERATION: "SHARE_OPERATION",
    SYNC_PEER:       "SYNC_PEER",
    SYNC_REQ_FILLED: "SYNC_REQ_FILLED",
    SHARED_OPERATION:"SHARED_OPERATION",
});

/**
 * Wrap a message payload in a signed envelope.
 *
 * @param {string} publicKey   Hex-encoded Ed25519 public key
 * @param {{ type: MsgType, payload: unknown }} msg
 * @param {string|null} [sig]  Optional hex-encoded signature
 * @returns {{ id: string, publicKey: string, ts: number, sig: string|null } & typeof msg}
 */
export function makeMessage(publicKey, msg, sig = null) {
    return {
        id:        globalThis.crypto.randomUUID(),
        publicKey,
        ts:        Date.now(),
        sig,
        ...msg,
    };
}
