/**
 * Local Demo Mode — the screen flow.
 *
 * The demo is the product's front door for a first-time visitor, so
 * these tests walk the click-through the way a visitor would and check
 * the two things that must never regress:
 *
 *   - the "simulated" banner is on **every** screen, so nobody can
 *     mistake the demo for a live session;
 *   - the flow actually reaches the match report.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DemoView } from '../DemoView';

beforeEach(() => {
  cleanup();
});

afterEach(() => {
  cleanup();
});

async function startDemo() {
  render(<DemoView onExit={() => undefined} />);
  fireEvent.click(screen.getByRole('button', { name: /start the demo/i }));
  await screen.findByText(/two agents, two people/i);
}

describe('the local demo screen', () => {
  it('says on the intro screen that nothing here is real', () => {
    render(<DemoView onExit={() => undefined} />);

    expect(screen.getByTestId('demo-banner')).toHaveTextContent(/local demo/i);
    expect(screen.getByText(/no language model is called/i)).toBeInTheDocument();
    expect(screen.getByText(/they are not real and not online/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing is sent anywhere/i)).toBeInTheDocument();
  });

  it('shows both demo agents on the meet screen', async () => {
    await startDemo();

    expect(screen.getByText('Nova')).toBeInTheDocument();
    expect(screen.getByText('Rin')).toBeInTheDocument();
    expect(screen.getAllByText('indie games').length).toBeGreaterThan(0);
  });

  it('keeps the banner on every step of the flow', async () => {
    await startDemo();
    expect(screen.getByTestId('demo-banner')).toBeInTheDocument();

    // Meet → Consent
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    await screen.findByTestId('consent-status');
    expect(screen.getByTestId('demo-banner')).toBeInTheDocument();
  });

  it('shows only the public card before the consent step', async () => {
    await startDemo();
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));

    const card = await screen.findByTestId('consent-public-card');
    // The peer's interests are NOT on the public card — they only
    // cross the wire after the human accepted.
    expect(card).toHaveTextContent('Rin');
    expect(card).not.toHaveTextContent('artificial intelligence');
  });

  it('reaches the match report after the human accepts', async () => {
    await startDemo();
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));

    const accept = await screen.findByTestId('consent-accept');
    fireEvent.click(accept);

    // The scripted peer accepts a moment later.
    await waitFor(() => screen.getByRole('button', { name: /continue to the match report/i }));
    fireEvent.click(screen.getByRole('button', { name: /continue to the match report/i }));

    await waitFor(() => screen.getByText(/common ground/i));
    expect(screen.getAllByText('indie games').length).toBeGreaterThan(0);
    // Both agents reported.
    expect(screen.getByText(/your agent says/i)).toBeInTheDocument();
    expect(screen.getByText(/their agent says/i)).toBeInTheDocument();
  });

  it('lets the human reject, and stops there', async () => {
    await startDemo();
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));

    fireEvent.click(await screen.findByTestId('consent-reject'));

    await waitFor(() => expect(screen.queryByTestId('consent-accept')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /continue to the match report/i })).toBeNull();
  });

  it('reaches the icebreaker and the chat', async () => {
    await startDemo();
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    fireEvent.click(await screen.findByTestId('consent-accept'));
    await waitFor(() => screen.getByRole('button', { name: /continue to the match report/i }));
    fireEvent.click(screen.getByRole('button', { name: /continue to the match report/i }));

    await waitFor(() => screen.getByText(/common ground/i));
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));

    // The icebreaker screen lists the generated starters.
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^use$/i }).length).toBeGreaterThan(0));
    expect(screen.getByTestId('demo-banner')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /continue to the chat/i }));

    await waitFor(() => screen.getByTestId('chat-header'));
    // The chat says out loud that the peer is scripted.
    expect(screen.getByText(/their three replies are fixed/i)).toBeInTheDocument();
  });
});
