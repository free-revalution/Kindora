/**
 * Signing-input golden vectors — shared by TypeScript and Rust (P0-2A / A2).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildSigningInput, SIGNING_INPUT_HEADER } from '../signature';
import { bytesToBase64Url } from '../base64';

const HELLO_ENVELOPE = {
  protocol: 'ksa',
  version: '0.1',
  messageId: '11111111-1111-4111-8111-111111111111',
  timestamp: '2026-01-01T00:00:00.000Z',
  type: 'hello',
  sender: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  payload: {
    displayName: 't',
    capabilities: { protocolVersion: '0.1' },
  },
} as const;

describe('buildSigningInput — shared golden vectors', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const fixturePath = join(here, 'fixtures/signing-input-vectors.json');

  it('produces stable bytes for the fixed hello envelope', async () => {
    const input = await buildSigningInput(HELLO_ENVELOPE, '');
    const text = new TextDecoder().decode(input);
    expect(text.startsWith(`${SIGNING_INPUT_HEADER}\n`)).toBe(true);
    expect(text.endsWith('\n')).toBe(true);
    const lines = text.trimEnd().split('\n');
    expect(lines).toHaveLength(9);
    expect(lines[7]).toBe('');
  });

  it('matches signing-input-vectors.json (Rust envelope::tests)', async () => {
    if (!existsSync(fixturePath)) {
      const input = await buildSigningInput(HELLO_ENVELOPE, '');
      const doc = {
        version: 1,
        description:
          'KSA signing-input golden vectors shared by @kindora/protocol and kindora_desktop_lib::envelope. P0-2A / A2.',
        vectors: [
          {
            name: 'hello-empty-recipient',
            envelope: {
              protocol: HELLO_ENVELOPE.protocol,
              version: HELLO_ENVELOPE.version,
              messageId: HELLO_ENVELOPE.messageId,
              timestamp: HELLO_ENVELOPE.timestamp,
              type: HELLO_ENVELOPE.type,
              sender: HELLO_ENVELOPE.sender,
              payload: HELLO_ENVELOPE.payload,
            },
            recipient: '',
            expectedInputB64url: bytesToBase64Url(input),
          },
        ],
      };
      writeFileSync(fixturePath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    }

    const raw = readFileSync(fixturePath, 'utf8');
    const doc = JSON.parse(raw) as {
      vectors: Array<{
        name: string;
        envelope: {
          protocol: string;
          version: string;
          messageId: string;
          timestamp: string;
          type: string;
          sender: string;
          payload: unknown;
        };
        recipient: string;
        expectedInputB64url: string;
      }>;
    };

    for (const v of doc.vectors) {
      const input = await buildSigningInput(
        {
          protocol: v.envelope.protocol,
          version: v.envelope.version,
          messageId: v.envelope.messageId,
          timestamp: v.envelope.timestamp,
          type: v.envelope.type,
          sender: v.envelope.sender,
          payload: v.envelope.payload,
        },
        v.recipient,
      );
      expect(bytesToBase64Url(input), v.name).toBe(v.expectedInputB64url);
    }
  });
});