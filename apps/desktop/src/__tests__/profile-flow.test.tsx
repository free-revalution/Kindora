import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import App from '../App';
import { createAgent, loadAgent } from '../lib/agent-service';

beforeEach(() => {
  localStorage.clear();
  cleanup();
});

describe('apps/desktop — Phase 1 profile flow', () => {
  it('starts on Welcome when no agent exists', async () => {
    render(<App />);
    expect(await screen.findByText(/create my agent/i)).toBeInTheDocument();
  });

  it('creates an agent end-to-end and lands on Home', async () => {
    render(<App />);
    fireEvent.click(await screen.findByText(/create my agent/i));

    fireEvent.change(screen.getByPlaceholderText('Jason'), {
      target: { value: 'Alex' },
    });
    fireEvent.change(screen.getByPlaceholderText(/software engineer/i), {
      target: { value: 'Indie dev building AI tools.' },
    });

    // Interests
    fireEvent.change(screen.getByPlaceholderText(/add an interest/i), {
      target: { value: 'AI' },
    });
    fireEvent.keyDown(screen.getByPlaceholderText(/add an interest/i), {
      key: 'Enter',
    });
    fireEvent.change(screen.getByPlaceholderText(/add an interest/i), {
      target: { value: 'Open Source' },
    });
    fireEvent.keyDown(screen.getByPlaceholderText(/add an interest/i), {
      key: 'Enter',
    });

    // Social intent
    fireEvent.click(screen.getByText(/meet people with similar interests/i));
    fireEvent.click(screen.getByText(/discuss technical topics/i));

    // Conversation style
    fireEvent.click(screen.getByRole('button', { name: 'Technical' }));

    fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }));

    await waitFor(() => {
      expect(screen.getByText('Alex')).toBeInTheDocument();
    });

    const stored = await loadAgent();
    expect(stored).not.toBeNull();
    expect(stored?.displayName).toBe('Alex');
    expect(stored?.profile.interests).toEqual(['AI', 'Open Source']);
    expect(stored?.profile.socialIntent).toEqual(['similar_interests', 'technical_discussion']);
    expect(stored?.profile.conversationStyle).toEqual(['technical']);
    expect(stored?.publicKey.length).toBeGreaterThan(0);
    expect(stored?.privateKey.length).toBeGreaterThan(0);
    expect(stored?.publicKey).not.toBe(stored?.privateKey);
  });

  it('blocks Create Agent when required fields are missing', async () => {
    render(<App />);
    fireEvent.click(await screen.findByText(/create my agent/i));

    const submit = screen.getByRole('button', { name: 'Create Agent' });
    expect(submit).toBeDisabled();

    // Fill only nickname
    fireEvent.change(screen.getByPlaceholderText('Jason'), {
      target: { value: 'Test' },
    });
    expect(submit).toBeDisabled();
  });

  it('opens Home directly when an agent already exists', async () => {
    await createAgent({
      nickname: 'Preexisting',
      bio: 'Already here.',
      interests: ['AI'],
      currentActivities: [],
      socialIntent: ['similar_interests'],
      conversationStyle: ['casual'],
      boundaries: {
        allowAgentConversation: true,
        allowContactExchange: false,
        allowOfflineMeeting: false,
        allowProjectDetails: false,
        allowCurrentActivity: true,
      },
    });

    render(<App />);
    expect(await screen.findByText('Preexisting')).toBeInTheDocument();
  });

  it('Edit Profile flow loads existing values and saves updates', async () => {
    const agent = await createAgent({
      nickname: 'Initial',
      bio: 'Old bio.',
      interests: ['AI'],
      currentActivities: [],
      socialIntent: ['similar_interests'],
      conversationStyle: ['casual'],
      boundaries: {
        allowAgentConversation: true,
        allowContactExchange: false,
        allowOfflineMeeting: false,
        allowProjectDetails: false,
        allowCurrentActivity: true,
      },
    });
    expect(agent.profile.nickname).toBe('Initial');

    render(<App />);
    fireEvent.click(await screen.findByText(/edit profile/i));

    const nicknameInput = await screen.findByDisplayValue('Initial');
    fireEvent.change(nicknameInput, { target: { value: 'Updated' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(screen.getByText('Updated')).toBeInTheDocument();
    });

    const stored = await loadAgent();
    expect(stored?.profile.nickname).toBe('Updated');
    expect(stored?.agentId).toBe(agent.agentId); // identity preserved
  });
});
