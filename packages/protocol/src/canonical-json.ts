/**
 * RFC 8785 — JSON Canonicalization Scheme (JCS).
 *
 * A signature scheme needs ONE canonical byte sequence per message, or the
 * two sides compute different digests. `JSON.stringify` is NOT enough:
 *   - object property order is insertion order, not sorted;
 *   - `JSON.stringify` calls `toJSON()` on objects, which JCS forbids
 *     (the JCS data model has no `toJSON`);
 *   - `undefined` handling inside objects vs. arrays differs between
 *     engines' histories.
 *
 * JCS fixes all of that:
 *   - object properties are sorted by their **UTF-16 code units** (the same
 *     ordering ECMAScript's `Array.prototype.sort()` uses for strings);
 *   - strings use JSON escaping with the short forms `\b \f \n \r \t` and
 *     `\u00xx` for the remaining C0 controls, and are otherwise emitted
 *     as UTF-8 (no `\uXXXX` escaping of non-ASCII);
 *   - numbers use the ECMAScript `Number::toString` algorithm, with `-0`
 *     serialized as `0`;
 *   - `undefined` object properties are omitted; `undefined` array
 *     elements become `null`;
 *   - there is no insignificant whitespace anywhere.
 *
 * No third-party dependency: JCS is a *serialization format*, not a
 * cryptographic algorithm, so implementing it here does not violate the
 * "use vetted crypto libraries" rule — and it keeps the supply chain
 * surface of the protocol package at zero.
 *
 * Cross-language caveat: both ends of KSA 0.1 are TypeScript (the Rust
 * side only moves opaque strings), so a JS-only implementation is safe
 * today. **If Rust ever starts parsing envelopes, it must implement this
 * exact function** or every signature will fail to verify.
 *
 * See RFC 8785, https://www.rfc-editor.org/rfc/rfc8785
 */

/** Raised when a value cannot be represented in the JCS data model. */
export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

/**
 * Serialize `value` to its RFC 8785 canonical form.
 *
 * Throws `CanonicalJsonError` for values outside the JCS data model
 * (`undefined` at the root, functions, symbols, `NaN`, `Infinity`).
 */
export function canonicalize(value: unknown): string {
  return serializeValue(value, '$');
}

/** Canonical JSON encoded as UTF-8 bytes — the form that gets hashed. */
export function canonicalizeToBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}

function serializeValue(value: unknown, path: string): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return serializeNumber(value, path);
    case 'string':
      // `JSON.stringify` on a string already implements the JCS string
      // rules exactly: the short escapes for the five special C0
      // controls, `\u00xx` for the rest, `\"` and `\\`, and (ES2019+)
      // well-formed output for lone surrogates.
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new CanonicalJsonError(
        `Cannot canonicalize a value of type "${typeof value}" at ${path}.`,
      );
  }

  if (Array.isArray(value)) {
    const items = value.map((item, index) =>
      // JCS: `undefined` (and `null`) array elements serialize as `null`.
      item === undefined ? 'null' : serializeValue(item, `${path}[${index}]`),
    );
    return `[${items.join(',')}]`;
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    // JCS omits properties whose value is `undefined` (JSON.stringify does
    // the same, but only because the replacer happens to see them).
    .filter((key) => obj[key] !== undefined)
    .sort(compareCodeUnits);
  const parts = keys.map(
    (key) => `${JSON.stringify(key)}:${serializeValue(obj[key], `${path}.${key}`)}`,
  );
  return `{${parts.join(',')}}`;
}

function serializeNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalJsonError(
      `Cannot canonicalize the non-finite number ${String(value)} at ${path}.`,
    );
  }
  // `String(-0)` is already "0", but the explicit branch documents that
  // JCS mandates it rather than relying on the ECMAScript detail.
  if (Object.is(value, -0)) return '0';
  return String(value);
}

/**
 * Compare two property names by UTF-16 code unit.
 *
 * This is the ordering ECMAScript's default `Array.prototype.sort()`
 * applies to strings, and the ordering RFC 8785 mandates. Note that it
 * differs from sorting by Unicode code point and from sorting by UTF-8
 * bytes for characters outside the Basic Multilingual Plane.
 */
function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
