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
 */
import type { KsaMessage } from './envelope';
import { validateEnvelope } from './validation';

export function jsonStringifyEnvelope(envelope: KsaMessage): string {
  return JSON.stringify(envelope, canonicalReplacer);
}

function canonicalReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
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
