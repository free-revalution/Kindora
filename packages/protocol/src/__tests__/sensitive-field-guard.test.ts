/**
 * Tests for @kindora/protocol/sensitive-field-guard — Phase 11, hardened
 * in Phase F1.
 *
 * Two of the Phase 11 tests asserted the *defect* (a long string is
 * skipped, a deep structure is skipped). The task book requires the
 * opposite — "超长、超深或无法验证的数据不得静默通过安全过滤" — so those
 * two assertions were **corrected**, not deleted. Everything else in
 * this file is unchanged, plus the new Phase F1 cases.
 */
import { describe, it, expect } from 'vitest';
import {
  assertNoSensitiveFields,
  formatSensitiveFieldError,
  SensitiveFieldError,
  type SensitiveFieldReason,
} from '../sensitive-field-guard';

/** Run the guard and return the refusal reason, or null when it passed. */
function refusalReason(
  value: unknown,
  options?: Parameters<typeof assertNoSensitiveFields>[1],
): SensitiveFieldReason | null {
  try {
    assertNoSensitiveFields(value, options);
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(SensitiveFieldError);
    return (e as SensitiveFieldError).reason;
  }
}

describe('@kindora/protocol — assertNoSensitiveFields', () => {
  it('passes a plain chat_message payload', () => {
    expect(() =>
      assertNoSensitiveFields({
        messageId: 'm1',
        type: 'chat_message',
        sender: 'a',
        timestamp: '2026-01-01T00:00:00.000Z',
        payload: { text: 'Hello, how are you?' },
      }),
    ).not.toThrow();
  });

  it('rejects apiKey as a field name', () => {
    expect(() => assertNoSensitiveFields({ token: 'whatever' })).toThrow(SensitiveFieldError);
    try {
      assertNoSensitiveFields({ apiKey: 'not a real key' });
    } catch (e) {
      expect((e as SensitiveFieldError).reason).toBe('forbidden-field-name');
      expect((e as SensitiveFieldError).path).toBe('$.apiKey');
    }
  });

  it('rejects forbidden nested field names', () => {
    expect(() => assertNoSensitiveFields({ profile: { nickname: 'Sam', secret: 'shh' } })).toThrow(
      /secret/,
    );
  });

  it('rejects forbidden field names inside array elements', () => {
    expect(() => assertNoSensitiveFields({ items: [{ api_key: 'oops' }] })).toThrow(/api_key/);
  });

  it('rejects PEM private key blocks', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAK...';
    try {
      assertNoSensitiveFields({ profile: { publicKey: pem } });
    } catch (e) {
      expect((e as SensitiveFieldError).reason).toBe('forbidden-value-pattern');
    }
  });

  it('rejects OpenAI-style sk-... tokens', () => {
    try {
      assertNoSensitiveFields({ note: 'my key is sk-abcdefghijklmnopqrstuvwxyz0123' });
    } catch (e) {
      expect((e as SensitiveFieldError).reason).toBe('forbidden-value-pattern');
    }
  });

  it('rejects GitHub personal access tokens', () => {
    try {
      assertNoSensitiveFields({ bio: 'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789' });
    } catch (e) {
      expect((e as SensitiveFieldError).reason).toBe('forbidden-value-pattern');
    }
  });

  it('rejects AWS access keys', () => {
    try {
      assertNoSensitiveFields({ note: 'AKIAIOSFODNN7EXAMPLE' });
    } catch (e) {
      expect((e as SensitiveFieldError).reason).toBe('forbidden-value-pattern');
    }
  });

  it('rejects Bearer tokens (case-insensitive)', () => {
    try {
      assertNoSensitiveFields({ note: 'Authorization: Bearer abcdefghijklmnopqrstuv' });
    } catch (e) {
      expect((e as SensitiveFieldError).reason).toBe('forbidden-value-pattern');
    }
  });

  it('does not flag short strings that resemble key fragments', () => {
    expect(() => assertNoSensitiveFields({ nickname: 'sk-12' })).not.toThrow();
  });

  it('handles null and undefined gracefully', () => {
    expect(() => assertNoSensitiveFields(null)).not.toThrow();
    expect(() => assertNoSensitiveFields(undefined)).not.toThrow();
    expect(() => assertNoSensitiveFields({ a: null, b: undefined })).not.toThrow();
  });

  it('formatSensitiveFieldError returns a generic message — never the offending value', () => {
    try {
      assertNoSensitiveFields({ apiKey: 'sk-abcdefghijklmnopqrstuvwxyz0123456789' });
    } catch (e) {
      const msg = formatSensitiveFieldError(e as SensitiveFieldError);
      expect(msg).toMatch(/Refused/);
      expect(msg).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123456789');
      expect(msg).not.toContain('abcdefghijklmnopqrstuvwxyz');
    }
  });

  /* ---------------------------------------------------------------- */
  /* Phase F1 — the three holes Phase 11 left open                     */
  /* ---------------------------------------------------------------- */

  it('REFUSES a structure nested deeper than maxDepth instead of skipping it', () => {
    // Phase 11 asserted `not.toThrow()` here — i.e. it asserted the
    // defect. Task book Phase F1: "超过最大深度时不能静默放行" and
    // "无法验证的数据应拒绝，而不是默认通过". The assertion is
    // therefore inverted, and the *reason* is asserted too.
    let nested: unknown = { leaf: 'plain text' };
    for (let i = 0; i < 10; i++) {
      nested = { next: nested };
    }
    expect(refusalReason(nested)).toBe('max-depth-exceeded');
  });

  it('SCANS a string longer than the scan window instead of skipping it', () => {
    // Phase 11 asserted `not.toThrow()` here — i.e. it asserted the
    // defect. A long string is now scanned in overlapping chunks, so
    // the credential at its head is still found.
    const long = 'sk-' + 'a'.repeat(10_000);
    expect(refusalReason({ payload: { text: long } }, { maxStringLength: 1000 })).toBe(
      'forbidden-value-pattern',
    );
  });

  it('finds a credential that straddles a chunk boundary', () => {
    // The scan window is 200 chars plus a 128-char overlap. The
    // credential starts 313 chars in, so the first window sees only
    // `sk-` plus 15 characters — one short of the pattern's minimum —
    // and it is the *second* window (thanks to the overlap) that sees
    // the whole thing.
    const chunk = 200;
    const key = 'sk-' + 'b'.repeat(40);
    const padding = '.'.repeat(313);
    expect(refusalReason({ text: padding + key }, { maxStringLength: chunk })).toBe(
      'forbidden-value-pattern',
    );
  });

  /* ---------------------------------------------------------------- */
  /* Phase F1 — task book F1 test cases                                 */
  /* ---------------------------------------------------------------- */

  it('F1 case: a common API key is refused', () => {
    expect(refusalReason({ note: 'sk-abcdefghijklmnopqrstuvwxyz0123' })).toBe(
      'forbidden-value-pattern',
    );
  });

  it('F1 case: an Authorization field is refused — by name and by value', () => {
    expect(refusalReason({ authorization: 'Bearer abcdefghijklmnopqrstuv' })).toBe(
      'forbidden-field-name',
    );
    expect(refusalReason({ headers: { Authorization: 'Bearer abcdefghijklmnopqrstuv' } })).toBe(
      'forbidden-field-name',
    );
    expect(refusalReason({ note: 'Authorization: Bearer abcdefghijklmnopqrstuv' })).toBe(
      'forbidden-value-pattern',
    );
  });

  it('F1 case: a password field is refused', () => {
    expect(refusalReason({ password: 'hunter2' })).toBe('forbidden-field-name');
    expect(refusalReason({ profile: { credentials: { password: 'hunter2' } } })).toBe(
      'forbidden-field-name',
    );
  });

  it('F1 case: a privateKey field is refused', () => {
    expect(refusalReason({ privateKey: 'abc' })).toBe('forbidden-field-name');
    expect(refusalReason({ agent: { private_key: 'abc' } })).toBe('forbidden-field-name');
    expect(refusalReason({ 'x-private-key': 'abc' })).toBe('forbidden-field-name');
  });

  it('F1 case: casing and separator variants of a sensitive name are refused', () => {
    // Phase 11 matched field names case-sensitively, so `APIKEY`,
    // `Api_Key` and `PassWord` all passed. Normalisation closes that.
    const variants = [
      'APIKEY',
      'ApiKey',
      'API_KEY',
      'api-key',
      'api key',
      'PrivateKey',
      'PRIVATE_KEY',
      'PassWord',
      'PASSWORD',
      'SECRET',
      'Token',
      'ACCESS_TOKEN',
      'Authorization',
    ];
    for (const name of variants) {
      expect(refusalReason({ [name]: 'value' })).toBe('forbidden-field-name');
    }
  });

  it('F1 case: a sensitive field nested deeply inside is refused', () => {
    const deep = {
      a: { b: { c: { d: { e: { apiKey: 'leaked' } } } } },
    };
    expect(refusalReason(deep)).toBe('forbidden-field-name');
  });

  it('F1 case: a sensitive value inside a long string is refused', () => {
    const long = `${'filler '.repeat(5000)}sk-abcdefghijklmnopqrstuvwxyz0123`;
    expect(refusalReason({ text: long })).toBe('forbidden-value-pattern');
  });

  it('F1 case: sensitive fields mixed across arrays and objects are refused', () => {
    const mixed = {
      items: [{ safe: 'ok' }, { nested: [{ deeper: [{ password: 'hunter2' }] }] }],
    };
    expect(refusalReason(mixed)).toBe('forbidden-field-name');
  });

  it('F1 case: an invalid input structure is refused, not passed through', () => {
    // Functions, class instances and non-finite numbers cannot be
    // inspected faithfully — so they are refused.
    expect(refusalReason({ fn: () => 1 })).toBe('unverifiable-value');
    expect(refusalReason({ big: 1n })).toBe('unverifiable-value');
    expect(refusalReason({ sym: Symbol('x') })).toBe('unverifiable-value');
    expect(refusalReason({ when: new Date() })).toBe('unverifiable-value');
    expect(refusalReason({ n: Number.NaN })).toBe('unverifiable-value');
    expect(refusalReason({ n: Number.POSITIVE_INFINITY })).toBe('unverifiable-value');
    expect(refusalReason({ m: new Map() })).toBe('unverifiable-value');
    expect(refusalReason({ s: new Set() })).toBe('unverifiable-value');
    class Sneaky {
      public apiKey = 'leaked';
    }
    expect(refusalReason({ sneaky: new Sneaky() })).toBe('unverifiable-value');
  });

  it('F1 case: a circular structure is refused', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    expect(refusalReason(cyclic)).toBe('unverifiable-value');
  });

  /* ---------------------------------------------------------------- */
  /* Phase F1 — the size budget                                         */
  /* ---------------------------------------------------------------- */

  it('refuses a payload beyond the character budget', () => {
    expect(refusalReason({ text: 'x'.repeat(500) }, { maxTotalStringLength: 100 })).toBe(
      'payload-too-large',
    );
  });

  it('refuses a payload beyond the node budget', () => {
    const wide = { a: {}, b: {}, c: {}, d: {}, e: {} };
    expect(refusalReason(wide, { maxNodes: 3 })).toBe('payload-too-large');
  });

  /* ---------------------------------------------------------------- */
  /* Phase F1 — the guard must not refuse legitimate protocol fields   */
  /* ---------------------------------------------------------------- */

  it('still accepts a real hello envelope with public key material', () => {
    expect(() =>
      assertNoSensitiveFields({
        protocol: 'KSA',
        version: '0.1',
        messageId: '11111111-2222-4333-8444-555555555555',
        type: 'hello',
        sender: 'a',
        timestamp: '2026-01-01T00:00:00.000Z',
        payload: {
          displayName: 'sam',
          publicKey: 'MCowBQYDK2VwAyEAwQ8mX9Hk2Jm3Qd8sPqLcVn7RgTuYw',
          sessionKeyExchange: {
            ephemeralPublicKey: 'MCowBQYDK2VwAyEA7dYvKp3n0Tz8QcL1eRx5WmBvHgNdA',
            keyId: '9f2c1ab4',
          },
          capabilities: { protocolVersion: '0.1' },
        },
      }),
    ).not.toThrow();
  });

  it('still accepts a profile_exchange envelope', () => {
    expect(() =>
      assertNoSensitiveFields({
        protocol: 'KSA',
        version: '0.1',
        messageId: '11111111-2222-4333-8444-555555555555',
        type: 'profile_exchange',
        sender: 'a',
        timestamp: '2026-01-01T00:00:00.000Z',
        payload: {
          profile: {
            nickname: 'sam',
            bio: 'climber',
            interests: ['rock'],
            currentActivities: [],
            socialIntent: ['similar_interests'],
            conversationStyle: ['casual'],
            boundaries: { allowAgentConversation: true },
          },
          agent: {
            agentId: 'a',
            protocolVersion: '0.1',
            displayName: 'sam',
            publicKey: 'MCowBQYDK2VwAyEAwQ8mX9Hk2Jm3Qd8sPqLcVn7RgTuYw',
            profile: {
              nickname: 'sam',
              bio: '',
              interests: ['rock'],
              currentActivities: [],
              socialIntent: ['similar_interests'],
              conversationStyle: ['casual'],
              boundaries: { allowAgentConversation: true },
            },
            capabilities: { protocolVersion: '0.1' },
          },
        },
      }),
    ).not.toThrow();
  });

  it('accepts a shared (non-circular) reference used twice', () => {
    const shared = { nickname: 'sam' };
    expect(() => assertNoSensitiveFields({ a: shared, b: shared })).not.toThrow();
  });
});
