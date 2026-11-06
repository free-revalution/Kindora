/**
 * Live provider compatibility tests — Phase E2.
 *
 * **These tests only run when the environment explicitly asks for them.**
 * There are two switches, and both must be on:
 *
 * 1. `KINDORA_LLM_LIVE=1` — the master switch. Without it, *nothing* in this
 *    file runs, whatever else is set.
 * 2. The provider's own variables — a base URL and a model, plus a key for
 *    every provider that needs one.
 *
 * Without them the suite is *skipped*, never "passed": a skipped suite is
 * `NOT_RUN`, and `NOT_RUN` is not `VERIFIED` (task book § 八 E2, item 9).
 *
 * | provider | env vars | request shape |
 * | --- | --- | --- |
 * | OpenAI-compatible | `KINDORA_LLM_OPENAI_KEY`, `KINDORA_LLM_OPENAI_MODEL`, `KINDORA_LLM_OPENAI_BASE_URL` | `POST {base}/chat/completions`, `Authorization: Bearer <key>`, body `{ model, messages[], stream: false }` |
 * | Anthropic | `KINDORA_LLM_ANTHROPIC_KEY`, `KINDORA_LLM_ANTHROPIC_MODEL`, `KINDORA_LLM_ANTHROPIC_BASE_URL` | `POST {base}/v1/messages`, `x-api-key`, `anthropic-version: 2023-06-01`, body `{ model, system?, messages[], max_tokens }` |
 * | Ollama | `KINDORA_LLM_OLLAMA_MODEL`, `KINDORA_LLM_OLLAMA_BASE_URL` | `POST {base}/api/chat`, no auth, body `{ model, messages[], stream: false }` |
 * | MiniMax | `KINDORA_LLM_MINIMAX_KEY`, `KINDORA_LLM_MINIMAX_MODEL`, `KINDORA_LLM_MINIMAX_BASE_URL` | `POST {base}/chat/completions` (OpenAI-compatible), `Authorization: Bearer <key>` |
 *
 * The base URL is **required**, not defaulted. That is deliberate: Ollama
 * needs no API key, so a key cannot be used as the "is this configured?"
 * signal for it — and a suite that ran against `localhost:11434` by default
 * would fail on every machine that does not happen to run Ollama. Requiring
 * the URL means "run this suite" is always a deliberate act.
 *
 * The keys are read from the environment and are **never logged**: the
 * assertions only look at the response content and at error *codes*, never
 * at the key itself. Nothing in this file prints a request or a response
 * body.
 *
 * What is *not* covered here, and why:
 *
 * - **A real 429.** Provoking a rate limit means sending enough traffic to
 *   be throttled — that is abusive towards a shared service and it costs
 *   money. The 429 path is covered by the mock suite
 *   (`provider-errors.test.ts`), including the `Retry-After` handling.
 * - **A real timeout against a provider.** Aborting a request that the
 *   provider has already started is exactly the "may have been billed"
 *   case. The timeout path is covered against a **real socket** in
 *   `provider-timeout.test.ts` (no key needed, no external service) and
 *   against mocks in the unit suite.
 */

import { describe, it, expect } from 'vitest';
import {
  AnthropicProvider,
  OllamaProvider,
  OpenAICompatibleProvider,
  type LLMProvider,
} from '../index';

const PROMPT: readonly { role: 'user'; content: string }[] = [
  { role: 'user', content: 'Reply with exactly the word "ok" and nothing else.' },
];

/**
 * The master switch. Nothing live runs without it.
 *
 * Read once, at module load: an env var cannot change under us mid-run, and
 * reading it once keeps the decision auditable from the file alone.
 */
const LIVE_ENABLED = process.env['KINDORA_LLM_LIVE'] === '1';

interface LiveCase {
  readonly name: string;
  readonly keyEnv: string;
  readonly modelEnv: string;
  readonly baseUrlEnv: string;
  readonly build: (cfg: { baseUrl: string; model: string; apiKey?: string }) => LLMProvider;
}

const LIVE_CASES: readonly LiveCase[] = [
  {
    name: 'OpenAI-compatible',
    keyEnv: 'KINDORA_LLM_OPENAI_KEY',
    modelEnv: 'KINDORA_LLM_OPENAI_MODEL',
    baseUrlEnv: 'KINDORA_LLM_OPENAI_BASE_URL',
    build: (cfg) =>
      new OpenAICompatibleProvider({
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        apiKey: cfg.apiKey,
      }),
  },
  {
    name: 'Anthropic',
    keyEnv: 'KINDORA_LLM_ANTHROPIC_KEY',
    modelEnv: 'KINDORA_LLM_ANTHROPIC_MODEL',
    baseUrlEnv: 'KINDORA_LLM_ANTHROPIC_BASE_URL',
    build: (cfg) =>
      new AnthropicProvider({
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        apiKey: cfg.apiKey ?? '',
      }),
  },
  {
    name: 'Ollama',
    keyEnv: 'KINDORA_LLM_OLLAMA_KEY',
    modelEnv: 'KINDORA_LLM_OLLAMA_MODEL',
    baseUrlEnv: 'KINDORA_LLM_OLLAMA_BASE_URL',
    build: (cfg) =>
      new OllamaProvider({
        baseUrl: cfg.baseUrl,
        model: cfg.model,
      }),
  },
  {
    name: 'MiniMax',
    keyEnv: 'KINDORA_LLM_MINIMAX_KEY',
    modelEnv: 'KINDORA_LLM_MINIMAX_MODEL',
    baseUrlEnv: 'KINDORA_LLM_MINIMAX_BASE_URL',
    build: (cfg) =>
      new OpenAICompatibleProvider({
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        apiKey: cfg.apiKey,
      }),
  },
];

for (const c of LIVE_CASES) {
  const apiKey = process.env[c.keyEnv];
  const model = process.env[c.modelEnv];
  const baseUrl = process.env[c.baseUrlEnv];

  // Ollama needs no key; the others do. Missing either → skip, never pass.
  const needsKey = c.name !== 'Ollama';
  const configured =
    LIVE_ENABLED && Boolean(model) && Boolean(baseUrl) && (!needsKey || Boolean(apiKey));

  describe.skipIf(!configured)(`live — ${c.name}`, () => {
    it('completes a real round-trip', async () => {
      const provider = c.build({ baseUrl: baseUrl as string, model: model as string, apiKey });
      const res = await provider.chat(PROMPT, { maxTokens: 16, temperature: 0 });
      expect(res.content.length).toBeGreaterThan(0);
      expect(typeof res.model).toBe('string');
    });

    // Ollama has no key to get wrong, so the auth-failure test does not apply
    // to it — it is *skipped*, not silently passed.
    it.skipIf(!needsKey)('reports an invalid key as AUTHENTICATION_ERROR', async () => {
      const provider = c.build({
        baseUrl: baseUrl as string,
        model: model as string,
        apiKey: 'kindora-live-test-invalid-key',
      });
      const err = (await provider.chat(PROMPT, { maxTokens: 16 }).catch((e: unknown) => e)) as {
        code?: string;
      };
      expect(err.code).toBe('AUTHENTICATION_ERROR');
    });
  });
}
