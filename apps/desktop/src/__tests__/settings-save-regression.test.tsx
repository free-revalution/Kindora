/**
 * Regression tests for the "API key cannot be saved" defect.
 *
 * Three independent defects, one user-visible symptom (nothing happened):
 *
 *   D1  `handleSave` had `try/finally` with no `catch`, so a rejected
 *       `saveLLMConfig` became an unhandled promise rejection and rendered
 *       nothing.
 *   D2  There was no success feedback either. The only observable effect of a
 *       successful save was the API-key input clearing — which is exactly what
 *       a failed save looks like from the outside.
 *   D3  The hydration `useEffect` depended on `provider`, so switching provider
 *       re-ran it, re-read the *saved* config and snapped the select back.
 *
 * Plus a latent one in `saveLLMConfig`: settings were written before the secret,
 * so a failed keychain write left the app configured against a key that was
 * never stored.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import App from '../App';
import { getSecretStore, saveLLMConfig } from '../lib/llm-service';

beforeEach(() => {
  localStorage.clear();
  cleanup();
  vi.restoreAllMocks();
});

async function createAgentFromWelcome() {
  fireEvent.click(await screen.findByText(/create my agent/i));
  fireEvent.change(screen.getByPlaceholderText('Jason'), { target: { value: 'Sam' } });
  fireEvent.change(screen.getByPlaceholderText(/software engineer/i), {
    target: { value: 'Hello world.' },
  });
  fireEvent.change(screen.getByPlaceholderText(/add an interest/i), { target: { value: 'AI' } });
  fireEvent.keyDown(screen.getByPlaceholderText(/add an interest/i), { key: 'Enter' });
  fireEvent.click(screen.getByText(/meet people with similar interests/i));
  fireEvent.click(screen.getByRole('button', { name: 'Casual' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }));
  await waitFor(() => screen.getByText('Sam'));
}

async function openSettings() {
  // `findBy*` first: a fresh `<App />` starts on the "loading" screen and only
  // reaches Home after the agent has been read back from disk. Waiting for the
  // button (instead of querying it directly) is what makes this helper work
  // for a second render in the same test, where the agent already exists.
  const settingsButton = await screen.findByRole('button', { name: 'Settings' });
  await act(async () => {
    fireEvent.click(settingsButton);
  });
  await screen.findByText('LLM Provider');
}

/**
 * The provider `<select>`.
 *
 * Not `getByRole('combobox')` — the `<datalist id="model-suggestions">` carries
 * the same implicit role, so that query is ambiguous.
 */
function providerSelect(): HTMLSelectElement {
  return screen.getByLabelText('Provider') as HTMLSelectElement;
}

