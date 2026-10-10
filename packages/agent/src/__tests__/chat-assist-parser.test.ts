import { describe, it, expect } from 'vitest';
import {
  parseChatAssistReply,
  MAX_CHAT_ASSIST_SUGGESTIONS,
} from '../output-parser';

describe('@kindora/agent — parseChatAssistReply', () => {
  it('parses a well-formed JSON object with summary + suggestions', () => {
    const raw = JSON.stringify({
      summary: 'Here are a few ways to keep things moving.',
      suggestions: [
        {
          kind: 'reply',
          text: 'Yeah, the hardest part for me has been balancing concurrency vs. simplicity.',
          rationale: 'You both just talked about distributed systems.',
        },
        {
          kind: 'topic',
          text: 'What part of your current project excites you most right now?',
          rationale: 'Both sides mentioned an open-source Agent.',
        },
        {
          kind: 'explanation',
          text: 'They appear to be hinting they have bandwidth for a chat next week.',
          rationale: 'Their last message mentioned a slower week.',
        },
      ],
    });
    const out = parseChatAssistReply(raw);
    expect(out.degraded).toBe(false);
    expect(out.note).toBeNull();
    expect(out.reply.summary).toContain('keep things moving');
    expect(out.reply.suggestions).toHaveLength(3);
    expect(out.reply.suggestions[0]?.kind).toBe('reply');
    expect(out.reply.suggestions[1]?.kind).toBe('topic');
    expect(out.reply.suggestions[2]?.kind).toBe('explanation');
  });

  it('caps suggestions to MAX_CHAT_ASSIST_SUGGESTIONS', () => {
    const raw = JSON.stringify({
      summary: 'Lots to choose from.',
      suggestions: Array.from({ length: 10 }, (_, i) => ({
        kind: 'reply',
        text: `reply ${i}`,
        rationale: '',
      })),
    });
    const out = parseChatAssistReply(raw);
    expect(out.reply.suggestions).toHaveLength(MAX_CHAT_ASSIST_SUGGESTIONS);
  });

  it('drops suggestions with invalid kind', () => {
    const raw = JSON.stringify({
      summary: '',
      suggestions: [
        { kind: 'reply', text: 'keep me', rationale: '' },
        { kind: 'nope', text: 'drop me', rationale: '' },
        { kind: 'topic', text: 'keep me too', rationale: '' },
      ],
    });
    const out = parseChatAssistReply(raw);
    // The valid suggestions survive; the malformed one is silently
    // dropped. degraded is NOT set — the array itself is well-formed;
    // it's the dropped entry that doesn't degrade the parse.
    expect(out.reply.suggestions).toHaveLength(2);
    expect(out.reply.suggestions.map((s) => s.text)).toEqual(['keep me', 'keep me too']);
  });

  it('drops suggestions with empty text', () => {
    const raw = JSON.stringify({
      summary: '',
      suggestions: [
        { kind: 'reply', text: '   ', rationale: '' },
        { kind: 'reply', text: 'keep me', rationale: '' },
      ],
    });
    const out = parseChatAssistReply(raw);
    expect(out.reply.suggestions).toHaveLength(1);
  });

  it('caps each text and rationale length', () => {
    const raw = JSON.stringify({
      summary: '',
      suggestions: [
        { kind: 'reply', text: 'x'.repeat(2000), rationale: 'y'.repeat(2000) },
      ],
    });
    const out = parseChatAssistReply(raw);
    const s = out.reply.suggestions[0];
    expect(s).toBeDefined();
    expect(s!.text.length).toBeLessThanOrEqual(200);
    expect(s!.rationale.length).toBeLessThanOrEqual(200);
  });

  it('returns degraded=true on invalid JSON', () => {
    const out = parseChatAssistReply('not json at all');
    expect(out.degraded).toBe(true);
    expect(out.reply.suggestions).toEqual([]);
    expect(out.note).toMatch(/json-parse-failed/);
  });

  it('returns degraded=true on non-object JSON', () => {
    const out = parseChatAssistReply(JSON.stringify(['a', 'b']));
    expect(out.degraded).toBe(true);
    expect(out.reply.suggestions).toEqual([]);
  });

  it('treats missing suggestions field as degraded', () => {
    const out = parseChatAssistReply(JSON.stringify({ summary: 'no list' }));
    expect(out.degraded).toBe(true);
    expect(out.reply.suggestions).toEqual([]);
    expect(out.note).toMatch(/suggestions/);
  });

  it('parses content wrapped in ```json fences', () => {
    const inner = JSON.stringify({
      summary: 'wrapped',
      suggestions: [{ kind: 'reply', text: 'reply', rationale: '' }],
    });
    const out = parseChatAssistReply('```json\n' + inner + '\n```');
    expect(out.degraded).toBe(false);
    expect(out.reply.suggestions).toHaveLength(1);
  });

  it('returns empty reply + degraded when suggestions is null', () => {
    const out = parseChatAssistReply(JSON.stringify({ summary: '', suggestions: null }));
    expect(out.degraded).toBe(true);
    expect(out.reply.suggestions).toEqual([]);
  });
});