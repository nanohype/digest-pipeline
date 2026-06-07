/**
 * GitHub aggregator — merged PRs across the configured repos in the
 * window. Repo-level skip labels keep chores and internal PRs out of
 * the newsletter. Authors resolved to directory identities via the injected
 * identity resolver.
 */

import { withRetry, withTimeout } from '../utils/resilience.js';
import { sanitizeSourceItem } from '../filters/pii.js';
import { getLogger } from '../../common/logger.js';
import type { AggregationResult, SanitizedSourceItem } from '../types.js';
import type { Aggregator, AggregatorContext } from './types.js';

const TIMEOUT_MS = 8_000;
const MAX_ITEMS = 20;
const SKIP_LABELS = new Set(['chore', 'skip-digest-pipeline', 'internal', 'dependencies']);

export const aggregateGitHub: Aggregator = async (ctx: AggregatorContext): Promise<AggregationResult> => {
  const { runId, since, resolveIdentity, services } = ctx;
  const start = Date.now();
  try {
    const prs = await withRetry(() => withTimeout(services.github.listMergedPRsSince(since), TIMEOUT_MS), {
      attempts: 3,
      initialDelay: 200,
      jitter: true,
    });

    const items: SanitizedSourceItem[] = [];
    for (const pr of prs.slice(0, MAX_ITEMS)) {
      if (pr.labels.some((name) => SKIP_LABELS.has(name.toLowerCase()))) continue;
      const author = await resolveIdentity('github', pr.authorLogin).catch(() => null);
      items.push(
        sanitizeSourceItem({
          id: `github-pr-${pr.repo}-${pr.number}`,
          source: 'github',
          section: 'what_shipped',
          title: pr.title,
          description: pr.body?.slice(0, 500),
          url: pr.htmlUrl,
          author: author ?? undefined,
          publishedAt: new Date(pr.mergedAt),
          rawSignals: { prNumber: pr.number, repo: pr.repo, labels: pr.labels, hasDescription: Boolean(pr.body) },
        })
      );
    }
    return { source: 'github', items, durationMs: Date.now() - start };
  } catch (error) {
    getLogger().error({ runId, source: 'github', err: error }, 'aggregator.failure');
    return {
      source: 'github',
      items: [],
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - start,
    };
  }
};
