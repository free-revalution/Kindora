import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { MatchAnalysis } from '@kindora/protocol';
import { MatchView, LiveMatchView } from '../MatchView';
import type { MatchOutcome } from '@kindora/matching';
import { HandshakeClosedError } from '@kindora/matching';

const SAMPLE_ANALYSIS: MatchAnalysis = {
  compatibilitySignal: 'strong',
  commonGround: ['typescript', 'climbing'],
  recommendedTopics: ['borrowing patterns'],
  potentialFriction: ['timezones'],
  explanation: 'overlap on systems programming',
};

function makeOutcome(peer: string = 'Bob'): MatchOutcome {
  return {
    peerDisplayName: peer,
    peerAgentId: '22222222-3333-4444-8555-bbbbbbbbbbbb',
    peerAgent: null,
    peerProfile: null,
    localAnalysis: SAMPLE_ANALYSIS,
    peerAnalysis: SAMPLE_ANALYSIS,
    localResult: {
      analysis: SAMPLE_ANALYSIS,
      messages: [],
      estimatedTokens: 0,
      rawResponse: '',
      degraded: false,
      degradationNote: null,
    },
    peerAnalysisTimeoutMs: 30_000,
    peerAnalysisTimedOut: false,
    peerRefused: false,
  };
}

beforeEach(() => {
  cleanup();
});

describe('apps/desktop — MatchView', () => {
  it('renders all 5 required fields for a strong match', () => {
    const outcome = makeOutcome();
    render(
      <MatchView phase="done" outcome={outcome} onDisconnect={() => undefined} />,
    );
    // Both local and peer analyses are 'strong', so "Strong match" appears twice.
    expect(screen.getAllByText('Strong match').length).toBeGreaterThan(0);
    expect(screen.getByText('typescript')).toBeInTheDocument();
    expect(screen.getByText('climbing')).toBeInTheDocument();
    expect(screen.getByText('borrowing patterns')).toBeInTheDocument();
    // "timezones" is rendered as "· timezones" inside a <li>, so the text
    // node starts with the bullet character — use a function matcher.
    // Both local and peer analyses contain the same friction, so the
    // element appears twice.
    expect(
      screen.getAllByText((_, el) => el?.textContent === '· timezones').length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/overlap on systems programming/)).toBeInTheDocument();
  });

  it('renders a "moderate" signal with a neutral tone', () => {
    const outcome: MatchOutcome = {
      ...makeOutcome(),
      localAnalysis: { ...SAMPLE_ANALYSIS, compatibilitySignal: 'moderate' },
    };
    render(<MatchView phase="done" outcome={outcome} onDisconnect={() => undefined} />);
    expect(screen.getByText('Moderate match')).toBeInTheDocument();
  });

  it('renders a "none" signal with a cautious tone', () => {
    const outcome: MatchOutcome = {
      ...makeOutcome(),
      localAnalysis: { ...SAMPLE_ANALYSIS, compatibilitySignal: 'none' },
    };
    render(<MatchView phase="done" outcome={outcome} onDisconnect={() => undefined} />);
    expect(screen.getByText('No match')).toBeInTheDocument();
  });

  it('shows the peer display name and short agent id', () => {
    render(
      <MatchView phase="done" outcome={makeOutcome('Bob')} onDisconnect={() => undefined} />,
    );
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText(/22222222/)).toBeInTheDocument();
  });

  it('shows a progress view while analysing', () => {
    render(<MatchView phase="analysing" onDisconnect={() => undefined} />);
    expect(screen.getByText(/analysing/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
  });

  it('shows an error view on failure', () => {
    render(<MatchView phase="error" error="boom" onDisconnect={() => undefined} />);
    expect(screen.getByText('boom')).toBeInTheDocument();
  });

  it('falls back gracefully when peer analysis is missing', () => {
    const outcome: MatchOutcome = { ...makeOutcome(), peerAnalysis: null };
    render(<MatchView phase="done" outcome={outcome} onDisconnect={() => undefined} />);
    expect(screen.getByText(/their agent is still thinking/i)).toBeInTheDocument();
  });

  it('fires onDisconnect when the disconnect button is clicked', () => {
    let called = 0;
    render(
      <MatchView phase="done" outcome={makeOutcome()} onDisconnect={() => { called += 1; }} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /disconnect/i }));
    expect(called).toBe(1);
  });

  it('LiveMatchView transitions to "done" when run() resolves', async () => {
    const outcome = makeOutcome();
    render(<LiveMatchView run={() => Promise.resolve(outcome)} onDisconnect={() => undefined} />);
    await waitFor(() => {
      // Both local and peer analyses are 'strong', so "Strong match" appears twice.
      expect(screen.getAllByText('Strong match').length).toBeGreaterThan(0);
    });
  });

  it('LiveMatchView transitions to "error" when run() rejects', async () => {
    render(
      <LiveMatchView
        run={() => Promise.reject(new Error('boom'))}
        onDisconnect={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('boom')).toBeInTheDocument();
    });
  });

  // ---- Phase 16.4: peer-close surfaces in the UI ----

  it('LiveMatchView shows a peer-disconnected message when run() rejects with HandshakeClosedError (peer-close path)', async () => {
    // The orchestrator throws `HandshakeClosedError('Peer closed the
    // connection before hello was received.')` when the transport's
    // `onClose` fires mid-wait. The view must surface that message
    // verbatim so the user sees "peer disconnected" instead of a
    // generic "boom" / "timed out".
    const peerClosed = new HandshakeClosedError(
      'Peer closed the connection before hello was received.',
    );
    render(
      <LiveMatchView
        run={() => Promise.reject(peerClosed)}
        onDisconnect={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(
        screen.getByText(/peer closed the connection before hello was received/i),
      ).toBeInTheDocument();
    });
  });

  it('LiveMatchView does NOT show a peer-disconnected message for a generic Error (preserves the prior error path)', async () => {
    // Regression: a regular Error that happens to mention "closed"
    // (e.g. "stream closed") should NOT be re-interpreted as a peer
    // disconnect. The view just shows the message verbatim.
    render(
      <LiveMatchView
        run={() => Promise.reject(new Error('stream closed unexpectedly'))}
        onDisconnect={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/stream closed unexpectedly/)).toBeInTheDocument();
    });
    // The peer-close specific copy is NOT present.
    expect(
      screen.queryByText(/peer closed the connection before hello was received/i),
    ).toBeNull();
  });

  it('MatchView error view renders the message and a back button (peer-close goes through the same path)', () => {
    // Direct render of the error view — used by the live wrapper
    // AND by parent code that already has an error string. The
    // message text is what the user reads.
    render(
      <MatchView
        phase="error"
        error="Peer closed the connection before hello was received."
        onDisconnect={() => undefined}
      />,
    );
    expect(
      screen.getByText(/peer closed the connection before hello was received/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument();
  });
});
