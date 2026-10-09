import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PAIRING_CODE_LENGTH,
  MAX_PAIRING_CODE_LENGTH,
  MIN_PAIRING_CODE_LENGTH,
  generatePairingCode,
  isValidPairingCodeShape,
  normalisePairingCode,
  pairingCodeEntropyBits,
} from '../index';

describe('@kindora/transport — pairing-code', () => {
  it('default length matches 开发手册.md V0.1 expectation (6 chars)', () => {
    expect(DEFAULT_PAIRING_CODE_LENGTH).toBe(6);
  });

  it('throws on out-of-range length', () => {
    expect(() => generatePairingCode({ length: MIN_PAIRING_CODE_LENGTH - 1 })).toThrow();
    expect(() => generatePairingCode({ length: MAX_PAIRING_CODE_LENGTH + 1 })).toThrow();
  });

  it('generates a 6-char code using only the unambiguous alphabet', () => {
    const code = generatePairingCode();
    expect(code).toHaveLength(6);
    expect(isValidPairingCodeShape(code)).toBe(true);
    for (const ch of code) {
      expect('0123456789ABCDEFGHJKMNPQRSTVWXYZ').toContain(ch);
    }
  });

  it('accepts legacy positional-arg length call', () => {
    expect(generatePairingCode(8)).toHaveLength(8);
  });

  it('generates distinct codes across many calls (uniqueness smoke test)', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generatePairingCode()));
    expect(codes.size).toBeGreaterThan(195);
  });

  it('normalises input: strips whitespace, dashes, uppercases', () => {
    expect(normalisePairingCode(' abcd-ef ')).toBe('ABCDEF');
    expect(normalisePairingCode('a b c d e f')).toBe('ABCDEF');
  });

  it('rejects input with confusable or non-alphabet characters', () => {
    expect(normalisePairingCode('ILOU')).toBeNull(); // I, L, O, U excluded
    expect(normalisePairingCode('AB!D')).toBeNull();
    expect(normalisePairingCode('😅😅😅😅😅😅')).toBeNull();
  });

  it('rejects too-short and too-long input', () => {
    expect(normalisePairingCode('AB')).toBeNull();
    expect(normalisePairingCode('A'.repeat(MAX_PAIRING_CODE_LENGTH + 1))).toBeNull();
  });

  it('rejects non-string input', () => {
    expect(normalisePairingCode(123 as unknown as string)).toBeNull();
  });

  it('reports entropy in bits as length * log2(32)', () => {
    expect(pairingCodeEntropyBits(6)).toBe(30);
    expect(pairingCodeEntropyBits(8)).toBe(40);
  });
});
