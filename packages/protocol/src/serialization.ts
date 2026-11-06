/**
 * Serialization helpers — JSON encode / decode for KSA envelopes.
 *
 * These are intentionally thin: they wrap `JSON.stringify` /
 * `JSON.parse` and pipe through the validator. The wire format is
 * exactly the envelope shape documented in 开发手册.md § 20 — keys
 * in declaration order, no extra fields.
 *
 * The encoder returns a stable string (sorted keys) so deterministic
 * signatures / hashes work downstream.
 *
 *   jsonStringifyEnvelope(e) → string   (canonical JSON, validates)
 *   parseEnvelope(string)    → KsaMessage (validates)
 *   encodeEnvelope(e)        → string   (alias of jsonStringifyEnvelope)
 *   decodeEnvelope(string)   → KsaMessage (alias of parseEnvelope)
 *
 * Phase A / A2: the encoder now uses **RFC 8785 canonical JSON**
 * (`canonicalize`) rather than a hand-rolled sorted-key replacer, so
 * the bytes on the wire are exactly the bytes a signature is computed
 * over — and so that a future non-JavaScript peer has a single, precise
 * rule to implement.
 */
import type { KsaMessage } from './envelope';
import { canonicalize } from './canonical-json';
import { validateEnvelope } from './validation';

export function jsonStringifyEnvelope(envelope: KsaMessage): string {
  return canonicalize(envelope);
}

export function parseEnvelope(text: string): KsaMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Envelope JSON could not be parsed: ${message}`);
  }
  return validateEnvelope(parsed);
}

export const encodeEnvelope = jsonStringifyEnvelope;
export const decodeEnvelope = parseEnvelope;
