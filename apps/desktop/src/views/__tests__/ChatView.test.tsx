import { describe, it, expect, beforeEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ChatAssistHandle, ChatSnapshot } from '@kindora/matching';
import { ChatView, LiveChatView, type ChatAssistPanelState } from '../ChatView';
import type { ChatMessage, LLMProvider, LLMResponse } from '@kindora/llm';

beforeEach(() => {
  cleanup();
});

function makeSnapshot(overrides: Partial<ChatSnapshot> = {}): ChatSnapshot {
  return {
    entries: [],
    state: 'open',
    closeReason: 'open',
    peerAgentId: '22222222-2222-4222-8222-bbbbbbbbbbbb',
    peerDisplayName: 'Bob',
    blockedByLocal: false,
    blockedByPeer: false,
    ...overrides,
  };
}

describe('apps/desktop — ChatView (Phase 9)', () => {
  it('renders the header + history + composer', () => {
    render(
      <ChatView
        peerDisplayName="Bob"
        selfDisplayName="Alex"
        snapshot={makeSnapshot()}
        phase="open"
        draft=""
        sending={false}
        maxTextLength={2000}
        error={undefined}
        assistant={emptyAssist()}
        onDraftChange={() => undefined}
        onSend={() => undefined}
        onDisconnect={() => undefined}
        onBlock={() => undefined}
        onUseSuggestion={() => undefined}
        onAskOpen={() => undefined}
        onAskClose={() => undefined}
        onAskChangeQuery={() => undefined}
        onAskSubmit={() => undefined}
        onAskRegenerate={() => undefined}
        onAskDismissSuggestion={() => undefined}
      />,
    );
    expect(screen.getByTestId('chat-header')).toBeInTheDocument();
    expect(screen.getByTestId('chat-history')).toBeInTheDocument();
    expect(screen.getByTestId('chat-composer')).toBeInTheDocument();
    expect(screen.getByTestId('chat-input')).toBeInTheDocument();
    expect(screen.getByTestId('chat-send')).toBeInTheDocument();
    expect(screen.getByTestId('chat-block')).toBeInTheDocument();
  });

  it('shows sent / received bubbles with the right data-direction', () => {
    render(
      <ChatView
        peerDisplayName="Bob"
        selfDisplayName="Alex"
        snapshot={makeSnapshot({
          entries: [
            { id: '1', direction: 'received', sender: 'peer', text: 'hi', timestamp: '2026-01-01T00:00:00.000Z' },
            { id: '2', direction: 'sent', sender: 'self', text: 'hello', timestamp: '2026-01-01T00:01:00.000Z' },
          ],
        })}
        phase="open"
        draft=""
        sending={false}
        maxTextLength={2000}
        error={undefined}
        assistant={emptyAssist()}
        onDraftChange={() => undefined}
        onSend={() => undefined}
        onDisconnect={() => undefined}
        onBlock={() => undefined}
        onUseSuggestion={() => undefined}
        onAskOpen={() => undefined}
        onAskClose={() => undefined}
        onAskChangeQuery={() => undefined}
        onAskSubmit={() => undefined}
        onAskRegenerate={() => undefined}
        onAskDismissSuggestion={() => undefined}
      />,
    );
    const bubbles = screen.getAllByTestId('chat-bubble');
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0]?.getAttribute('data-direction')).toBe('received');
    expect(bubbles[1]?.getAttribute('data-direction')).toBe('sent');
  });
});

