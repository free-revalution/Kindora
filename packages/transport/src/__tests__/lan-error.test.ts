/**
 * Vitest tests for the `LanError` class.
 *
 * Phase 16.4: this class lets the TypeScript layer classify a Tauri
 * IPC rejection into a discriminated kind. The mapping is purely on
 * `.message` string shape (see Rust `impl Serialize for LanError`).
 */
import { describe, expect, it } from 'vitest';
import { LanError } from '../lan-error';

describe('@kindora/transport — LanError', () => {
  it('classifies "peer closed" as peer-closed', () => {
    const e = LanError.from(new Error('peer closed'));
    expect(e.kind).toBe('peer-closed');
    expect(e.isPeerClosed()).toBe(true);
    expect(e.name).toBe('LanError');
    expect(e.message).toBe('peer closed');
  });

  it('classifies "not connected" as not-connected (a local teardown, NOT a peer close)', () => {
    const e = LanError.from(new Error('not connected'));
    expect(e.kind).toBe('not-connected');
    expect(e.isPeerClosed()).toBe(false);
  });

  it('classifies prefixed "io error: …" as io', () => {
    const e = LanError.from(new Error('io error: connection reset by peer'));
    expect(e.kind).toBe('io');
    expect(e.isPeerClosed()).toBe(false);
  });

  it('classifies prefixed "json error: …" as json', () => {
    const e = LanError.from(new Error('json error: unexpected token at line 1'));
    expect(e.kind).toBe('json');
  });

  it('classifies prefixed "invalid: …" as invalid', () => {
    const e = LanError.from(new Error('invalid: bad frame length: 0'));
    expect(e.kind).toBe('invalid');
  });

  it('classifies prefixed "already running in mode host" as already-running', () => {
    const e = LanError.from(new Error('already running in mode host'));
    expect(e.kind).toBe('already-running');
  });

  it('classifies an unknown message as unknown', () => {
    const e = LanError.from(new Error('something else entirely'));
    expect(e.kind).toBe('unknown');
    expect(e.isPeerClosed()).toBe(false);
  });

  it('accepts a non-Error thrown value (string, object, etc.)', () => {
    expect(LanError.from('peer closed').kind).toBe('peer-closed');
    expect(LanError.from('io error: x').kind).toBe('io');
    expect(LanError.from(42).kind).toBe('unknown');
    expect(LanError.from({ message: 'peer closed' }).kind).toBe('peer-closed');
    // The plain-object form: read `.message` only if it has one.
  });

  it('returns a LanError instance unchanged on round-trip', () => {
    const original = new LanError('peer-closed', 'peer closed');
    expect(LanError.from(original)).toBe(original);
  });

  it('does NOT confuse "not connected" with "peer closed"', () => {
    // The two strings look superficially similar; the classifier
    // must keep them distinct because the close handler is gated
    // exclusively on `isPeerClosed()`.
    const notConnected = LanError.from(new Error('not connected'));
    const peerClosed = LanError.from(new Error('peer closed'));
    expect(notConnected.isPeerClosed()).toBe(false);
    expect(peerClosed.isPeerClosed()).toBe(true);
  });

  it('does NOT mistake a substring for a prefix', () => {
    // "io peer-closed" is NOT a valid "io error: …" prefix — the
    // classifier must require the exact `io error: ` prefix to
    // avoid mapping runtime errors that happen to mention "io".
    const e = LanError.from(new Error('io peer-closed something'));
    expect(e.kind).toBe('unknown');
  });
});
