/**
 * Local Demo Mode — the engine tests.
 *
 * The demo is a public-facing feature, so these tests check the two
 * things that matter for it:
 *
 *   1. **It is deterministic.** The same fixtures must always produce
 *      the same report — otherwise the screenshots in the README
 *      would not match what a visitor sees.
 *   2. **It is honest.** The report must say it was computed locally,
 *      and the peer's public card must not contain anything the real
 *      privacy filter would have withheld.
 *
 * It also checks that the demo never touches the network: a demo that
 * quietly called a provider would cost the visitor money and leak
 * their input, which is exactly what the demo promises not to do.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildDemoAuthorisedPeerProfile,
  buildDemoPeerIntroduction,
  createDemoLlmProvider,
  DEMO_PEER_AGENT_ID,
  DEMO_PEER_DISPLAY_NAME,
  DEMO_SELF_DISPLAY_NAME,
  demoPeerReply,
  runDemoIcebreaker,
  runDemoMatch,
} from '../lib/demo';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the local demo engine', () => {
  it('finds the common ground with the real heuristic engine', async () => {
    const run = await runDemoMatch();

    // "indie games" and "science fiction" are shared interests;
    // "building a home lab" is the shared activity. The real
    // `computeHeuristics` matches tags for equality, so these are the
    // only ones that can be shared.
    expect(run.localAnalysis.commonGround).toContain('indie games');
    expect(run.localAnalysis.commonGround).toContain('science fiction');
    expect(run.localAnalysis.commonGround).toContain('building a home lab');
  });

  it('reports a compatibility signal the numbers support', async () => {
    const run = await runDemoMatch();
    // Two of four interests shared, one of two activities shared and
    // a shared social intent put the composite above the demo's
    // "strong" threshold of 0.5.
    expect(run.localAnalysis.compatibilitySignal).toBe('strong');
  });

  it('names the interests only one side has, as friction', async () => {
    const run = await runDemoMatch();
    const friction = run.localAnalysis.potentialFriction.join(' ');

    expect(friction).toContain('drones');
    expect(friction).toContain('artificial intelligence');
  });

  it('says in the report that no language model was called', async () => {
    const run = await runDemoMatch();
    expect(run.localAnalysis.explanation).toMatch(/no language model was called/i);
  });

  it('is deterministic — the same input always gives the same report', async () => {
    const first = await runDemoMatch();
    const second = await runDemoMatch();

    expect(second.localAnalysis).toEqual(first.localAnalysis);
    expect(second.peerAnalysis).toEqual(first.peerAnalysis);
  });

  it('shows both sides of the report — the peer analysed the same pair', async () => {
    const run = await runDemoMatch();

    expect(run.peerAnalysis).not.toBeNull();
    expect(run.outcome.peerDisplayName).toBe(DEMO_PEER_DISPLAY_NAME);
    expect(run.outcome.peerAgentId).toBe(DEMO_PEER_AGENT_ID);
  });

  it('never touches the network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await runDemoMatch();
    await runDemoIcebreaker();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('generates icebreakers through the real parser', async () => {
    const result = await runDemoIcebreaker();

    expect(result.topics.length).toBeGreaterThan(0);
    expect(result.degraded).toBe(false);
    // The starters are grounded in what the two profiles share.
    expect(result.topics.join(' ').toLowerCase()).toMatch(/indie|science fiction/i);
  });

  it('keeps the peer public card free of everything the privacy filter withholds', () => {
    const peer = buildDemoPeerIntroduction();
    const card = peer.peerCard;

    expect(card).not.toBeNull();
    expect(card?.nickname).toBe(DEMO_PEER_DISPLAY_NAME);
    // The public card is the *minimal* disclosure — never the bio,
    // the interests or the current activities.
    expect(card?.bio).toBe('');
    expect(card?.interests).toEqual([]);
    expect(card?.currentActivities).toEqual([]);
    // The social intent and the conversation style are what the
    // consent screen is for, so they are on the card.
    expect(card?.socialIntent).toContain('similar_interests');
  });

  it('exposes the authorised profile only after the consent step', () => {
    const authorised = buildDemoAuthorisedPeerProfile();

    expect(authorised.interests).toContain('artificial intelligence');
    expect(authorised.currentActivities).toContain('playing a new indie release');
  });

  it('answers the same prompt with the same payload every time', async () => {
    const provider = createDemoLlmProvider();
    const messages = [{ role: 'system' as const, content: 'You are the social match analyst' }];

    const first = await provider.chat(messages);
    const second = await provider.chat(messages);

    expect(first.content).toBe(second.content);
    expect(JSON.parse(first.content)).toHaveProperty('compatibilitySignal');
  });

  it('answers the icebreaker prompt with a topics array', async () => {
    const provider = createDemoLlmProvider();
    const messages = [{ role: 'system' as const, content: 'You are the icebreaker generator' }];

    const response = await provider.chat(messages);
    const parsed = JSON.parse(response.content) as { topics?: unknown };

    expect(Array.isArray(parsed.topics)).toBe(true);
  });

  it('cycles the scripted peer replies deterministically', () => {
    expect(demoPeerReply(0)).toBe(demoPeerReply(3));
    expect(demoPeerReply(0)).not.toBe(demoPeerReply(1));
    expect(demoPeerReply(0)).toContain('indie games');
  });

  it('names the demo agents consistently', () => {
    const peer = buildDemoPeerIntroduction();
    expect(peer.peerDisplayName).toBe(DEMO_PEER_DISPLAY_NAME);
    expect(DEMO_SELF_DISPLAY_NAME).toBe('Nova');
  });
});
