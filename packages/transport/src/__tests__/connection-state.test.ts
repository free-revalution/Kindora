/**
 * Vitest tests for the connection lifecycle machine — Phase C / C3 § 1
 * and § 8.
 *
 * The machine is the thing the UI reads to answer "what is the
 * connection doing right now?". Its contract is small but load-bearing:
 *
 *   1. a subscriber is notified only on a **real** change;
 *   2. one throwing subscriber must not silence the others;
 *   3. unsubscribing stops the notifications.
 *
 * These are the properties the desktop UI depends on — a view that
 * re-renders on every notification would otherwise re-render forever on
 * a state that never actually changed, and one bad handler would
 * freeze the status bar for the whole app.
 */

import { describe, expect, it, vi } from 'vitest';
import { ConnectionStateMachine, type ConnectionState } from '../connection-state';

describe('@kindora/transport — ConnectionStateMachine', () => {
  it('starts idle', () => {
    const m = new ConnectionStateMachine();
    expect(m.current()).toBe('idle');
  });

  it('reports whether a transition actually changed the state', () => {
    const m = new ConnectionStateMachine();
    expect(m.set('connecting')).toBe(true);
    expect(m.current()).toBe('connecting');
    // The same state again is not a change.
    expect(m.set('connecting')).toBe(false);
    expect(m.set('connected')).toBe(true);
    expect(m.current()).toBe('connected');
  });

  it('notifies subscribers on a change, and only on a change', () => {
    const m = new ConnectionStateMachine();
    const seen: ConnectionState[] = [];
    m.subscribe((s) => seen.push(s));

    m.set('connecting');
    m.set('connecting'); // no-op
    m.set('connected');

    expect(seen).toEqual(['connecting', 'connected']);
  });

  it('does not replay the current state to a late subscriber', () => {
    const m = new ConnectionStateMachine();
    m.set('connecting');
    const seen: ConnectionState[] = [];
    m.subscribe((s) => seen.push(s));
    expect(seen).toEqual([]);
    // A late subscriber reads `current()` if it wants the initial value.
    expect(m.current()).toBe('connecting');
  });

  it('unsubscribes cleanly', () => {
    const m = new ConnectionStateMachine();
    const handler = vi.fn();
    const unsub = m.subscribe(handler);
    m.set('connecting');
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();
    m.set('connected');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('a throwing subscriber does not silence the other subscribers', () => {
    const m = new ConnectionStateMachine();
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    // Silence the expected console.warn so the test output stays clean.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      m.subscribe(bad);
      m.subscribe(good);
      expect(() => m.set('connecting')).not.toThrow();
      expect(bad).toHaveBeenCalledTimes(1);
      expect(good).toHaveBeenCalledTimes(1);
      expect(m.current()).toBe('connecting');
    } finally {
      warn.mockRestore();
    }
  });

  it('a subscriber may subscribe while a notification is being dispatched', () => {
    const m = new ConnectionStateMachine();
    const late: ConnectionState[] = [];
    m.subscribe(() => {
      // Registering during the dispatch must not make the new handler
      // receive the state that is currently being dispatched.
      m.subscribe((s) => late.push(s));
    });
    m.set('connecting');
    expect(late).toEqual([]);
    m.set('connected');
    expect(late).toEqual(['connected']);
  });

  it('walks the whole C3 § 8 lifecycle', () => {
    const m = new ConnectionStateMachine();
    const seen: ConnectionState[] = [];
    m.subscribe((s) => seen.push(s));

    m.set('connecting');
    m.set('connected');
    m.set('disconnected');
    m.set('reconnecting');
    m.set('connecting');
    m.set('connected');
    m.set('failed');
    m.set('idle');

    expect(seen).toEqual([
      'connecting',
      'connected',
      'disconnected',
      'reconnecting',
      'connecting',
      'connected',
      'failed',
      'idle',
    ]);
  });
});
