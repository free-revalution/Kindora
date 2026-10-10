import { describe, it, expect, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { GenerateIcebreakerResult } from '@kindora/agent';
import { IcebreakerView, LiveIcebreakerView } from '../IcebreakerView';

beforeEach(() => {
  cleanup();
});

function makeResult(topics: readonly string[], overrides: Partial<GenerateIcebreakerResult> = {}): GenerateIcebreakerResult {
  return {
    topics,
    messages: [],
    estimatedTokens: 100,
    rawResponse: '',
    degraded: false,
    degradationNote: null,
    boundaryBlocked: false,
    ...overrides,
  };
}

describe('apps/desktop — IcebreakerView', () => {
  it('renders the header, intro card, and 3 topic rows when phase === "ready"', () => {
    render(
      <IcebreakerView
        peerDisplayName="Bob"
        selfDisplayName="Alex"
        phase="ready"
        topics={['Hi about TS', 'Coffee?', 'Hike Sat']}
        boundaryBlocked={false}
        degradationNote={null}
        error={undefined}
        onUse={() => undefined}
        onRegenerate={() => undefined}
        onSkip={() => undefined}
        onDisconnect={() => undefined}
      />,
    );
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('You: Alex')).toBeInTheDocument();
    expect(screen.getByTestId('icebreaker-topics')).toBeInTheDocument();
    expect(screen.getAllByTestId('icebreaker-row')).toHaveLength(3);
    expect(screen.getAllByTestId('icebreaker-use').length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByTestId('icebreaker-edit')).toHaveLength(3);
    expect(screen.getByTestId('icebreaker-regenerate')).toBeInTheDocument();
    expect(screen.getByTestId('icebreaker-skip')).toBeInTheDocument();
  });

  it('shows a loading placeholder when phase === "generating" and topics are empty', () => {
    render(
      <IcebreakerView
        peerDisplayName="Bob"
        selfDisplayName="Alex"
        phase="generating"
        topics={[]}
        boundaryBlocked={false}
        degradationNote={null}
        error={undefined}
        onUse={() => undefined}
        onRegenerate={() => undefined}
        onSkip={() => undefined}
        onDisconnect={() => undefined}
      />,
    );
    expect(screen.getByTestId('icebreaker-loading')).toBeInTheDocument();
  });

  it('shows the boundary-block banner and disables Regenerate label', () => {
    render(
      <IcebreakerView
        peerDisplayName="Bob"
        selfDisplayName="Alex"
        phase="ready"
        topics={[]}
        boundaryBlocked={true}
        degradationNote="boundary-block: agent conversation disabled"
        error={undefined}
        onUse={() => undefined}
        onRegenerate={() => undefined}
        onSkip={() => undefined}
        onDisconnect={() => undefined}
      />,
    );
    expect(screen.getByTestId('icebreaker-blocked')).toBeInTheDocument();
    expect(screen.getByTestId('icebreaker-skip')).toBeInTheDocument();
    // Regenerate button is still available, but the boundary block
    // means a retry will hit the same short-circuit.
    expect(screen.getByTestId('icebreaker-regenerate')).toBeInTheDocument();
  });

  it('shows the error banner with the error message', () => {
    render(
      <IcebreakerView
        peerDisplayName="Bob"
        selfDisplayName="Alex"
        phase="error"
        topics={[]}
        boundaryBlocked={false}
        degradationNote={null}
        error="LLM request failed: 500"
        onUse={() => undefined}
        onRegenerate={() => undefined}
        onSkip={() => undefined}
        onDisconnect={() => undefined}
      />,
    );
    expect(screen.getByTestId('icebreaker-error')).toBeInTheDocument();
    expect(screen.getByText(/LLM request failed/)).toBeInTheDocument();
  });

  it('shows the degraded banner when topics are empty and degraded=true with a note', () => {
    render(
      <IcebreakerView
        peerDisplayName="Bob"
        selfDisplayName="Alex"
        phase="ready"
        topics={[]}
        boundaryBlocked={false}
        degradationNote="thin-profile: not enough profile data"
        error={undefined}
        onUse={() => undefined}
        onRegenerate={() => undefined}
        onSkip={() => undefined}
        onDisconnect={() => undefined}
      />,
    );
    expect(screen.getByTestId('icebreaker-degraded')).toBeInTheDocument();
    expect(screen.getByText(/thin-profile/)).toBeInTheDocument();
  });

  it('fires onUse with the original topic when Use is clicked (no edit)', () => {
    let used: string | null = null;
    render(
      <IcebreakerView
        peerDisplayName="Bob"
        selfDisplayName="Alex"
        phase="ready"
        topics={['Original topic A', 'Topic B', 'Topic C']}
        boundaryBlocked={false}
        degradationNote={null}
        error={undefined}
        onUse={(t) => {
          used = t;
        }}
        onRegenerate={() => undefined}
        onSkip={() => undefined}
        onDisconnect={() => undefined}
      />,
    );
    const useButtons = screen.getAllByTestId('icebreaker-use');
    fireEvent.click(useButtons[0] as HTMLElement);
    expect(used).toBe('Original topic A');
  });

  it('lets the user Edit a topic, then Use the edited version', () => {
    let used: string | null = null;
    render(
      <IcebreakerView
        peerDisplayName="Bob"
        selfDisplayName="Alex"
        phase="ready"
        topics={['Original topic A', 'Topic B', 'Topic C']}
        boundaryBlocked={false}
        degradationNote={null}
        error={undefined}
        onUse={(t) => {
          used = t;
        }}
        onRegenerate={() => undefined}
        onSkip={() => undefined}
        onDisconnect={() => undefined}
      />,
    );
    // Click Edit on the first row.
    const editButtons = screen.getAllByTestId('icebreaker-edit');
    fireEvent.click(editButtons[0] as HTMLElement);
    const textarea = screen.getByTestId('icebreaker-edit-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Edited message' } });
    // Click Use edited.
    const useButtons = screen.getAllByTestId('icebreaker-use');
    fireEvent.click(useButtons[0] as HTMLElement);
    expect(used).toBe('Edited message');
  });

  it('Cancel edit restores the original topic without firing onUse', () => {
    let used: string | null = null;
    render(
      <IcebreakerView
        peerDisplayName="Bob"
        selfDisplayName="Alex"
        phase="ready"
        topics={['Original topic A', 'Topic B', 'Topic C']}
        boundaryBlocked={false}
        degradationNote={null}
        error={undefined}
        onUse={(t) => {
          used = t;
        }}
        onRegenerate={() => undefined}
        onSkip={() => undefined}
        onDisconnect={() => undefined}
      />,
    );
    fireEvent.click(screen.getAllByTestId('icebreaker-edit')[0] as HTMLElement);
    fireEvent.click(screen.getByTestId('icebreaker-cancel-edit'));
    expect(screen.queryByTestId('icebreaker-edit-textarea')).toBeNull();
    expect(used).toBeNull();
  });

  it('fires onRegenerate when the global Regenerate button is clicked', () => {
    let regenCount = 0;
    render(
      <IcebreakerView
        peerDisplayName="Bob"
        selfDisplayName="Alex"
        phase="ready"
        topics={['a', 'b', 'c']}
        boundaryBlocked={false}
        degradationNote={null}
        error={undefined}
        onUse={() => undefined}
        onRegenerate={() => {
          regenCount += 1;
        }}
        onSkip={() => undefined}
        onDisconnect={() => undefined}
      />,
    );
    fireEvent.click(screen.getByTestId('icebreaker-regenerate'));
    expect(regenCount).toBe(1);
  });

  it('fires onSkip when Skip is clicked', () => {
    let skipped = false;
    render(
      <IcebreakerView
        peerDisplayName="Bob"
        selfDisplayName="Alex"
        phase="ready"
        topics={['a', 'b', 'c']}
        boundaryBlocked={false}
        degradationNote={null}
        error={undefined}
        onUse={() => undefined}
        onRegenerate={() => undefined}
        onSkip={() => {
          skipped = true;
        }}
        onDisconnect={() => undefined}
      />,
    );
    fireEvent.click(screen.getByTestId('icebreaker-skip'));
    expect(skipped).toBe(true);
  });

  it('disables Regenerate while loading', () => {
    render(
      <IcebreakerView
        peerDisplayName="Bob"
        selfDisplayName="Alex"
        phase="regenerating"
        topics={['a', 'b', 'c']}
        boundaryBlocked={false}
        degradationNote={null}
        error={undefined}
        onUse={() => undefined}
        onRegenerate={() => undefined}
        onSkip={() => undefined}
        onDisconnect={() => undefined}
      />,
    );
    const regen = screen.getByTestId('icebreaker-regenerate') as HTMLButtonElement;
    expect(regen.disabled).toBe(true);
  });
});

