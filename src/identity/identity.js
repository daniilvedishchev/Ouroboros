/**
 * ZoethraDB — Node identity (browser, Web Crypto API)
 *
 * Each peer generates an Ed25519 key pair on startup.
 * The public key is attached to every outgoing message so peers can
 * later verify signatures when signature verification is implemented.
 *
 * @typedef {Object} Identity
 * @property {string}    publicKey   Hex-encoded Ed25519 public key
 * @property {string}    privateKey  Hex-encoded PKCS#8 private key
 * @property {CryptoKeyPair} keyPair Raw CryptoKeyPair (for sign/verify)
 */

const toHex = (buf) =>
    [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");

/**
 * Generate a new Ed25519 identity for this node.
 * @returns {Promise<Identity>}
 */
export async function createIdentity() {
    const keyPair = await crypto.subtle.generateKey(
        { name: "Ed25519" },
        true,
        ["sign", "verify"]
    );

    const [publicKeyBuf, privateKeyBuf] = await Promise.all([
        crypto.subtle.exportKey("raw",   keyPair.publicKey),
        crypto.subtle.exportKey("pkcs8", keyPair.privateKey),
    ]);

    return {
        publicKey:  toHex(publicKeyBuf),
        privateKey: toHex(privateKeyBuf),
        keyPair,
    };
}

/**
 * Sign a message string with the node's private key.
 * @param {CryptoKey} privateKey
 * @param {string}    message
 * @returns {Promise<string>} Hex-encoded signature
 */
export async function signMessage(privateKey, message) {
    const encoded = new TextEncoder().encode(message);
    const sigBuf  = await crypto.subtle.sign("Ed25519", privateKey, encoded);
    return toHex(sigBuf);
}

/**
 * Verify a signature against a public key.
 * @param {string} publicKeyHex  Hex-encoded public key
 * @param {string} signature     Hex-encoded signature
 * @param {string} message       Original message string
 * @returns {Promise<boolean>}
 */
export async function verifyMessage(publicKeyHex, signature, message) {
    const keyBuf  = Uint8Array.from(publicKeyHex.match(/.{2}/g).map(b => parseInt(b, 16)));
    const sigBuf  = Uint8Array.from(signature.match(/.{2}/g).map(b => parseInt(b, 16)));
    const encoded = new TextEncoder().encode(message);

    const publicKey = await crypto.subtle.importKey(
        "raw", keyBuf,
        { name: "Ed25519" },
        false,
        ["verify"]
    );

    return crypto.subtle.verify("Ed25519", publicKey, sigBuf, encoded);
}
