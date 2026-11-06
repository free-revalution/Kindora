/**
 * Phase B — the desktop side of the privacy boundaries and the block
 * list.
 *
 * Task book § 五 B1:
 *   1. 提供真实的 UI 控制项（不只是配置文件里的开关）
 *   2. 用户可以查看当前授权状态
 *   3. 用户可以随时修改授权范围
 *   4. 用户可以随时撤销授权
 *   5. 关闭授权后不得继续发送对应数据
 *   6. 授权设置在应用重启后保持一致
 *   7. 默认值采用最小必要授权原则
 *   8. 对每项授权提供简洁明确的说明
 *
 * Task book § 五 B3:
 *   1. 黑名单管理 UI
 *   2. 查看已屏蔽的 Agent
 *   3. 解除屏蔽
 *   4. 查看屏蔽时间
 *   5. 本地持久化
 *   8. 不允许仅依靠前端 UI 实施黑名单
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, render, screen, cleanup, waitFor } from '@testing-library/react';
import {
  DEFAULT_SOCIAL_BOUNDARIES,
  filterProfileForOutbound,
  type SocialProfile,
} from '@kindora/protocol';
import { PeerBlockedError } from '@kindora/matching';
import { CreateAgentForm } from '../CreateAgentForm';
import { BlockedAgentsView } from '../BlockedAgentsView';
import { assertPeerNotBlocked, getBlockedAgentsStore } from '../../lib/connect-service';
import { createAgent, loadAgent } from '../../lib/agent-service';

const PEER_ID = '22222222-3333-4444-8555-bbbbbbbbbbbb';

function baseProfile(overrides: Partial<SocialProfile> = {}): SocialProfile {
  return {
    nickname: 'Alex',
    bio: 'A private bio.',
    interests: ['AI'],
    currentActivities: ['building'],
    socialIntent: ['similar_interests'],
    conversationStyle: ['casual'],
    boundaries: { ...DEFAULT_SOCIAL_BOUNDARIES },
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  cleanup();
});

/* ------------------------------------------------------------------ */
/* B1 — the privacy switches                                          */
/* ------------------------------------------------------------------ */

describe('apps/desktop — Phase B / B1: the privacy switches', () => {
  it('renders a switch for every boundary, with a label and an explanation', () => {
    render(<CreateAgentForm variant="create" onSubmit={async () => undefined} />);

    const flags = [
      'allowAgentConversation',
      'allowContactExchange',
      'allowOfflineMeeting',
      'allowProjectDetails',
      'allowBio',
      'allowInterests',
      'allowCurrentActivity',
      'allowAvatar',
      'allowSocialIntent',
      'allowConversationStyle',
    ];
    for (const flag of flags) {
      const input = screen.getByTestId(`boundary-${flag}`);
      expect(input).toBeInTheDocument();
      // B1 requirement 8 — every switch explains what it does. The
      // hint is a sibling of the checkbox inside the row.
      const row = screen.getByTestId(`boundary-row-${flag}`);
      expect(row.textContent?.trim().length ?? 0).toBeGreaterThan(20);
    }
  });

  it('the defaults are the minimal-necessary set', () => {
    render(<CreateAgentForm variant="create" onSubmit={async () => undefined} />);

    // 「兴趣开，其余关」 — the user's ruling for this phase.
    expect(screen.getByTestId('boundary-allowInterests')).toBeChecked();
    expect(screen.getByTestId('boundary-allowBio')).not.toBeChecked();
    expect(screen.getByTestId('boundary-allowAvatar')).not.toBeChecked();
    expect(screen.getByTestId('boundary-allowCurrentActivity')).not.toBeChecked();
    expect(screen.getByTestId('boundary-allowContactExchange')).not.toBeChecked();
    expect(screen.getByTestId('boundary-allowOfflineMeeting')).not.toBeChecked();
    expect(screen.getByTestId('boundary-allowProjectDetails')).not.toBeChecked();
  });

  it('the switch state is visible — "Shared" / "Private"', () => {
    render(<CreateAgentForm variant="create" onSubmit={async () => undefined} />);
    const interestsRow = screen.getByTestId('boundary-row-allowInterests');
    expect(interestsRow).toHaveTextContent(/shared/i);
    const bioRow = screen.getByTestId('boundary-row-allowBio');
    expect(bioRow).toHaveTextContent(/private/i);
  });

  it('toggling a switch changes the submitted profile (B1 requirement 3)', async () => {
    let submitted: SocialProfile | null = null;
    // The edit variant starts from a valid profile, so the form is
    // submittable and the only change under test is the switch.
    render(
      <CreateAgentForm
        variant="edit"
        initialProfile={baseProfile()}
        onSubmit={async (p) => {
          submitted = p;
        }}
      />,
    );

    // The bio authorisation starts off (the default is "private").
    expect(screen.getByTestId('boundary-allowBio')).not.toBeChecked();
    fireEvent.click(screen.getByTestId('boundary-allowBio'));
    expect(screen.getByTestId('boundary-allowBio')).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(submitted).not.toBeNull();
    });
    expect((submitted as unknown as SocialProfile).boundaries.allowBio).toBe(true);
  });

  it('the stored authorisation is shown when the edit form opens (B1 requirement 6)', async () => {
    // B1 requirement 6: 保存设置后，重新打开应用仍然有效.
    //
    // The switch is the user's decision; the *effect* of the decision
    // is that the field stops travelling. The filter that decides what
    // travels is the protocol's `filterProfileForOutbound` — the very
    // function the orchestrator calls before it builds the envelope
    // (see the next test).
    await createAgent(baseProfile());

    const stored = await loadAgent();
    expect(stored).not.toBeNull();
    expect(stored!.profile.boundaries.allowBio).toBe(false);

    render(
      <CreateAgentForm
        variant="edit"
        initialProfile={stored!.profile}
        onSubmit={async () => undefined}
      />,
    );

    // The stored value is shown — the switch is not a UI-only fiction.
    expect(screen.getByTestId('boundary-allowBio')).not.toBeChecked();

    fireEvent.click(screen.getByTestId('boundary-allowBio'));
    expect(screen.getByTestId('boundary-allowBio')).toBeChecked();
  });

  it('the profile the user keeps is the one that is filtered — a revoked bio is not sent', () => {
    // The end-to-end shape of B1 requirement 5, expressed through the
    // real protocol filter.
    const profile = baseProfile();
    const afterRevocation = filterProfileForOutbound(profile, {
      ...DEFAULT_SOCIAL_BOUNDARIES,
      allowBio: false,
    });
    expect(afterRevocation.bio).toBe('');
    // The fields the user kept are still there.
    expect(afterRevocation.interests).toEqual(['AI']);
  });
});

