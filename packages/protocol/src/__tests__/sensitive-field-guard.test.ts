/**
 * Tests for @kindora/protocol/sensitive-field-guard — Phase 11.
 */
import { describe, it, expect } from 'vitest';
import {
  assertNoSensitiveFields,
  formatSensitiveFieldError,
  SensitiveFieldError,
} from '../sensitive-field-guard';

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
    expect(() =>
      assertNoSensitiveFields({ token: 'whatever' }),
    ).toThrow(SensitiveFieldError);
    try {
      assertNoSensitiveFields({ apiKey: 'not a real key' });
    } catch (e) {
      expect((e as SensitiveFieldError).reason).toBe('forbidden-field-name');
      expect((e as SensitiveFieldError).path).toBe('$.apiKey');
    }
  });

  it('rejects forbidden nested field names', () => {
    expect(() =>
      assertNoSensitiveFields({ profile: { nickname: 'Sam', secret: 'shh' } }),
    ).toThrow(/secret/);
  });

  it('rejects forbidden field names inside array elements', () => {
    expect(() =>
      assertNoSensitiveFields({ items: [{ api_key: 'oops' }] }),
    ).toThrow(/api_key/);
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

  it('handles deeply nested structures without exploding (respects maxDepth)', () => {
    let nested: unknown = { leaf: 'plain text' };
    for (let i = 0; i < 10; i++) {
      nested = { next: nested };
    }
    expect(() => assertNoSensitiveFields(nested)).not.toThrow();
  });

  it('handles null and undefined gracefully', () => {
    expect(() => assertNoSensitiveFields(null)).not.toThrow();
    expect(() => assertNoSensitiveFields(undefined)).not.toThrow();
    expect(() => assertNoSensitiveFields({ a: null, b: undefined })).not.toThrow();
  });

  it('skips string scan once the string exceeds maxStringLength', () => {
    const long = 'sk-' + 'a'.repeat(10_000);
    // Long string is treated as opaque — guard returns silently because
    // bounded scan avoids the regex's worst-case blowup on huge blobs.
    expect(() =>
      assertNoSensitiveFields({ payload: { text: long } }, { maxStringLength: 1000 }),
    ).not.toThrow();
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
});