describe('apps/desktop — ChatView (Phase 10 — Ask My Agent panel)', () => {
  it('renders the Ask My Agent button when the panel is closed', () => {
    render(
      <ChatView
        peerDisplayName="Bob"
        selfDisplayName="Alex"
        snapshot={makeSnapshot()}
        phase="open"
        draft=""
        sending={false}
        maxTextLength={2000}
        error={undefined}
        assistant={emptyAssist({ open: false })}
        onDraftChange={() => undefined}
        onSend={() => undefined}
        onDisconnect={() => undefined}
        onBlock={() => undefined}
        onUseSuggestion={() => undefined}
        onAskOpen={() => undefined}
        onAskClose={() => undefined}
        onAskChangeQuery={() => undefined}
        onAskSubmit={() => undefined}
        onAskRegenerate={() => undefined}
        onAskDismissSuggestion={() => undefined}
      />,
    );
    expect(screen.getByTestId('chat-assist-closed')).toBeInTheDocument();
    expect(screen.getByTestId('chat-assist-open')).toBeInTheDocument();
    expect(screen.getByText(/Ask My Agent/i)).toBeInTheDocument();
  });

  it('disables the button and shows a reason when the assistant is unavailable', () => {
    render(
      <ChatView
        peerDisplayName="Bob"
        selfDisplayName="Alex"
        snapshot={makeSnapshot()}
        phase="open"
        draft=""
        sending={false}
        maxTextLength={2000}
        error={undefined}
        assistant={emptyAssist({ open: false, unavailable: true, unavailableReason: 'No LLM configured.' })}
        onDraftChange={() => undefined}
        onSend={() => undefined}
        onDisconnect={() => undefined}
        onBlock={() => undefined}
        onUseSuggestion={() => undefined}
        onAskOpen={() => undefined}
        onAskClose={() => undefined}
        onAskChangeQuery={() => undefined}
        onAskSubmit={() => undefined}
        onAskRegenerate={() => undefined}
        onAskDismissSuggestion={() => undefined}
      />,
    );
    const btn = screen.getByTestId('chat-assist-open') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('opens the panel and renders the query form when Ask My Agent is clicked', () => {
    let assist = emptyAssist({ open: false });
    const { rerender } = render(
      <ChatView
        peerDisplayName="Bob"
        selfDisplayName="Alex"
        snapshot={makeSnapshot()}
        phase="open"
        draft=""
        sending={false}
        maxTextLength={2000}
        error={undefined}
        assistant={assist}
        onDraftChange={() => undefined}
        onSend={() => undefined}
        onDisconnect={() => undefined}
        onBlock={() => undefined}
        onUseSuggestion={() => undefined}
        onAskOpen={() => undefined}
        onAskClose={() => undefined}
        onAskChangeQuery={() => undefined}
        onAskSubmit={() => undefined}
        onAskRegenerate={() => undefined}
        onAskDismissSuggestion={() => undefined}
      />,
    );
    fireEvent.click(screen.getByTestId('chat-assist-open'));

    // Re-render with the panel open.
    assist = emptyAssist({ open: true });
    rerender(
      <ChatView
        peerDisplayName="Bob"
        selfDisplayName="Alex"
        snapshot={makeSnapshot()}
        phase="open"
        draft=""
        sending={false}
        maxTextLength={2000}
        error={undefined}
        assistant={assist}
        onDraftChange={() => undefined}
        onSend={() => undefined}
        onDisconnect={() => undefined}
        onBlock={() => undefined}
        onUseSuggestion={() => undefined}
        onAskOpen={() => undefined}
        onAskClose={() => undefined}
        onAskChangeQuery={() => undefined}
        onAskSubmit={() => undefined}
        onAskRegenerate={() => undefined}
        onAskDismissSuggestion={() => undefined}
      />,
    );
    expect(screen.getByTestId('chat-assist-panel')).toBeInTheDocument();
    expect(screen.getByTestId('chat-assist-query')).toBeInTheDocument();
    expect(screen.getByTestId('chat-assist-submit')).toBeInTheDocument();
  });

  it('renders suggestions with kind chips and Use/Edit/Dismiss buttons', () => {
    const display = {
      summary: 'Here are some thoughts.',
      suggestions: [
        { id: 'r0', kind: 'reply' as const, kindLabel: 'Reply', text: 'first reply', rationale: 'because' },
        { id: 't1', kind: 'topic' as const, kindLabel: 'Topic', text: 'first topic', rationale: '' },
      ],
    };
    render(
      <ChatView
        peerDisplayName="Bob"
        selfDisplayName="Alex"
        snapshot={makeSnapshot()}
        phase="open"
        draft=""
        sending={false}
        maxTextLength={2000}
        error={undefined}
        assistant={emptyAssist({ open: true, query: 'help', display })}
        onDraftChange={() => undefined}
        onSend={() => undefined}
        onDisconnect={() => undefined}
        onBlock={() => undefined}
        onUseSuggestion={() => undefined}
        onAskOpen={() => undefined}
        onAskClose={() => undefined}
        onAskChangeQuery={() => undefined}
        onAskSubmit={() => undefined}
        onAskRegenerate={() => undefined}
        onAskDismissSuggestion={() => undefined}
      />,
    );
    const items = screen.getAllByTestId('chat-assist-suggestion');
    expect(items).toHaveLength(2);
    expect(items[0]?.getAttribute('data-kind')).toBe('reply');
    expect(items[1]?.getAttribute('data-kind')).toBe('topic');
    expect(screen.getAllByTestId('chat-assist-use').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByTestId('chat-assist-edit')).toHaveLength(2);
    expect(screen.getAllByTestId('chat-assist-dismiss')).toHaveLength(2);
    expect(screen.getByTestId('chat-assist-regenerate')).toBeInTheDocument();
  });

  it('hides dismissed suggestions', () => {
    const display = {
      summary: 'sum',
      suggestions: [
        { id: 'keep', kind: 'reply' as const, kindLabel: 'Reply', text: 'keep me', rationale: '' },
        { id: 'gone', kind: 'topic' as const, kindLabel: 'Topic', text: 'drop me', rationale: '' },
      ],
    };
    render(
      <ChatView
        peerDisplayName="Bob"
        selfDisplayName="Alex"
        snapshot={makeSnapshot()}
        phase="open"
        draft=""
        sending={false}
        maxTextLength={2000}
        error={undefined}
        assistant={emptyAssist({ open: true, query: 'help', display, dismissedIds: ['gone'] })}
        onDraftChange={() => undefined}
        onSend={() => undefined}
        onDisconnect={() => undefined}
        onBlock={() => undefined}
        onUseSuggestion={() => undefined}
        onAskOpen={() => undefined}
        onAskClose={() => undefined}
        onAskChangeQuery={() => undefined}
        onAskSubmit={() => undefined}
        onAskRegenerate={() => undefined}
        onAskDismissSuggestion={() => undefined}
      />,
    );
    expect(screen.getAllByTestId('chat-assist-suggestion')).toHaveLength(1);
  });

  it('Use fills the draft but never auto-sends (§ 32)', () => {
    const onUse = vi.fn();
    const onSend = vi.fn();
    const display = {
      summary: '',
      suggestions: [
        { id: 'r0', kind: 'reply' as const, kindLabel: 'Reply', text: 'the suggestion', rationale: '' },
      ],
    };
    render(
      <LiveChatView
        peerDisplayName="Bob"
        selfDisplayName="Alex"
        run={async () => makeSnapshot()}
        maxTextLength={2000}
        subscribe={undefined}
        onSend={onSend}
        onDisconnect={() => undefined}
        onBlock={() => undefined}
        chatAssist={null}
      />,
    );
    // LiveChatView starts with the panel closed and no display.
    // We can't directly inject a display into LiveChatView's state, but
    // we can simulate the Use pathway by directly testing ChatView with
    // a Use handler that calls onUse when the suggestion button is clicked.
    render(
      <ChatView
        peerDisplayName="Bob"
        selfDisplayName="Alex"
        snapshot={makeSnapshot()}
        phase="open"
        draft=""
        sending={false}
        maxTextLength={2000}
        error={undefined}
        assistant={emptyAssist({ open: true, query: 'help', display })}
        onDraftChange={() => undefined}
        onSend={onSend}
        onDisconnect={() => undefined}
        onBlock={() => undefined}
        onUseSuggestion={onUse}
        onAskOpen={() => undefined}
        onAskClose={() => undefined}
        onAskChangeQuery={() => undefined}
        onAskSubmit={() => undefined}
        onAskRegenerate={() => undefined}
        onAskDismissSuggestion={() => undefined}
      />,
    );
    fireEvent.click(screen.getByTestId('chat-assist-use'));
    expect(onUse).toHaveBeenCalledWith('the suggestion');
    // Critical: the suggestion click never invokes onSend — the user
    // must click Send themselves.
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('apps/desktop — LiveChatView (Phase 10 — Ask My Agent wiring)', () => {
  it('opens the panel and runs ask() when the user submits a query', async () => {
    const reply = {
      summary: 'ok',
      suggestions: [
        { kind: 'reply' as const, text: 'hello there', rationale: 'because' },
      ],
    };
    const chatAssist = makeChatAssist(JSON.stringify({
      summary: reply.summary,
      suggestions: reply.suggestions,
    }));
    const onSend = vi.fn();
    const onDisconnect = vi.fn();
    const onBlock = vi.fn();

    render(
      <LiveChatView
        peerDisplayName="Bob"
        selfDisplayName="Alex"
        run={async () => makeSnapshot()}
        maxTextLength={2000}
        subscribe={undefined}
        onSend={onSend}
        onDisconnect={onDisconnect}
        onBlock={onBlock}
        chatAssist={chatAssist}
      />,
    );

    // Wait for the snapshot to arrive.
    await waitFor(() => {
      expect(screen.queryByTestId('chat-assist-closed')).not.toBeNull();
    });

    // Click the Ask My Agent button.
    fireEvent.click(screen.getByTestId('chat-assist-open'));

    // Type a query and submit.
    const textarea = screen.getByTestId('chat-assist-query') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'help me reply' } });
    fireEvent.click(screen.getByTestId('chat-assist-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('chat-assist-suggestion')).not.toBeNull();
    });
    expect(screen.getByText('hello there')).toBeInTheDocument();
    // § 32: no auto-send.
    expect(onSend).not.toHaveBeenCalled();
  });

  it('Use fills the composer draft without auto-sending', async () => {
    const chatAssist = makeChatAssist(JSON.stringify({
      summary: '',
      suggestions: [{ kind: 'reply' as const, text: 'draft text', rationale: '' }],
    }));

    render(
      <LiveChatView
        peerDisplayName="Bob"
        selfDisplayName="Alex"
        run={async () => makeSnapshot()}
        maxTextLength={2000}
        subscribe={undefined}
        onSend={() => undefined}
        onDisconnect={() => undefined}
        onBlock={() => undefined}
        chatAssist={chatAssist}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByTestId('chat-assist-closed')).not.toBeNull();
    });

    fireEvent.click(screen.getByTestId('chat-assist-open'));
    fireEvent.change(screen.getByTestId('chat-assist-query'), {
      target: { value: 'help' },
    });
    fireEvent.click(screen.getByTestId('chat-assist-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('chat-assist-suggestion')).not.toBeNull();
    });
    fireEvent.click(screen.getByTestId('chat-assist-use'));

    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement;
    expect(input.value).toBe('draft text');
    // No auto-send: the chat history is still empty.
    expect(screen.getByTestId('chat-history-empty')).toBeInTheDocument();
  });

  it('renders the unavailable banner when chatAssist is null', async () => {
    render(
      <LiveChatView
        peerDisplayName="Bob"
        selfDisplayName="Alex"
        run={async () => makeSnapshot()}
        maxTextLength={2000}
        subscribe={undefined}
        onSend={() => undefined}
        onDisconnect={() => undefined}
        onBlock={() => undefined}
        chatAssist={null}
        chatAssistError="No LLM configured."
      />,
    );

    await waitFor(() => {
      expect(screen.queryByTestId('chat-assist-closed')).not.toBeNull();
    });
    const btn = screen.getByTestId('chat-assist-open') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function emptyAssist(overrides: Partial<ChatAssistPanelState> = {}): ChatAssistPanelState {
  return {
    open: false,
    busy: false,
    unavailable: false,
    unavailableReason: undefined,
    error: undefined,
    query: '',
    display: null,
    dismissedIds: [],
    ...overrides,
  };
}

function makeChatAssist(reply: string): ChatAssistHandle {
  const provider: LLMProvider & { calls: ChatMessage[][] } = {
    calls: [],
    async chat(messages: readonly ChatMessage[]): Promise<LLMResponse> {
      provider.calls.push([...messages]);
      return Object.freeze({ content: reply, model: 'fake' });
    },
  };
  // Build a minimal orchestrator — LiveChatView only calls `.ask()`.
  // We bypass the real constructor and expose just enough surface.
  return {
    orchestrator: {
      ask: async (q: string) => {
        const messages: readonly ChatMessage[] = Object.freeze([
          { role: 'system', content: 'fake system' },
          { role: 'user', content: q },
        ]);
        const response = await provider.chat(messages);
        return {
          reply: { summary: '', suggestions: [], ...JSON.parse(response.content) },
          messages,
          estimatedTokens: 1,
          rawResponse: response.content,
          degraded: false,
          degradationNote: null,
          boundaryBlocked: false,
        };
      },
    } as unknown as ChatAssistHandle['orchestrator'],
  };
}