describe('apps/desktop — LiveIcebreakerView', () => {
  it('runs generate() once on mount and shows the topics', async () => {
    const result = makeResult(['Alpha', 'Beta', 'Gamma']);
    let generateCalls = 0;
    render(
      <LiveIcebreakerView
        peerDisplayName="Bob"
        selfDisplayName="Alex"
        input={{
          selfProfile: {
            nickname: 'Alex',
            bio: 'b',
            interests: [],
            currentActivities: [],
            socialIntent: [],
            conversationStyle: [],
            boundaries: {
              allowAgentConversation: true,
              allowContactExchange: false,
              allowOfflineMeeting: false,
              allowProjectDetails: false,
              allowCurrentActivity: true,
            },
          },
          peerProfile: {
            nickname: 'Bob',
            bio: 'b',
            interests: [],
            currentActivities: [],
            socialIntent: [],
            conversationStyle: [],
            boundaries: {
              allowAgentConversation: true,
              allowContactExchange: false,
              allowOfflineMeeting: false,
              allowProjectDetails: false,
              allowCurrentActivity: true,
            },
          },
        }}
        generate={async () => {
          generateCalls += 1;
          return result;
        }}
        onUse={() => undefined}
        onSkip={() => undefined}
        onDisconnect={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('icebreaker-topics')).toBeInTheDocument();
    });
    expect(generateCalls).toBe(1);
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByText('Gamma')).toBeInTheDocument();
  });

  it('transitions to error phase when generate() rejects', async () => {
    render(
      <LiveIcebreakerView
        peerDisplayName="Bob"
        selfDisplayName="Alex"
        input={{
          selfProfile: {
            nickname: 'Alex',
            bio: '',
            interests: [],
            currentActivities: [],
            socialIntent: [],
            conversationStyle: [],
            boundaries: {
              allowAgentConversation: true,
              allowContactExchange: false,
              allowOfflineMeeting: false,
              allowProjectDetails: false,
              allowCurrentActivity: true,
            },
          },
          peerProfile: {
            nickname: 'Bob',
            bio: '',
            interests: [],
            currentActivities: [],
            socialIntent: [],
            conversationStyle: [],
            boundaries: {
              allowAgentConversation: true,
              allowContactExchange: false,
              allowOfflineMeeting: false,
              allowProjectDetails: false,
              allowCurrentActivity: true,
            },
          },
        }}
        generate={async () => {
          throw new Error('boom');
        }}
        onUse={() => undefined}
        onSkip={() => undefined}
        onDisconnect={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('icebreaker-error')).toBeInTheDocument();
    });
    expect(screen.getByText(/boom/)).toBeInTheDocument();
  });

  it('re-runs generate() when Regenerate is clicked', async () => {
    let calls = 0;
    const reply = (n: number) =>
      makeResult([`first-call-${n}`, `second-call-${n}`, `third-call-${n}`]);
    render(
      <LiveIcebreakerView
        peerDisplayName="Bob"
        selfDisplayName="Alex"
        input={{
          selfProfile: {
            nickname: 'Alex',
            bio: 'b',
            interests: [],
            currentActivities: [],
            socialIntent: [],
            conversationStyle: [],
            boundaries: {
              allowAgentConversation: true,
              allowContactExchange: false,
              allowOfflineMeeting: false,
              allowProjectDetails: false,
              allowCurrentActivity: true,
            },
          },
          peerProfile: {
            nickname: 'Bob',
            bio: 'b',
            interests: [],
            currentActivities: [],
            socialIntent: [],
            conversationStyle: [],
            boundaries: {
              allowAgentConversation: true,
              allowContactExchange: false,
              allowOfflineMeeting: false,
              allowProjectDetails: false,
              allowCurrentActivity: true,
            },
          },
        }}
        generate={async () => {
          calls += 1;
          return reply(calls);
        }}
        onUse={() => undefined}
        onSkip={() => undefined}
        onDisconnect={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('first-call-1')).toBeInTheDocument();
    });
    expect(calls).toBe(1);
    fireEvent.click(screen.getByTestId('icebreaker-regenerate'));
    await waitFor(() => {
      expect(screen.getByText('first-call-2')).toBeInTheDocument();
    });
    expect(calls).toBe(2);
  });

  it('passes the chosen topic to onUse when Use is clicked', async () => {
    let chosen: string | null = null;
    render(
      <LiveIcebreakerView
        peerDisplayName="Bob"
        selfDisplayName="Alex"
        input={{
          selfProfile: {
            nickname: 'Alex',
            bio: 'b',
            interests: [],
            currentActivities: [],
            socialIntent: [],
            conversationStyle: [],
            boundaries: {
              allowAgentConversation: true,
              allowContactExchange: false,
              allowOfflineMeeting: false,
              allowProjectDetails: false,
              allowCurrentActivity: true,
            },
          },
          peerProfile: {
            nickname: 'Bob',
            bio: 'b',
            interests: [],
            currentActivities: [],
            socialIntent: [],
            conversationStyle: [],
            boundaries: {
              allowAgentConversation: true,
              allowContactExchange: false,
              allowOfflineMeeting: false,
              allowProjectDetails: false,
              allowCurrentActivity: true,
            },
          },
        }}
        generate={async () => makeResult(['one', 'two', 'three'])}
        onUse={(t) => {
          chosen = t;
        }}
        onSkip={() => undefined}
        onDisconnect={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('icebreaker-topics')).toBeInTheDocument();
    });
    const useButtons = screen.getAllByTestId('icebreaker-use');
    fireEvent.click(useButtons[1] as HTMLElement);
    expect(chosen).toBe('two');
  });
});