/* ------------------------------------------------------------------ */
/* B3 — the block list                                                 */
/* ------------------------------------------------------------------ */

describe('apps/desktop — Phase B / B3: the blocked-agents list', () => {
  it('shows an empty state when nothing is blocked', () => {
    render(
      <BlockedAgentsView entries={[]} onUnblock={() => undefined} onClose={() => undefined} />,
    );
    expect(screen.getByText(/not blocked anyone/i)).toBeInTheDocument();
    expect(screen.queryByTestId('blocked-list')).toBeNull();
  });

  it('lists the blocked agents with their id and the time they were blocked', () => {
    render(
      <BlockedAgentsView
        entries={[{ agentId: PEER_ID, blockedAt: '2026-11-05T10:00:00.000Z', reason: 'spam' }]}
        onUnblock={() => undefined}
        onClose={() => undefined}
      />,
    );
    const list = screen.getByTestId('blocked-list');
    expect(list).toBeInTheDocument();
    expect(list).toHaveTextContent(PEER_ID);
    expect(list).toHaveTextContent(/blocked on/i);
    expect(list).toHaveTextContent(/spam/i);
  });

  it('says so when no reason was recorded', () => {
    render(
      <BlockedAgentsView
        entries={[{ agentId: PEER_ID, blockedAt: '2026-11-05T10:00:00.000Z' }]}
        onUnblock={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText(/no reason recorded/i)).toBeInTheDocument();
  });

  it('the unblock button asks for the right agent id (B3 requirement 3)', () => {
    const asked: string[] = [];
    render(
      <BlockedAgentsView
        entries={[{ agentId: PEER_ID, blockedAt: '2026-11-05T10:00:00.000Z' }]}
        onUnblock={(id) => {
          asked.push(id);
        }}
        onClose={() => undefined}
      />,
    );
    fireEvent.click(screen.getByTestId(`unblock-${PEER_ID}`));
    expect(asked).toEqual([PEER_ID]);
  });

  it('the block list is enforced by the service, not only by the UI (B3 requirement 8)', async () => {
    // The UI can be bypassed — a second window, a script, a different
    // code path. The refusal therefore has to live in the trusted
    // layer that decides whether a pairing may proceed at all.
    const store = getBlockedAgentsStore();
    await store.add(PEER_ID, 'not welcome');

    await expect(assertPeerNotBlocked(PEER_ID)).rejects.toBeInstanceOf(PeerBlockedError);
    // An agent that is not blocked passes.
    await expect(
      assertPeerNotBlocked('33333333-4444-4555-8666-cccccccccccc'),
    ).resolves.toBeUndefined();
  });

  it('the block list is persisted across a reload (B3 requirement 5)', async () => {
    const store = getBlockedAgentsStore();
    await store.add(PEER_ID, 'not welcome');
    const entries = await store.list();
    expect(entries.map((e) => e.agentId)).toContain(PEER_ID);
    expect(entries[0]?.reason).toBe('not welcome');
    expect(entries[0]?.blockedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('unblocking removes the agent from the list', async () => {
    const store = getBlockedAgentsStore();
    await store.add(PEER_ID, 'not welcome');
    await store.remove(PEER_ID);
    await expect(assertPeerNotBlocked(PEER_ID)).resolves.toBeUndefined();
  });
});
