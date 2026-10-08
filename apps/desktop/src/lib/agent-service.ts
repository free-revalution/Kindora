/**
 * Profile creation / editing service.
 *
 * Bridges the protocol types, agent identity generation, and storage.
 */

import {
  DEFAULT_AGENT_CAPABILITIES,
  DEFAULT_SOCIAL_BOUNDARIES,
  PROTOCOL_VERSION,
  type AgentCapabilities,
  type SocialProfile,
} from '@kindora/protocol';
import { buildCapabilities, createAgentIdentity } from '@kindora/agent';
import {
  BrowserLocalStorageProfileStore,
  type ProfileStore,
  type StoredAgent,
} from '@kindora/storage';

const _store: ProfileStore = new BrowserLocalStorageProfileStore();

export function getProfileStore(): ProfileStore {
  return _store;
}

/**
 * Create a new agent from scratch: identity (UUID + key pair) + profile.
 */
export async function createAgent(profile: SocialProfile): Promise<StoredAgent> {
  const identity = await createAgentIdentity();
  const capabilities: AgentCapabilities = buildCapabilities();
  const now = new Date().toISOString();

  const agent: StoredAgent = {
    agentId: identity.agentId,
    protocolVersion: PROTOCOL_VERSION,
    displayName: profile.nickname,
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
    profile,
    capabilities,
    createdAt: now,
    updatedAt: now,
  };

  await _store.saveAgent(agent);
  return agent;
}

/**
 * Update only the profile portion of an existing agent.
 */
export async function updateProfile(
  agent: StoredAgent,
  profile: SocialProfile,
): Promise<StoredAgent> {
  const updated: StoredAgent = {
    ...agent,
    displayName: profile.nickname,
    profile,
    updatedAt: new Date().toISOString(),
  };
  await _store.saveAgent(updated);
  return updated;
}

export async function loadAgent(): Promise<StoredAgent | null> {
  return _store.loadAgent();
}

export async function deleteAgent(): Promise<void> {
  await _store.deleteAgent();
}

/**
 * Build the V0.1 default profile. Used by "fill with sample" helpers.
 */
export function sampleProfile(): SocialProfile {
  return {
    nickname: '',
    bio: '',
    interests: [],
    currentActivities: [],
    socialIntent: ['similar_interests'],
    conversationStyle: ['technical'],
    boundaries: { ...DEFAULT_SOCIAL_BOUNDARIES },
    ...{},
  };
}

/**
 * Re-export the protocol defaults so views don't need a direct import.
 */
export { DEFAULT_AGENT_CAPABILITIES, DEFAULT_SOCIAL_BOUNDARIES };
