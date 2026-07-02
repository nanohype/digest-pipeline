/**
 * Linear aggregator — closed epics become "What Shipped", upcoming
 * milestones become "What's Coming", and ask-labelled issues become
 * "The Ask". Assignees resolved to directory identities.
 */

import { withRetry, withTimeout } from '../../runtime/resilience.js';
import { sanitizeSourceItem } from '../filters/pii.js';
import { getLogger } from '../../common/logger.js';
import type { AggregationResult, SanitizedSourceItem } from '../types.js';
import type { Aggregator, AggregatorContext } from './types.js';

const TIMEOUT_MS = 8_000;
const MAX_ASKS = 5;

export const aggregateLinear: Aggregator = async (ctx: AggregatorContext): Promise<AggregationResult> => {
  const { runId, since, resolveIdentity, services } = ctx;
  const start = Date.now();
  try {
    const [closedEpics, upcomingMilestones, askItems] = await Promise.all([
      withRetry(
        () => withTimeout(services.linear.listClosedEpicsSince(since), TIMEOUT_MS, 'linear.listClosedEpicsSince'),
        {
          attempts: 3,
          initialDelayMs: 200,
          jitter: true,
        }
      ),
      withRetry(
        () => withTimeout(services.linear.listUpcomingMilestones(), TIMEOUT_MS, 'linear.listUpcomingMilestones'),
        {
          attempts: 3,
          initialDelayMs: 200,
          jitter: true,
        }
      ),
      withRetry(() => withTimeout(services.linear.listAskLabeledIssues(), TIMEOUT_MS, 'linear.listAskLabeledIssues'), {
        attempts: 3,
        initialDelayMs: 200,
        jitter: true,
      }),
    ]);

    const items: SanitizedSourceItem[] = [];
    for (const epic of closedEpics) {
      const author = epic.assigneeExternalId
        ? await resolveIdentity('linear', epic.assigneeExternalId).catch(() => null)
        : null;
      items.push(
        sanitizeSourceItem({
          id: `linear-epic-${epic.id}`,
          source: 'linear',
          section: 'what_shipped',
          title: epic.title,
          description: epic.description?.slice(0, 500),
          url: epic.url,
          author: author ?? undefined,
          publishedAt: new Date(epic.completedAt),
          rawSignals: { identifier: epic.identifier, teamName: epic.teamName, priority: epic.priority },
        })
      );
    }
    for (const milestone of upcomingMilestones) {
      items.push(
        sanitizeSourceItem({
          id: `linear-milestone-${milestone.id}`,
          source: 'linear',
          section: 'whats_coming',
          title: milestone.name,
          description: milestone.description?.slice(0, 300),
          url: milestone.url,
          publishedAt: new Date(),
          rawSignals: { targetDate: milestone.targetDate, issueCount: milestone.issueCount },
        })
      );
    }
    for (const issue of askItems.slice(0, MAX_ASKS)) {
      items.push(
        sanitizeSourceItem({
          id: `linear-ask-${issue.id}`,
          source: 'linear',
          section: 'the_ask',
          title: issue.title,
          description: issue.description?.slice(0, 300),
          url: issue.url,
          publishedAt: new Date(issue.createdAt),
          rawSignals: { priority: issue.priority },
        })
      );
    }
    return { source: 'linear', items, durationMs: Date.now() - start };
  } catch (error) {
    getLogger().error({ runId, source: 'linear', err: error }, 'aggregator.failure');
    return {
      source: 'linear',
      items: [],
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - start,
    };
  }
};
