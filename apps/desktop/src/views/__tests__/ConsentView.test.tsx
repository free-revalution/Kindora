import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, render, screen, cleanup, waitFor } from '@testing-library/react';
import type { MatchAnalysis } from '@kindora/protocol';
import type { ConsentOutcome, MatchOutcome } from '@kindora/matching';
import { ConsentView, LiveConsentView } from '../ConsentView';

const SAMPLE: MatchAnalysis = {
  compatibilitySignal: 'moderate',
  commonGround: ['typescript'],
  recommendedTopics: ['side projects'],
  potentialFriction: ['timezones'],
  explanation: 'some overlap',
};

function makeOutcome(): MatchOutcome {
  return {
    peerDisplayName: 'Bob',
    peerAgentId: '22222222-3333-4444-8555-bbbbbbbbbbbb',
    peerAgent: null,
    peerProfile: null,
    localAnalysis: SAMPLE,
    peerAnalysis: SAMPLE,
    localResult: {
      analysis: SAMPLE,
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

describe('apps/desktop — ConsentView', () => {
  it('shows the peer name, signal, and 3 buttons when nothing decided', () => {
    render(
      <ConsentView
        outcome={makeOutcome()}
        state="awaiting_decision"
        onDecide={() => undefined}
        onDisconnect={() => undefined}
      />,
    );
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('Moderate match')).toBeInTheDocument();
    expect(screen.getByTestId('consent-accept')).toBeInTheDocument();
    expect(screen.getByTestId('consent-reject')).toBeInTheDocument();
    expect(screen.getByTestId('consent-block')).toBeInTheDocument();
    expect(screen.getByTestId('consent-status')).toHaveTextContent(/your turn/i);
  });

  it('shows accepted_local status after local accept', () => {
    render(
      <ConsentView
        outcome={makeOutcome()}
        state="accepted_local"
        onDecide={() => undefined}
        onDisconnect={() => undefined}
      />,
    );
    expect(screen.getByTestId('consent-status')).toHaveTextContent(/waiting for them/i);
  });

  it('shows accepted_peer status when peer accepted first', () => {
    render(
      <ConsentView
        outcome={makeOutcome()}
        state="accepted_peer"
        onDecide={() => undefined}
        onDisconnect={() => undefined}
      />,
    );
    expect(screen.getByTestId('consent-status')).toHaveTextContent(/they accepted/i);
  });

  it('shows the "conversation unlocked" banner when both accepted', () => {
    const final: ConsentOutcome = {
      state: 'accepted_both',
      peerDisplayName: 'Bob',
      peerAgentId: '22222222-3333-4444-8555-bbbbbbbbbbbb',
      bothAccepted: true,
      blockedByLocal: false,
      blockedByPeer: false,
      peerAcceptTimedOut: false,
      peerConsentTimeoutMs: 60_000,
      sessionClosed: true,
    };
    render(
      <ConsentView
        outcome={makeOutcome()}
        state="accepted_both"
        onDecide={() => undefined}
        onDisconnect={() => undefined}
        finalOutcome={final}
      />,
    );
    expect(screen.getByText(/conversation unlocked/i)).toBeInTheDocument();
    // Buttons are gone in the final state.
    expect(screen.queryByTestId('consent-accept')).toBeNull();
  });

  it('shows the "blocked" banner when the local user blocked', () => {
    const final: ConsentOutcome = {
      state: 'blocked',
      peerDisplayName: 'Bob',
      peerAgentId: '22222222-3333-4444-8555-bbbbbbbbbbbb',
      bothAccepted: false,
      blockedByLocal: true,
      blockedByPeer: false,
      peerAcceptTimedOut: false,
      peerConsentTimeoutMs: 60_000,
      sessionClosed: true,
    };
    render(
      <ConsentView
        outcome={makeOutcome()}
        state="blocked"
        onDecide={() => undefined}
        onDisconnect={() => undefined}
        finalOutcome={final}
      />,
    );
    // "Blocked" appears in both the header label and the banner h2.
    expect(screen.getAllByText(/Blocked/).length).toBeGreaterThan(0);
  });

  it('shows the "you were blocked" banner when the peer blocked', () => {
    const final: ConsentOutcome = {
      state: 'blocked',
      peerDisplayName: 'Bob',
      peerAgentId: '22222222-3333-4444-8555-bbbbbbbbbbbb',
      bothAccepted: false,
      blockedByLocal: false,
      blockedByPeer: true,
      peerAcceptTimedOut: false,
      peerConsentTimeoutMs: 60_000,
      sessionClosed: true,
    };
    render(
      <ConsentView
        outcome={makeOutcome()}
        state="blocked"
        onDecide={() => undefined}
        onDisconnect={() => undefined}
        finalOutcome={final}
      />,
    );
    expect(screen.getByText(/You were blocked/)).toBeInTheDocument();
  });

  it('fires onDecide("accept") when the Accept button is clicked', () => {
    let called: string | null = null;
    render(
      <ConsentView
        outcome={makeOutcome()}
        state="awaiting_decision"
        onDecide={(d) => {
          called = d;
        }}
        onDisconnect={() => undefined}
      />,
    );
    fireEvent.click(screen.getByTestId('consent-accept'));
    expect(called).toBe('accept');
  });

  it('fires onDecide("reject") and onDecide("block") similarly', () => {
    const calls: string[] = [];
    render(
      <ConsentView
        outcome={makeOutcome()}
        state="awaiting_decision"
        onDecide={(d) => {
          calls.push(d);
        }}
        onDisconnect={() => undefined}
      />,
    );
    fireEvent.click(screen.getByTestId('consent-reject'));
    fireEvent.click(screen.getByTestId('consent-block'));
    expect(calls).toEqual(['reject', 'block']);
  });

  it('disables the buttons in a terminal state', () => {
    render(
      <ConsentView
        outcome={makeOutcome()}
        state="rejected"
        onDecide={() => undefined}
        onDisconnect={() => undefined}
      />,
    );
    expect(screen.queryByTestId('consent-accept')).toBeNull();
  });

  it('shows the "didn’t respond" banner on soft timeout', () => {
    const final: ConsentOutcome = {
      state: 'accepted_local',
      peerDisplayName: 'Bob',
      peerAgentId: '22222222-3333-4444-8555-bbbbbbbbbbbb',
      bothAccepted: false,
      blockedByLocal: false,
      blockedByPeer: false,
      peerAcceptTimedOut: true,
      peerConsentTimeoutMs: 60_000,
      sessionClosed: false,
    };
    render(
      <ConsentView
        outcome={makeOutcome()}
        state="accepted_local"
        onDecide={() => undefined}
        onDisconnect={() => undefined}
        finalOutcome={final}
      />,
    );
    expect(screen.getByText(/didn’t respond/i)).toBeInTheDocument();
  });
});

describe('apps/desktop — LiveConsentView', () => {
  it('transitions to "done" and shows the final banner when start() resolves accepted_both', async () => {
    const final: ConsentOutcome = {
      state: 'accepted_both',
      peerDisplayName: 'Bob',
      peerAgentId: '22222222-3333-4444-8555-bbbbbbbbbbbb',
      bothAccepted: true,
      blockedByLocal: false,
      blockedByPeer: false,
      peerAcceptTimedOut: false,
      peerConsentTimeoutMs: 60_000,
      sessionClosed: true,
    };
    render(
      <LiveConsentView
        outcome={makeOutcome()}
        start={() => Promise.resolve(final)}
        decide={() => Promise.resolve()}
        onDisconnect={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/conversation unlocked/i)).toBeInTheDocument();
    });
  });

  it('fires onFinal when start() resolves to a terminal state', async () => {
    const final: ConsentOutcome = {
      state: 'rejected',
      peerDisplayName: 'Bob',
      peerAgentId: '22222222-3333-4444-8555-bbbbbbbbbbbb',
      bothAccepted: false,
      blockedByLocal: true,
      blockedByPeer: false,
      peerAcceptTimedOut: false,
      peerConsentTimeoutMs: 60_000,
      sessionClosed: true,
    };
    const received: { current?: ConsentOutcome } = {};
    render(
      <LiveConsentView
        outcome={makeOutcome()}
        start={() => Promise.resolve(final)}
        decide={() => Promise.resolve()}
        onDisconnect={() => undefined}
        onFinal={(o) => {
          received.current = o;
        }}
      />,
    );
    await waitFor(() => {
      expect(received.current).toBeDefined();
    });
    expect(received.current?.state).toBe('rejected');
  });

  it('does not fire onFinal when start() resolves to a non-terminal state', async () => {
    const final: ConsentOutcome = {
      state: 'awaiting_decision',
      peerDisplayName: 'Bob',
      peerAgentId: '22222222-3333-4444-8555-bbbbbbbbbbbb',
      bothAccepted: false,
      blockedByLocal: false,
      blockedByPeer: false,
      peerAcceptTimedOut: false,
      peerConsentTimeoutMs: 60_000,
      sessionClosed: false,
    };
    let fired = 0;
    render(
      <LiveConsentView
        outcome={makeOutcome()}
        start={() => Promise.resolve(final)}
        decide={() => Promise.resolve()}
        onDisconnect={() => undefined}
        onFinal={() => {
          fired += 1;
        }}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('consent-status')).toHaveTextContent(/your turn/i);
    });
    expect(fired).toBe(0);
  });
});
