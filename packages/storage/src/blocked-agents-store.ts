/**
 * Blocked-agents store — Phase 7.
 *
 * Tracks the agent ids the local user has chosen to block. Consulted
 * at every pairing attempt: the host refuses to start a room for a
 * blocked peer; the joiner refuses to send a `hello` to a blocked host.
 *
 * Persisted in plain localStorage (no API keys, no private keys, just
 * opaque UUIDs). See 开发手册.md § 11, Phase 7.
 */

const STORAGE_KEY = 'kindora:phase7:blocked-agents:v1';

/** A single entry in the local block list. */
export interface BlockedAgent {
  /** The peer's agent id (UUID v4). */
  readonly agentId: string;
  /** When the user blocked them (ISO-8601). */
  readonly blockedAt: string;
  /** Optional human-readable reason. Never sent to the peer. */
  readonly reason?: string;
}

export interface BlockedAgentsStore {
  /** Snapshot the current block list. Ordered by `blockedAt` desc. */
  list(): Promise<readonly BlockedAgent[]>;
  /** True iff the given agent id is currently blocked. */
  has(agentId: string): Promise<boolean>;
  /**
   * Add an agent id to the block list. Idempotent — re-blocking an
   * already-blocked id updates the `reason` and `blockedAt` instead
   * of duplicating.
   */
  add(agentId: string, reason?: string): Promise<void>;
  /** Remove an agent id from the block list. No-op if not blocked. */
  remove(agentId: string): Promise<void>;
  /** Wipe the entire block list. */
  clear(): Promise<void>;
}

function getStorage(): Storage {
  if (typeof globalThis.localStorage === 'undefined') {
    throw new Error('localStorage is not available in this runtime.');
  }
  return globalThis.localStorage;
}

function isValidAgentId(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function sortByBlockedAtDesc(a: BlockedAgent, b: BlockedAgent): number {
  return b.blockedAt.localeCompare(a.blockedAt);
}

export class BrowserLocalStorageBlockedAgentsStore implements BlockedAgentsStore {
  async list(): Promise<readonly BlockedAgent[]> {
    const raw = getStorage().getItem(STORAGE_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      const valid = parsed.filter(
        (e): e is BlockedAgent =>
          typeof e === 'object' &&
          e !== null &&
          isValidAgentId((e as { agentId?: unknown }).agentId) &&
          typeof (e as { blockedAt?: unknown }).blockedAt === 'string',
      );
      return [...valid].sort(sortByBlockedAtDesc);
    } catch {
      return [];
    }
  }

  async has(agentId: string): Promise<boolean> {
    const all = await this.list();
    return all.some((e) => e.agentId === agentId);
  }

  async add(agentId: string, reason?: string): Promise<void> {
    if (!isValidAgentId(agentId)) {
      throw new Error(`Invalid agent id: ${JSON.stringify(agentId)}`);
    }
    const all = await this.list();
    const filtered = all.filter((e) => e.agentId !== agentId);
    const entry: BlockedAgent = {
      agentId,
      blockedAt: new Date().toISOString(),
      ...(reason !== undefined ? { reason } : {}),
    };
    filtered.unshift(entry);
    getStorage().setItem(STORAGE_KEY, JSON.stringify(filtered));
  }

  async remove(agentId: string): Promise<void> {
    const all = await this.list();
    const filtered = all.filter((e) => e.agentId !== agentId);
    getStorage().setItem(STORAGE_KEY, JSON.stringify(filtered));
  }

  async clear(): Promise<void> {
    getStorage().removeItem(STORAGE_KEY);
  }
}

/** Pure in-memory implementation, handy for tests. */
export class InMemoryBlockedAgentsStore implements BlockedAgentsStore {
  private readonly entries = new Map<string, BlockedAgent>();

  async list(): Promise<readonly BlockedAgent[]> {
    return [...this.entries.values()].sort(sortByBlockedAtDesc);
  }

  async has(agentId: string): Promise<boolean> {
    return this.entries.has(agentId);
  }

  async add(agentId: string, reason?: string): Promise<void> {
    if (!isValidAgentId(agentId)) {
      throw new Error(`Invalid agent id: ${JSON.stringify(agentId)}`);
    }
    const entry: BlockedAgent = {
      agentId,
      blockedAt: new Date().toISOString(),
      ...(reason !== undefined ? { reason } : {}),
    };
    this.entries.set(agentId, entry);
  }

  async remove(agentId: string): Promise<void> {
    this.entries.delete(agentId);
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }
}