describe('apps/desktop — Settings save feedback', () => {
  it('shows an explicit success banner after saving (D2)', async () => {
    render(<App />);
    await createAgentFromWelcome();
    await openSettings();

    const apiKeyInput = screen.getByPlaceholderText(/sk-/) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(apiKeyInput, { target: { value: 'sk-test-1234' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });

    // D2: the save must announce itself. Asserting only on the cleared input
    // is what let the original bug through — a failure clears nothing and a
    // success clears the input, so the old assertion could not tell them apart.
    await waitFor(() => expect(screen.getByText(/Saved\./)).toBeInTheDocument());
    expect(screen.getByText(/API key stored locally/)).toBeInTheDocument();
    expect(apiKeyInput.value).toBe('');
  });

  it('surfaces a failure instead of swallowing it, keeps the key, and writes nothing (D1)', async () => {
    const secrets = getSecretStore();
    vi.spyOn(secrets, 'set').mockRejectedValue(new Error('keychain is locked'));

    render(<App />);
    await createAgentFromWelcome();
    await openSettings();

    const apiKeyInput = screen.getByPlaceholderText(/sk-/) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(apiKeyInput, { target: { value: 'sk-test-1234' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });

    // D1: the rejection must reach the screen.
    await waitFor(() => {
      expect(screen.getByText(/Could not save: keychain is locked/)).toBeInTheDocument();
    });

    // The typed key must survive so the user can retry without retyping it.
    expect(apiKeyInput.value).toBe('sk-test-1234');

    // And `saveLLMConfig` must be atomic: the secret is written first, so a
    // failed secret write means the settings half was never persisted. Without
    // the reorder, this would leave a config pointing at a missing key.
    expect(localStorage.getItem('kindora:settings:llmConfig')).toBeNull();
  });

  it('does not revert a provider change made after a config was saved (D3)', async () => {
    // Seed the saved config directly instead of driving the Save button, so this
    // test fails ONLY on D3 and not on the missing success banner. Otherwise a
    // D1/D2 regression would mask the provider-revert regression behind it.
    localStorage.setItem(
      'kindora:settings:llmConfig',
      JSON.stringify({
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        baseUrl: 'https://api.anthropic.com',
      }),
    );

    render(<App />);
    await createAgentFromWelcome();
    await openSettings();

    // Hydration from disk.
    await waitFor(() => expect(providerSelect().value).toBe('anthropic'));

    // Now switch provider. Before the fix the hydration effect re-ran, re-read
    // `llmConfig`, and called setProvider('anthropic') — undoing the choice, and
    // then saving the key under the wrong provider name.
    await act(async () => {
      fireEvent.change(providerSelect(), { target: { value: 'ollama' } });
    });

    expect(providerSelect().value).toBe('ollama');
    await waitFor(() =>
      expect(screen.getByDisplayValue('http://localhost:11434')).toBeInTheDocument(),
    );
    expect(providerSelect().value).toBe('ollama');
  });

  it('makes the saved API key take effect immediately, not only after a restart (D4)', async () => {
    // D4: the save used to be *inert*. The App read whether an LLM provider
    // was usable exactly once, at startup, and cached it. Saving the key in
    // Settings wrote to disk and showed a green "Saved" banner, but the
    // cached value never changed — so the Connect screen kept saying "LLM
    // not configured" and refused to show a pairing code until the user
    // restarted the app. A success banner that changes nothing is worse than
    // no banner at all.
    render(<App />);
    await createAgentFromWelcome();
    await openSettings();

    const apiKeyInput = screen.getByPlaceholderText(/sk-/) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(apiKeyInput, { target: { value: 'sk-test-1234' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(screen.getByText(/Saved\./)).toBeInTheDocument());

    // Leave Settings and open Connect.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect Agent' }));
    });

    // The saved key must be usable now.
    //
    // The status refresh is asynchronous (`onSaved` re-reads the config from
    // disk), so the banner assertion goes inside `waitFor`: a plain
    // `expect(...).not.toBeInTheDocument()` would race the refresh and fail
    // on a working save.
    await waitFor(() => expect(screen.queryByText(/LLM not configured/i)).not.toBeInTheDocument());
    expect(await screen.findByTestId('host-pairing-code')).toBeInTheDocument();
  });

  it('explains a missing key instead of saying "not configured" (D5)', async () => {
    // D5: a provider saved without its key (exactly what a failed keychain
    // write leaves behind) and a provider that was never configured look
    // identical to the user. They have different fixes, so the app has to
    // say which one it is.
    await saveLLMConfig({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      baseUrl: 'https://api.anthropic.com',
    });

    render(<App />);
    await createAgentFromWelcome();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect Agent' }));
    });

    expect(await screen.findByText(/API key not found/i)).toBeInTheDocument();
    expect(screen.queryByText(/LLM not configured/i)).not.toBeInTheDocument();
  });

  it('shows that a key is already stored after a restart (D6)', async () => {
    // D6: the field used to be blank after a restart, which read as "the
    // key was never saved". `hasExistingKey` was only ever set by
    // `handleSave`, so a key stored in a previous session was invisible:
    // the placeholder showed the empty "sk-…" instead of "saved".
    const first = render(<App />);
    await createAgentFromWelcome();
    await openSettings();

    const apiKeyInput = screen.getByPlaceholderText(/sk-/) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(apiKeyInput, { target: { value: 'sk-test-1234' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(screen.getByText(/Saved\./)).toBeInTheDocument());

    first.unmount();
    cleanup();

    // A fresh session must be able to tell that a key is stored — by
    // asking the secret store, not by remembering it in component state.
    render(<App />);
    await openSettings();
    await waitFor(() => expect(screen.getByPlaceholderText(/saved/i)).toBeInTheDocument());
    // The placeholder alone is weak evidence — it disappears the moment
    // the field is focused. There is an explicit line saying a key IS
    // stored, and the remove affordance next to it.
    expect(screen.getByText(/an api key is stored for this provider/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /remove saved key/i })).toBeInTheDocument();
  });

  it('does not delete the stored key when saving without typing a new one (D7)', async () => {
    // D7: the field is blank after a restart (the stored key is never
    // displayed), so "save" was reached with an empty input — and an
    // empty input used to mean "delete the stored key". The user lost
    // the key by touching Save. An empty field now means "keep what is
    // stored".
    render(<App />);
    await createAgentFromWelcome();
    await openSettings();

    const apiKeyInput = screen.getByPlaceholderText(/sk-/) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(apiKeyInput, { target: { value: 'sk-test-1234' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(screen.getByText(/Saved\./)).toBeInTheDocument());

    // Save again, without typing anything this time.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(screen.getByText(/Saved\./)).toBeInTheDocument());

    const secrets = getSecretStore();
    expect(await secrets.get('llm:openai-compatible:api-key')).not.toBeNull();
  });

  it('removes the stored key only when the user asks for it (D8)', async () => {
    render(<App />);
    await createAgentFromWelcome();
    await openSettings();

    const apiKeyInput = screen.getByPlaceholderText(/sk-/) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(apiKeyInput, { target: { value: 'sk-test-1234' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(screen.getByText(/Saved\./)).toBeInTheDocument());

    // The explicit remove affordance appears only once a key is stored.
    const remove = await screen.findByRole('button', { name: /remove saved key/i });
    await act(async () => {
      fireEvent.click(remove);
    });

    await waitFor(() => expect(screen.getByText(/saved api key removed/i)).toBeInTheDocument());
    const secrets = getSecretStore();
    expect(await secrets.get('llm:openai-compatible:api-key')).toBeNull();
  });
});
