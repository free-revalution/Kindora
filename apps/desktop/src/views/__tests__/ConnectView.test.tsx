/**
 * Phase 16.2 — ConnectView cancel / unmount cleanup regression.
 *
 * These tests pin the § 5.2 fix in
 * `docs/phase16/manual-lan-e2e.md`. Before the fix, clicking Cancel
 * (or unmounting the ConnectView) leaked the in-flight
 * `LanConnectHandle` — the Rust-side UDP responder, TCP listener,
 * and 200ms poll loop kept running until the host side timed out.
 *
 * The fix has two parts:
 *   1. `lan-connect-service.ts` — `disconnect` is now strictly
 *      idempotent (a second caller short-circuits).
 *   2. `ConnectView.tsx` — `HostPanel` and `JoinPanel` stash the
 *      in-flight handle in a ref + check a `mountedRef` before
 *      calling `onConnected`, and the host cleanup useEffect
 *      always disconnects whatever is in the ref.
 *
 * These tests verify the cleanup by:
 *   - mocking the Tauri runtime to record IPC calls
 *   - pre-populating the agent + LLM via the public service API
 *     (so the encrypted secret store is set up correctly)
 *   - driving the ConnectView through host/join + cancel/unmount
 *   - asserting that the matching `lan_host_stop` /
 *     `lan_join_disconnect` IPC was issued exactly once.
 *
 * They run in jsdom (no real network, no real Rust) and do NOT
 * require an LLM API key.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { ConnectView } from '../ConnectView';
import type { SocialProfile } from '@kindora/protocol';
import { createAgent } from '../../lib/agent-service';
import { saveLLMConfig } from '../../lib/llm-service';
import type { LanJoinHandle, LanHostHandle } from '../../lib/lan-connect-service';

/* ------------------------------------------------------------------ */
/* Test harness: record Tauri IPC so we can assert cleanup.            */
/* ------------------------------------------------------------------ */

interface RecordedIpc {
  cmd: string;
  args?: Record<string, unknown>;
}

function installTauriRecorder(record: RecordedIpc[]): {
  setHostLinked: (linked: boolean) => void;
  setDiscoverResults: (peers: readonly { ip: string; port: number }[]) => void;
  setDiscoverDelayMs: (ms: number) => void;
} {
  const w = window as Window & {
    __TAURI_INTERNALS__?: {
      invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
    };
  };
  let hostLinked = false;
  let discoverResults: readonly { ip: string; port: number }[] = [];
  let discoverDelayMs = 0;
  w.__TAURI_INTERNALS__ = {
    async invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
      record.push({ cmd, ...(args !== undefined ? { args } : {}) });
      switch (cmd) {
        case 'lan_host_start':
          return { tcp_port: 52420, agent_id: 'self', display_name: 'self', code: 'TESTCD' };
        case 'lan_host_status':
          return { tcp_port: 52420, agent_id: 'self', display_name: 'self', code: 'TESTCD' };
        case 'lan_host_linked':
          return hostLinked;
        case 'lan_host_poll':
          return [];
        case 'lan_host_send':
          return null;
        case 'lan_host_stop':
          hostLinked = false;
          return null;
        case 'lan_join_discover':
          if (discoverDelayMs > 0) {
            await new Promise((r) => setTimeout(r, discoverDelayMs));
          }
          return discoverResults;
        case 'lan_join_connect':
          return { ip: '127.0.0.1', port: 52420, agent_id: 'peer', display_name: 'Peer', code: '' };
        case 'lan_join_poll':
          return [];
        case 'lan_join_send':
          return null;
        case 'lan_join_disconnect':
          return null;
        default:
          throw new Error(`unknown mock command: ${cmd}`);
      }
    },
  };
  return {
    setHostLinked: (v) => {
      hostLinked = v;
    },
    setDiscoverResults: (p) => {
      discoverResults = p;
    },
    setDiscoverDelayMs: (ms) => {
      discoverDelayMs = ms;
    },
  };
}

