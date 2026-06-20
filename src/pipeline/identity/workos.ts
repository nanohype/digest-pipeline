/**
 * WorkOS Directory Sync Identity Resolver
 *
 * Resolves GitHub/Linear/Slack handles to canonical employee records
 * against the injected WorkOsDirectoryClient. 4-hour in-process cache
 * keeps the weekly run inside rate limits and avoids re-walking the
 * directory for repeat lookups of the same handle within a run.
 */

import type { ResolvedIdentity } from '../types.js';
import { withRetry, withTimeout } from '../utils/resilience.js';
import { getLogger } from '../../common/logger.js';
import type { DirectoryUser, ExternalIdType, WorkOsDirectoryClient } from '../services/workos-directory.js';

const TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 4 * 60 * 60 * 1000;

interface CacheEntry {
  identity: ResolvedIdentity;
  expiresAt: number;
}

export class WorkOsIdentityResolver {
  private cache = new Map<string, CacheEntry>();
  private directory: WorkOsDirectoryClient;

  constructor(directory: WorkOsDirectoryClient) {
    this.directory = directory;
  }

  async resolveSlackUser(slackUserId: string): Promise<ResolvedIdentity | null> {
    return this.resolveByExternalId('slack', slackUserId);
  }

  async resolveGitHubUser(githubLogin: string): Promise<ResolvedIdentity | null> {
    return this.resolveByExternalId('github', githubLogin);
  }

  async resolveLinearUser(linearUserId: string): Promise<ResolvedIdentity | null> {
    return this.resolveByExternalId('linear', linearUserId);
  }

  async batchResolve(
    handles: Array<{ type: ExternalIdType; value: string }>
  ): Promise<Map<string, ResolvedIdentity | null>> {
    const results = new Map<string, ResolvedIdentity | null>();
    const BATCH_SIZE = 10;
    for (let i = 0; i < handles.length; i += BATCH_SIZE) {
      const batch = handles.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async ({ type, value }) => {
          const identity = await this.resolveByExternalId(type, value);
          results.set(`${type}:${value}`, identity);
        })
      );
    }
    return results;
  }

  async getRecentJoiners(since: Date): Promise<ResolvedIdentity[]> {
    const users = await withRetry(() => withTimeout(this.directory.listUsersSince(since), TIMEOUT_MS), {
      attempts: 3,
      initialDelay: 200,
      jitter: true,
    });
    return users.map((u) => this.toResolvedIdentity(u));
  }

  private async resolveByExternalId(type: ExternalIdType, value: string): Promise<ResolvedIdentity | null> {
    const cacheKey = `${type}:${value}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) return cached.identity;
    try {
      const user = await withRetry(() => withTimeout(this.directory.findByExternalId(type, value), TIMEOUT_MS), {
        attempts: 3,
        initialDelay: 200,
        jitter: true,
      });
      if (!user) return null;
      const identity = this.toResolvedIdentity(user);
      this.cache.set(cacheKey, { identity, expiresAt: Date.now() + CACHE_TTL_MS });
      return identity;
    } catch (error) {
      getLogger().warn({ source: type, externalId: value, err: error }, 'identity.resolve-failed');
      return null;
    }
  }

  private toResolvedIdentity(user: DirectoryUser): ResolvedIdentity {
    return {
      userId: user.id,
      displayName: user.displayName,
      role: user.title ?? 'Team Member',
      team: user.department ?? 'Unknown Team',
    };
  }
}
