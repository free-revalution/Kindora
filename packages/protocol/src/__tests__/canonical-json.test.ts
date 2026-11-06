/**
 * RFC 8785 (JCS) canonicalization — the byte-level contract underneath
 * every KSA envelope signature (Phase A / A2).
 *
 * Two peers must hash *identical* bytes for the same logical message,
 * or the signature never verifies. `JSON.stringify` cannot be used for
 * that: it preserves insertion order, so two peers that build the same
 * payload with the keys in a different order would compute different
 * digests. JCS removes that freedom — the canonical form is a function
 * of the *value*, not of how the value was assembled.
 *
 * The reference vector is RFC 8785 § 3.2.3.
 *
 * See RFC 8785, https://www.rfc-editor.org/rfc/rfc8785
 */
import { describe, it, expect } from 'vitest';
import { canonicalize, canonicalizeToBytes, CanonicalJsonError } from '../canonical-json';

describe('canonicalize — RFC 8785 (JCS)', () => {
  it('matches the RFC 8785 § 3.2.3 reference vector', () => {
    // The RFC's input value.
    //
    // The string is spelled out character by character so the escapes
    // in the *expected* output below cannot be miscounted:
    //   €  $  U+000F  LF  A  '  B  "  \  \  "  /
    const rfcStringValue = '€$' + '\u000f' + '\n' + "A'B" + '"' + '\\' + '\\' + '"' + '/';

    const input = {
      numbers: [333333333.3333333, 1e30, 4.5, 0.002, 1e-27],
      string: rfcStringValue,
      literals: [null, true, false],
    };

    // The RFC's expected output, one field at a time:
    //
    //   {"literals":[null,true,false],
    //    "numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],
    //    "string":"€$\u000f\nA'B\"\\\\\"/"}
    //
    // The string field is JSON-escaped: U+000F -> \u000f, LF -> \n,
    // the double quote -> \", and each backslash -> \\.
    const expectedStringField = [
      '"€$', // opening quote, then the euro and the dollar sign
      '\\u000f', // the C0 control character
      '\\n', // the line feed
      "A'B",
      '\\"', // the double quote
      '\\\\', // the first backslash
      '\\\\', // the second backslash
      '\\"', // the double quote
      '/',
      '"', // closing quote
    ].join('');

    const expected =
      '{"literals":[null,true,false],' +
      '"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
      `"string":${expectedStringField}}`;

    expect(canonicalize(input)).toBe(expected);
  });

  it('sorts object properties, so key insertion order cannot change the bytes', () => {
    const a = { b: 1, a: 2, c: 3 };
    const b = { c: 3, a: 2, b: 1 };
    expect(canonicalize(a)).toBe('{"a":2,"b":1,"c":3}');
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(canonicalizeToBytes(a)).toEqual(canonicalizeToBytes(b));
  });

  it('sorts nested object properties too', () => {
    const value = { outer: { z: 1, a: { y: 2, b: 3 } } };
    expect(canonicalize(value)).toBe('{"outer":{"a":{"b":3,"y":2},"z":1}}');
  });

  it('sorts property names by UTF-16 code unit, not by code point', () => {
    // U+10000 is a surrogate pair (D800 DC00) and U+FF00 is a BMP
    // character. By code point, U+FF00 < U+10000. By UTF-16 code unit,
    // the high surrogate D800 sorts *before* FF00 — so U+10000 comes
    // first. RFC 8785 § 3.2.3 mandates the UTF-16 ordering, and this
    // is where a naive implementation gets it wrong.
    const value = { '\u{10000}': 1, '＀': 2 };
    expect(canonicalize(value)).toBe('{"𐀀":1,"＀":2}');
  });

  it('omits undefined object properties', () => {
    expect(canonicalize({ a: 1, b: undefined, c: 2 })).toBe('{"a":1,"c":2}');
  });

  it('turns undefined array elements into null', () => {
    expect(canonicalize([1, undefined, 3])).toBe('[1,null,3]');
    expect(canonicalize([undefined])).toBe('[null]');
  });

  it('serializes -0 as 0', () => {
    expect(canonicalize(-0)).toBe('0');
    expect(canonicalize({ a: -0 })).toBe('{"a":0}');
    expect(canonicalize([-0])).toBe('[0]');
  });

  it('uses the ECMAScript number-to-string form for every finite number', () => {
    expect(canonicalize(1e30)).toBe('1e+30');
    expect(canonicalize(1e-27)).toBe('1e-27');
    expect(canonicalize(4.5)).toBe('4.5');
    expect(canonicalize(0.002)).toBe('0.002');
    expect(canonicalize(333333333.3333333)).toBe('333333333.3333333');
    expect(canonicalize(1)).toBe('1');
    expect(canonicalize(-1)).toBe('-1');
  });

  it('escapes strings with the JSON rules, including the short control forms', () => {
    expect(canonicalize('a"b')).toBe('"a\\"b"');
    expect(canonicalize('a\\b')).toBe('"a\\\\b"');
    expect(canonicalize('\b\f\n\r\t')).toBe('"\\b\\f\\n\\r\\t"');
    expect(canonicalize('\u0000')).toBe('"\\u0000"');
    expect(canonicalize('\u001f')).toBe('"\\u001f"');
  });

  it('emits non-ASCII characters as UTF-8 rather than as \\u escapes', () => {
    expect(canonicalize('€')).toBe('"€"');
    expect(canonicalize('中文')).toBe('"中文"');
  });

  it('emits no insignificant whitespace', () => {
    expect(canonicalize({ a: [1, 2], b: { c: 3 } })).toBe('{"a":[1,2],"b":{"c":3}}');
  });

  it('handles the primitive types at the root', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(true)).toBe('true');
    expect(canonicalize(false)).toBe('false');
    expect(canonicalize('x')).toBe('"x"');
    expect(canonicalize(0)).toBe('0');
  });

  it('keeps empty containers distinct from an absent value', () => {
    expect(canonicalize({})).toBe('{}');
    expect(canonicalize([])).toBe('[]');
  });

  it('rejects values outside the JCS data model', () => {
    expect(() => canonicalize(NaN)).toThrow(CanonicalJsonError);
    expect(() => canonicalize(Infinity)).toThrow(CanonicalJsonError);
    expect(() => canonicalize(-Infinity)).toThrow(CanonicalJsonError);
    expect(() => canonicalize({ a: NaN })).toThrow(CanonicalJsonError);
    expect(() => canonicalize(undefined)).toThrow(CanonicalJsonError);
    expect(() => canonicalize(() => undefined)).toThrow(CanonicalJsonError);
    expect(() => canonicalize(Symbol('x'))).toThrow(CanonicalJsonError);
  });

  it('reports the path of the offending value', () => {
    expect(() => canonicalize({ a: { b: [1, NaN] } })).toThrow(/\$\.a\.b\[1\]/);
  });

  it('encodes the canonical form as UTF-8 bytes', () => {
    const bytes = canonicalizeToBytes('€');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(bytes)).toBe('"€"');
    expect(canonicalizeToBytes('€').length).toBe(5); // " + 3 UTF-8 bytes + "
  });

  it('is stable across repeated calls', () => {
    const value = { z: [1, { b: 2, a: 3 }], a: 'x' };
    const first = canonicalize(value);
    const second = canonicalize(value);
    expect(first).toBe(second);
    expect(canonicalize(JSON.parse(first))).toBe(first);
  });
});
