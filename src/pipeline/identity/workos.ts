/**
 * WorkOS Directory Sync Identity Resolver
 *
 * Resolves GitHub/Linear/Slack handles to canonical employee records
 * against the injected WorkOsDirectoryClient (the vendored
 * @nanohype/runtime client — see src/vendor/runtime/workos-directory.ts).
 * The client is deliberately stateless, so the app-side concerns live
 * here: the external-id → directory custom-attribute mapping, and a
 * 4-hour in-process cache that keeps the weekly run inside rate limits
 * and avoids re-walking the directory for repeat lookups of the same
 * handle within a run.
 */

import { getLogger } from "../../common/logger.js";
import { withRetry, withTimeout } from "../../vendor/runtime/resilience.js";
import type {
  DirectoryUser,
  WorkOsDirectoryClient,
} from "../../vendor/runtime/workos-directory.js";
import type { ResolvedIdentity } from "../types.js";

const TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 4 * 60 * 60 * 1000;

export type ExternalIdType = "github" | "slack" | "linear";

// Which directory-user custom attribute carries each upstream handle.
// The custom attributes are populated by the IdP → WorkOS directory mapping.
const EXTERNAL_ID_ATTRIBUTE: Record<ExternalIdType, string> = {
  github: "githubLogin",
  slack: "slackUserId",
  linear: "linearUserId",
};

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
    return this.resolveByExternalId("slack", slackUserId);
  }

  async resolveGitHubUser(githubLogin: string): Promise<ResolvedIdentity | null> {
    return this.resolveByExternalId("github", githubLogin);
  }

  async resolveLinearUser(linearUserId: string): Promise<ResolvedIdentity | null> {
    return this.resolveByExternalId("linear", linearUserId);
  }

  private async resolveByExternalId(
    type: ExternalIdType,
    value: string,
  ): Promise<ResolvedIdentity | null> {
    const cacheKey = `${type}:${value}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) return cached.identity;
    try {
      const user = await withRetry(
        () =>
          withTimeout(
            this.directory.findByCustomAttribute(EXTERNAL_ID_ATTRIBUTE[type], value),
            TIMEOUT_MS,
            "workos.findByCustomAttribute",
          ),
        {
          attempts: 3,
          initialDelayMs: 200,
          jitter: true,
        },
      );
      if (!user) return null;
      const identity = this.toResolvedIdentity(user);
      this.cache.set(cacheKey, { identity, expiresAt: Date.now() + CACHE_TTL_MS });
      return identity;
    } catch (error) {
      getLogger().warn({ source: type, externalId: value, err: error }, "identity.resolve-failed");
      return null;
    }
  }

  private toResolvedIdentity(user: DirectoryUser): ResolvedIdentity {
    return {
      userId: user.id,
      displayName: user.displayName,
      role: user.title ?? "Team Member",
      team: user.department ?? "Unknown Team",
    };
  }
}
