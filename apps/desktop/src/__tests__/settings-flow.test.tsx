import { describe, it, expect, beforeEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import App from '../App';

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
  fireEvent.change(screen.getByPlaceholderText(/add an interest/i), {
    target: { value: 'AI' },
  });
  fireEvent.keyDown(screen.getByPlaceholderText(/add an interest/i), { key: 'Enter' });
  fireEvent.click(screen.getByText(/meet people with similar interests/i));
  fireEvent.click(screen.getByRole('button', { name: 'Casual' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }));
  await waitFor(() => screen.getByText('Sam'));
}

describe('apps/desktop — Settings flow', () => {
  it('opens Settings from Home and persists the LLM config', async () => {
    // 1) Create an agent
    render(<App />);
    await createAgentFromWelcome();

    // 2) Open Settings
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    });
    await screen.findByText('LLM Provider');

    // 3) Switch provider to Anthropic — baseUrl/model should auto-update
    const providerSelect = screen.getByDisplayValue('OpenAI-compatible');
    await act(async () => {
      fireEvent.change(providerSelect, { target: { value: 'anthropic' } });
    });
    await screen.findByDisplayValue('claude-sonnet-4-5');

    // 4) Enter API key
    const apiKeyInput = screen.getByPlaceholderText(/sk-/) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(apiKeyInput, { target: { value: 'sk-ant-test-1234' } });
    });
    await waitFor(() => expect(apiKeyInput.value).toBe('sk-ant-test-1234'));

    // 5) Click Save and wait for it to complete (apiKey input is cleared)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    await waitFor(() => expect(apiKeyInput.value).toBe(''));

    // 6) Verify persistence
    expect(localStorage.getItem('kindora:settings:llmConfig')).not.toBeNull();
    const settings = JSON.parse(localStorage.getItem('kindora:settings:llmConfig')!);
    expect(settings.provider).toBe('anthropic');
    expect(settings.model).toBe('claude-sonnet-4-5');

    const secretRaw = localStorage.getItem('kindora:secret:llm:anthropic:api-key');
    expect(secretRaw).not.toBeNull();
    expect(secretRaw).not.toContain('sk-ant-test-1234');
  });

  it('Test Connection surfaces a server error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'unauthorized' } }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    render(<App />);
    await createAgentFromWelcome();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    });
    await screen.findByText('LLM Provider');

    const apiKeyInput = screen.getByPlaceholderText(/sk-/) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(apiKeyInput, { target: { value: 'bad-key' } });
    });
    await waitFor(() => expect(apiKeyInput.value).toBe('bad-key'));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }));
    });

    await waitFor(() => {
      expect(screen.getByText(/invalid api key/i)).toBeInTheDocument();
    });
  });
});
