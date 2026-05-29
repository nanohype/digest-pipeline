/**
 * Notion aggregator — fetches recent pages from the all-hands database.
 * The scope guard lives in the Notion service (parent.database_id is
 * verified against the configured database ID for every returned page).
 */

import { withRetry, withTimeout } from '../utils/resilience.js';
import { sanitizeSourceItem } from '../filters/pii.js';
import { getLogger } from '../../common/logger.js';
import type { AggregationResult, SanitizedSourceItem } from '../types.js';
import type { Aggregator, AggregatorContext } from './types.js';

const TIMEOUT_MS = 8_000;

export const aggregateNotion: Aggregator = async (ctx: AggregatorContext): Promise<AggregationResult> => {
  const { runId, since, services } = ctx;
  const start = Date.now();
  try {
    const pages = await withRetry(() => withTimeout(services.notion.listRecentPagesSince(since), TIMEOUT_MS), {
      attempts: 3,
      initialDelay: 200,
      jitter: true,
    });

    const items: SanitizedSourceItem[] = pages.map((page) =>
      sanitizeSourceItem({
        id: `notion-${page.id}`,
        source: 'notion' as const,
        section: 'whats_coming' as const,
        title: page.title,
        description: page.summary?.slice(0, 300),
        url: page.url,
        publishedAt: new Date(page.createdTime),
        rawSignals: { authorName: page.authorName, hasContent: Boolean(page.summary) },
      })
    );

    return { source: 'notion', items, durationMs: Date.now() - start };
  } catch (error) {
    getLogger().error({ runId, source: 'notion', err: error }, 'aggregator.failure');
    return {
      source: 'notion',
      items: [],
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - start,
    };
  }
};
