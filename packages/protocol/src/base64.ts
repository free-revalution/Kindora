/**
 * Base64 / Base64url helpers.
 *
 * Two alphabets are in play:
 *   - standard Base64 (`+/=`) — used for the existing `publicKey` /
 *     `privateKey` fields, which are WebCrypto SPKI / PKCS8 exports.
 *   - Base64url (`-_`, no padding) — used for everything new in the
 *     signed / encrypted wire format (signatures, digests, key ids,
 *     ciphertext) because it is URL-safe and needs no escaping inside
 *     JSON strings.
 *
 * `btoa` / `atob` are available in browsers, in the Tauri webview, in
 * jsdom and in Node 16+. They operate on "binary strings" (one char per
 * byte), so the conversion is explicit rather than `String.fromCharCode`
 * applied to the whole array at once — that would blow the call stack on
 * large inputs.
 */

/** Encode bytes as standard Base64 (with `=` padding). */
export function bytesToBase64(bytes: Uint8Array): string {
  return btoa(toBinaryString(bytes));
}

/** Decode standard Base64 (padding optional) to bytes. */
export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/** Encode bytes as unpadded Base64url. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode unpadded (or padded) Base64url to bytes. */
export function base64UrlToBytes(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const remainder = padded.length % 4;
  return base64ToBytes(remainder === 0 ? padded : padded + '='.repeat(4 - remainder));
}

function toBinaryString(bytes: Uint8Array): string {
  // Chunked so that a multi-megabyte buffer does not overflow the
  // argument list of `String.fromCharCode`.
  const CHUNK = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return binary;
}