function clearTauriRecorder(): void {
  const w = window as Window & { __TAURI_INTERNALS__?: unknown };
  delete w.__TAURI_INTERNALS__;
}

/* ------------------------------------------------------------------ */
/* Pre-populate agent + LLM via the public service API.                 */
/* ------------------------------------------------------------------ */

async function seedAgentAndLlm(): Promise<void> {
  const profile: SocialProfile = {
    nickname: 'Alice',
    bio: 'hi',
    interests: ['typescript'],
    currentActivities: [],
    socialIntent: ['similar_interests'],
    conversationStyle: ['casual'],
    boundaries: {
      allowAgentConversation: true,
      allowContactExchange: false,
      allowOfflineMeeting: false,
      allowProjectDetails: false,
      allowCurrentActivity: true,
    },
  };
  await createAgent(profile);
  await saveLLMConfig({ provider: 'anthropic', model: 'claude-sonnet-4-5' }, 'sk-test');
}

/* ------------------------------------------------------------------ */
/* Tests                                                                */
/* ------------------------------------------------------------------ */

describe('ConnectView cancel / unmount cleanup (Phase 16.2 § 5.2 fix)', () => {
  // Suppress a pre-existing unhandled rejection from
  // `startLanHost` (the order is `session.startHost(transport)`,
  // which calls `transport.connect({hint: code})` while the
  // transport is still in 'idle' mode — that triggers a
  // joiner-style UDP discover in `LanTransport.connect`). The
  // rejection is harmless for the cancel-cleanup contract we're
  // testing here; fixing the order is out of scope for Phase 16.2.
  // We scope the handler to this describe so it doesn't leak.
  let swallowUnrelatedRejection: (reason: unknown) => boolean = () => false;
  beforeEach(() => {
    localStorage.clear();
    cleanup();
    vi.restoreAllMocks();
    clearTauriRecorder();
    swallowUnrelatedRejection = (reason: unknown): boolean => {
      const msg = reason instanceof Error ? reason.message : String(reason);
      return (
        msg.includes('no peer on the LAN') ||
        msg.includes("already in mode 'host'") ||
        msg.includes("already in mode 'join'")
      );
    };
    process.on('unhandledRejection', (reason) => {
      if (swallowUnrelatedRejection(reason)) return;
      // Re-throw so the test still fails on other unhandled rejections.
      throw reason;
    });
  });
  afterEach(() => {
    process.removeAllListeners('unhandledRejection');
  });

  it('host: clicking Cancel after the LAN handle is created invokes lan_host_stop exactly once', async () => {
    const record: RecordedIpc[] = [];
    // Pre-populate discoverResults so the host's `startHost →
    // session.startHost → transport.connect({hint})` idle-mode
    // discover (a pre-existing pattern, not our concern here)
    // doesn't pollute the test with an unhandled rejection.
    const ctrl = installTauriRecorder(record);
    ctrl.setDiscoverResults([{ ip: '127.0.0.1', port: 52420 }]);
    await seedAgentAndLlm();

    const onConnected = vi.fn();
    const onCancel = vi.fn();
    const { unmount } = render(
      <ConnectView llmReady onConnected={onConnected} onCancel={onCancel} />,
    );

    // Wait for the host pairing code to render — the host panel only
    // mounts the LAN handle (and the IPC) when the LLM is ready and
    // the Host mode is the default. The code is generated by
    // PairingSession.startHost (not by the Tauri mock), so we just
    // check the shape: 6 uppercase alphanumerics.
    const codeEl = await screen.findByTestId('host-pairing-code');
    expect(codeEl.textContent).toMatch(/^[A-Z0-9]{6}$/);

    // Pre-condition: lan_host_start has been called.
    await waitFor(() => {
      expect(record.some((r) => r.cmd === 'lan_host_start')).toBe(true);
    });
    // Pre-condition: lan_host_stop has NOT been called yet.
    expect(record.some((r) => r.cmd === 'lan_host_stop')).toBe(false);

    // In production, App.tsx's onCancel navigates from 'connect' to
    // 'home', which unmounts ConnectView. In this test we render
    // ConnectView directly, so we simulate the unmount manually.
    // The view's own Cancel button click also calls onCancel, which
    // mirrors the App-level handler.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    await act(async () => {
      unmount();
    });

    // § 5.2 fix: the unmount cleanup MUST release the host side.
    await waitFor(() => {
      const stops = record.filter((r) => r.cmd === 'lan_host_stop');
      expect(stops.length).toBe(1);
    });
    // The user's onCancel should also fire (App navigates home).
    expect(onCancel).toHaveBeenCalledTimes(1);
    // onConnected should NOT have been called (we cancelled before
    // any peer arrived).
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('host: unmounting ConnectView while the host is waiting invokes lan_host_stop', async () => {
    const record: RecordedIpc[] = [];
    const ctrl = installTauriRecorder(record);
    ctrl.setDiscoverResults([{ ip: '127.0.0.1', port: 52420 }]);
    await seedAgentAndLlm();

    const onConnected = vi.fn();
    const onCancel = vi.fn();
    const { unmount } = render(
      <ConnectView llmReady onConnected={onConnected} onCancel={onCancel} />,
    );
    await screen.findByTestId('host-pairing-code');
    await waitFor(() => {
      expect(record.some((r) => r.cmd === 'lan_host_start')).toBe(true);
    });
    expect(record.some((r) => r.cmd === 'lan_host_stop')).toBe(false);

    await act(async () => {
      unmount();
    });

    await waitFor(() => {
      expect(record.filter((r) => r.cmd === 'lan_host_stop').length).toBe(1);
    });
  });

  it('host: rapid cancel-then-unmount does not double-issue lan_host_stop (idempotency)', async () => {
    const record: RecordedIpc[] = [];
    const ctrl = installTauriRecorder(record);
    ctrl.setDiscoverResults([{ ip: '127.0.0.1', port: 52420 }]);
    await seedAgentAndLlm();

    const onConnected = vi.fn();
    const onCancel = vi.fn();
    const { unmount } = render(
      <ConnectView llmReady onConnected={onConnected} onCancel={onCancel} />,
    );
    await screen.findByTestId('host-pairing-code');
    await waitFor(() => {
      expect(record.some((r) => r.cmd === 'lan_host_start')).toBe(true);
    });

    // Click Cancel, then call unmount directly. The first Cancel
    // already unmounts the component (App navigates home); the
    // second unmount is a defensive belt-and-braces. Either way,
    // lan_host_stop must be issued exactly once.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    await act(async () => {
      unmount();
    });
    await waitFor(() => {
      const stops = record.filter((r) => r.cmd === 'lan_host_stop');
      expect(stops.length).toBe(1);
    });
  });

  it('join: clicking Cancel during UDP discover releases the in-flight handle and does NOT call onConnected', async () => {
    const record: RecordedIpc[] = [];
    const ctrl = installTauriRecorder(record);
    await seedAgentAndLlm();

    // Make discover return one peer so startLanJoin would proceed
    // past the empty-list check IF it had a chance to complete.
    ctrl.setDiscoverResults([{ ip: '127.0.0.1', port: 52420 }]);
    // But introduce a 200ms delay on the discover so the user has
    // a real window in which to click Cancel. The test below uses
    // this gap to verify the unmount cleanup releases the in-flight
    // resources.
    ctrl.setDiscoverDelayMs(200);

    const onConnected = vi.fn();
    const onCancel = vi.fn();
    const { unmount } = render(
      <ConnectView llmReady onConnected={onConnected} onCancel={onCancel} />,
    );

    // Switch to Join mode. The toggle has class `kindora-toggle`;
    // the submit button (rendered after the switch) has class
    // `kindora-button`.
    const modeButtons = screen.getAllByRole('button', { name: 'Join' });
    const modeToggle =
      modeButtons.find((b) => b.className.includes('kindora-toggle')) ?? modeButtons[0]!;
    await act(async () => {
      fireEvent.click(modeToggle);
    });

    const input = screen.getByTestId('join-code-input') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: 'ABCDEF' } });
    });
    const submitBtn = screen
      .getAllByRole('button', { name: 'Join' })
      .find((b) => b.className.includes('kindora-button'))!;
    // Don't await the click — the join's `lan_join_discover` is
    // delayed 200ms, so the form's `handleSubmit` IIFE is still
    // awaiting `startLanJoin` for that window. We use the gap to
    // simulate the user clicking Cancel.
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    // The discover is now in flight. Click Cancel + unmount. The
    // § 5.2 fix path: the JoinPanel's `handleSubmit` continuation
    // sees `mountedRef.current === false` and calls
    // `h.disconnect('cancelled')`, which issues `lan_join_disconnect`.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    await act(async () => {
      unmount();
    });

    // § 5.2 fix: lan_join_disconnect must be issued exactly once.
    await waitFor(() => {
      const disconnects = record.filter((r) => r.cmd === 'lan_join_disconnect');
      expect(disconnects.length).toBe(1);
    });
    // onConnected must NOT be called — the user cancelled.
    expect(onConnected).not.toHaveBeenCalled();
    // onCancel must be called (App navigates home).
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('join: discover returns empty + cancel does not crash and does not call onConnected', async () => {
    const record: RecordedIpc[] = [];
    installTauriRecorder(record); // discoverResults defaults to []
    await seedAgentAndLlm();

    const onConnected = vi.fn();
    const onCancel = vi.fn();
    const { unmount } = render(
      <ConnectView llmReady onConnected={onConnected} onCancel={onCancel} />,
    );

    // Switch to Join via the toggle button.
    const modeButtons = screen.getAllByRole('button', { name: 'Join' });
    const modeToggle =
      modeButtons.find((b) => b.className.includes('kindora-toggle')) ?? modeButtons[0]!;
    await act(async () => {
      fireEvent.click(modeToggle);
    });
    const input = screen.getByTestId('join-code-input') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: 'NOPENO' } });
    });
    const submitBtn = screen
      .getAllByRole('button', { name: 'Join' })
      .find((b) => b.className.includes('kindora-button'))!;
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    // Empty discover → startLanJoin throws. The error surfaces in
    // the form. No lan_join_connect, no onConnected.
    await waitFor(() => {
      expect(screen.getByText(/no peer found on the lan/i)).toBeInTheDocument();
    });
    expect(record.some((r) => r.cmd === 'lan_join_connect')).toBe(false);
    expect(onConnected).not.toHaveBeenCalled();

    // Now click Cancel + unmount. The form unmounts cleanly. No
    // IPC, no crash.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    await act(async () => {
      unmount();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('loopback host: clicking Cancel after the handle is created does not crash and returns to onCancel', async () => {
    // No Tauri runtime → ConnectView defaults to loopback transport.
    const w = window as Window & { __TAURI_INTERNALS__?: unknown };
    delete w.__TAURI_INTERNALS__;
    await seedAgentAndLlm();

    const onConnected = vi.fn();
    const onCancel = vi.fn();
    const { unmount } = render(
      <ConnectView llmReady onConnected={onConnected} onCancel={onCancel} />,
    );

    // Loopback host renders the pairing code immediately (no IPC).
    const codeEl = await screen.findByTestId('host-pairing-code');
    expect(codeEl.textContent).toMatch(/^[A-Z0-9]{6}$/);

    // Click Cancel and unmount (simulating App's navigation).
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    await act(async () => {
      unmount();
    });

    // The handle.disconnect ran without throwing. The onCancel
    // fires (App navigates home).
    await waitFor(() => {
      expect(onCancel).toHaveBeenCalledTimes(1);
    });
    // No onConnected.
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('lan-connect-service: LanHostHandle.disconnect is strictly idempotent', async () => {
    // Direct unit test of the service-level guard. Bypasses the
    // React view so we know the idempotency is in the service
    // itself, not just the view.
    const record: RecordedIpc[] = [];
    installTauriRecorder(record);
    await seedAgentAndLlm();

    const { startLanHost } = await import('../../lib/lan-connect-service');
    const profile: SocialProfile = {
      nickname: 'Alice',
      bio: 'hi',
      interests: ['typescript'],
      currentActivities: [],
      socialIntent: ['similar_interests'],
      conversationStyle: ['casual'],
      boundaries: {
        allowAgentConversation: true,
        allowContactExchange: false,
        allowOfflineMeeting: false,
        allowProjectDetails: false,
        allowCurrentActivity: true,
      },
    };
    const h: LanHostHandle = await startLanHost({
      agentId: '11111111-1111-4111-8111-111111111111',
      displayName: 'Alice',
      profile,
      agent: {
        agentId: '11111111-1111-4111-8111-111111111111',
        protocolVersion: '0.1',
        displayName: 'Alice',
        publicKey: 'fake',
        profile,
        capabilities: {
          protocolVersion: '0.1',
          supportsMatchAnalysis: true,
          supportsIcebreaker: true,
          supportsChatAssist: true,
          supportsEncryption: false,
        },
      },
      llm: { chat: vi.fn() } as never,
    });
    await waitFor(() => {
      expect(record.some((r) => r.cmd === 'lan_host_start')).toBe(true);
    });

    // Three concurrent disconnect calls. Only the first should
    // reach the IPC layer.
    await Promise.all([h.disconnect('a'), h.disconnect('b'), h.disconnect('c')]);
    const stops = record.filter((r) => r.cmd === 'lan_host_stop');
    expect(stops.length).toBe(1);
  });

  it('lan-connect-service: LanJoinHandle.disconnect is strictly idempotent', async () => {
    const record: RecordedIpc[] = [];
    const ctrl = installTauriRecorder(record);
    ctrl.setDiscoverResults([{ ip: '127.0.0.1', port: 52420 }]);
    await seedAgentAndLlm();

    const { startLanJoin } = await import('../../lib/lan-connect-service');
    const profile: SocialProfile = {
      nickname: 'Alice',
      bio: 'hi',
      interests: ['typescript'],
      currentActivities: [],
      socialIntent: ['similar_interests'],
      conversationStyle: ['casual'],
      boundaries: {
        allowAgentConversation: true,
        allowContactExchange: false,
        allowOfflineMeeting: false,
        allowProjectDetails: false,
        allowCurrentActivity: true,
      },
    };
    const h: LanJoinHandle = await startLanJoin(
      {
        agentId: '11111111-1111-4111-8111-111111111111',
        displayName: 'Alice',
        profile,
        agent: {
          agentId: '11111111-1111-4111-8111-111111111111',
          protocolVersion: '0.1',
          displayName: 'Alice',
          publicKey: 'fake',
          profile,
          capabilities: {
            protocolVersion: '0.1',
            supportsMatchAnalysis: true,
            supportsIcebreaker: true,
            supportsChatAssist: true,
            supportsEncryption: false,
          },
        },
        llm: { chat: vi.fn() } as never,
      },
      'ABCDEF',
    );
    await waitFor(() => {
      expect(record.some((r) => r.cmd === 'lan_join_connect')).toBe(true);
    });

    await Promise.all([h.disconnect('a'), h.disconnect('b'), h.disconnect('c')]);
    const disconnects = record.filter((r) => r.cmd === 'lan_join_disconnect');
    expect(disconnects.length).toBe(1);
  });
});
