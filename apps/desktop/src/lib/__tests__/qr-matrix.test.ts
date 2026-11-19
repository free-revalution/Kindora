import { describe, expect, it } from 'vitest';
import { encodeQrPayload } from '@kindora/transport';
import { PROTOCOL_VERSION } from '@kindora/protocol';
import { encodeQrMatrix } from '../qr-matrix';

const AGENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('encodeQrMatrix', () => {
  it('produces a square matrix with finder patterns for a pairing URL', () => {
    const url = encodeQrPayload({
      code: 'ABCDEF',
      agentId: AGENT,
      protocolVersion: PROTOCOL_VERSION,
    });
    const m = encodeQrMatrix(url);
    expect(m.length).toBeGreaterThanOrEqual(21);
    expect(m.length % 4).toBe(1); // 21 + 4*(v-1)
    expect(m.every((row) => row.length === m.length)).toBe(true);

    // Top-left finder: corners of the 7×7 are dark
    expect(m[0]![0]).toBe(true);
    expect(m[0]![6]).toBe(true);
    expect(m[6]![0]).toBe(true);
    expect(m[6]![6]).toBe(true);
    // Finder center
    expect(m[3]![3]).toBe(true);
    // Separator around finder is light
    expect(m[7]![0]).toBe(false);
  });

  it('encodes a short ASCII string without throwing', () => {
    const m = encodeQrMatrix('HELLO');
    expect(m.length).toBe(21); // version 1
  });
});
