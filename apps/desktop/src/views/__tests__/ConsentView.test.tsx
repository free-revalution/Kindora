import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, render, screen, cleanup, waitFor } from '@testing-library/react';
import type { PeerIntroduction, ConsentOutcome } from '@kindora/matching';
import type { SocialProfile } from '@kindora/protocol';
import { ConsentView, LiveConsentView } from '../ConsentView';

/**
 * Phase B: the consent screen shows the peer's **public card**, not a
 * match outcome. The compatibility signal is not available at this
 * point in the flow — it is computed later, from the authorised
 * profiles, and only after both sides accepted.
 */
function makeCard(overrides: Partial<SocialProfile> = {}): SocialProfile {
  return {
    nickname: 'Bob',
    bio: '',
    interests: [],
    currentActivities: [],
    socialIntent: ['similar_interests'],
    conversationStyle: ['casual'],
    boundaries: {
      allowAgentConversation: true,
      allowContactExchange: false,
      allowOfflineMeeting: false,
      allowProjectDetails: false,
      allowCurrentActivity: false,
      allowBio: false,
      allowInterests: true,
      allowAvatar: false,
      allowSocialIntent: true,
      allowConversationStyle: true,
    },
    ...overrides,
  };
}

function makePeer(overrides: Partial<PeerIntroduction> = {}): PeerIntroduction {
  return {
    peerAgentId: '22222222-3333-4444-8555-bbbbbbbbbbbb',
    peerDisplayName: 'Bob',
    peerCard: makeCard(),
    peerAgent: null,
    ...overrides,
  };
}

beforeEach(() => {
  cleanup();
});

describe('apps/desktop — ConsentView', () => {
  it('shows the peer name and the 3 buttons when nothing decided', () => {
    render(
      <ConsentView
        peer={makePeer()}
        state="awaiting_decision"
        onDecide={() => undefined}
        onDisconnect={() => undefined}
      />,
    );
    // The peer's name is the heading. (The public card shows the same
    // name again, so a bare getByText('Bob') would match two nodes.)
    expect(screen.getByRole('heading', { name: 'Bob' })).toBeInTheDocument();
    expect(screen.getByTestId('consent-accept')).toBeInTheDocument();
    expect(screen.getByTestId('consent-reject')).toBeInTheDocument();
    expect(screen.getByTestId('consent-block')).toBeInTheDocument();
    expect(screen.getByTestId('consent-status')).toHaveTextContent(/your turn/i);
  });

  it('shows the peer public card — the only thing shared so far', () => {
    render(
      <ConsentView
        peer={makePeer()}
        state="awaiting_decision"
        onDecide={() => undefined}
        onDisconnect={() => undefined}
      />,
    );
    const card = screen.getByTestId('consent-public-card');
    expect(card).toBeInTheDocument();
    expect(card).toHaveTextContent('Bob');
    // The intent and the style are what the peer authorised.
    expect(card).toHaveTextContent(/similar/i);
    expect(card).toHaveTextContent(/casual/i);
  });

  it('says "not shared" for a card field the peer withheld', () => {
    render(
      <ConsentView
        peer={makePeer({
          peerCard: makeCard({ socialIntent: [], conversationStyle: [] }),
        })}
        state="awaiting_decision"
        onDecide={() => undefined}
        onDisconnect={() => undefined}
      />,
    );
    const card = screen.getByTestId('consent-public-card');
    expect(card).toHaveTextContent(/not shared/i);
  });

  it('falls back to an empty-card notice when the peer sent no card', () => {
    render(
      <ConsentView
        peer={makePeer({ peerCard: null })}
        state="awaiting_decision"
        onDecide={() => undefined}
        onDisconnect={() => undefined}
      />,
    );
    expect(screen.queryByTestId('consent-public-card')).toBeNull();
    expect(screen.getByText(/did not share/i)).toBeInTheDocument();
  });

  it('does NOT show a compatibility signal before the consent', () => {
    // Phase B: the analysis runs after the consent, so there is no
    // signal to show here. The screen must not pretend otherwise.
    render(
      <ConsentView
        peer={makePeer()}
        state="awaiting_decision"
        onDecide={() => undefined}
        onDisconnect={() => undefined}
      />,
    );
    expect(screen.queryByText(/moderate match/i)).toBeNull();
    expect(screen.queryByText(/strong match/i)).toBeNull();
  });

  it('shows accepted_local status after local accept', () => {
    render(
      <ConsentView
        peer={makePeer()}
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
        peer={makePeer()}
        state="accepted_peer"
        onDecide={() => undefined}
        onDisconnect={() => undefined}
      />,
    );
    expect(screen.getByTestId('consent-status')).toHaveTextContent(/they accepted/i);
  });

  it('shows the "conversation unlocked" banner when both accepted', () => {
    const final = {
      state: 'accepted_both' as const,
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
        peer={makePeer()}
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
    const final = {
      state: 'blocked' as const,
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
        peer={makePeer()}
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
    const final = {
      state: 'blocked' as const,
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
        peer={makePeer()}
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
        peer={makePeer()}
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
        peer={makePeer()}
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
        peer={makePeer()}
        state="rejected"
        onDecide={() => undefined}
        onDisconnect={() => undefined}
      />,
    );
    expect(screen.queryByTestId('consent-accept')).toBeNull();
  });

  it('shows the "didn’t respond" banner on soft timeout', () => {
    const final = {
      state: 'accepted_local' as const,
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
        peer={makePeer()}
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
    const final = {
      state: 'accepted_both' as const,
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
        peer={makePeer()}
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
    const final = {
      state: 'rejected' as const,
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
        peer={makePeer()}
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
    const final = {
      state: 'awaiting_decision' as const,
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
        peer={makePeer()}
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
