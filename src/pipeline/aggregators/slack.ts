/**
 * Slack aggregator — pulls #announcements for wins/recognition and
 * #team for new-hire intros. HR-bot user IDs are filtered out of the
 * #team ingestion to keep onboarding automation traffic out of the
 * newsletter corpus.
 */

import { withRetry, withTimeout } from '../../runtime/resilience.js';
import { piiFilter, sanitizeSourceItem } from '../filters/pii.js';
import { getLogger } from '../../common/logger.js';
import type { AggregationResult, SanitizedSourceItem } from '../types.js';
import type { Aggregator, AggregatorContext } from './types.js';

const TIMEOUT_MS = 15_000;
const MAX_TOKEN_LENGTH = 2_000;
const MIN_ANNOUNCEMENT_LENGTH = 20;
const NEW_HIRE_PATTERNS = [
  /please welcome/i,
  /joined us/i,
  /joining the team/i,
  /excited to welcome/i,
  /our newest/i,
];

export const aggregateSlack: Aggregator = async (
  ctx: AggregatorContext
): Promise<AggregationResult> => {
  const { runId, since, resolveIdentity, services, config } = ctx;
  const { announcementsChannelId, teamChannelId, hrBotUserIds } = config.slack;
  const hrBotSet = new Set(hrBotUserIds);
  const start = Date.now();
  try {
    const [announcements, teamMessages] = await Promise.all([
      withRetry(
        () =>
          withTimeout(
            services.slack.listChannelHistory(announcementsChannelId, since),
            TIMEOUT_MS,
            'slack.history.announcements'
          ),
        {
          attempts: 3,
          initialDelayMs: 200,
          jitter: true,
        }
      ),
      withRetry(
        () =>
          withTimeout(
            services.slack.listChannelHistory(teamChannelId, since),
            TIMEOUT_MS,
            'slack.history.team'
          ),
        {
          attempts: 3,
          initialDelayMs: 200,
          jitter: true,
        }
      ),
    ]);

    const items: SanitizedSourceItem[] = [];
    for (const msg of announcements) {
      // Length threshold compares post-filter text so redaction tokens
      // ([EMAIL], [COMPENSATION], …) don't count as content.
      const filtered = piiFilter(msg.text);
      if (filtered.trim().length < MIN_ANNOUNCEMENT_LENGTH) continue;
      const truncated = filtered.slice(0, MAX_TOKEN_LENGTH);
      const author = msg.userId
        ? await resolveIdentity('slack', msg.userId).catch(() => null)
        : null;
      items.push(
        sanitizeSourceItem({
          id: `slack-ann-${msg.ts}`,
          source: 'slack',
          section: 'wins_recognition',
          title: truncated.split('\n')[0].slice(0, 120),
          description: truncated,
          url: `https://slack.com/archives/${msg.channel}/p${msg.ts.replace('.', '')}`,
          author: author ?? undefined,
          publishedAt: new Date(Number(msg.ts) * 1000),
          rawSignals: { reactionCount: msg.reactionCount, threadReplies: msg.replyCount },
        })
      );
    }
    for (const msg of teamMessages) {
      if (msg.userId && hrBotSet.has(msg.userId)) continue;
      if (!NEW_HIRE_PATTERNS.some((p) => p.test(msg.text))) continue;
      items.push(
        sanitizeSourceItem({
          id: `slack-team-${msg.ts}`,
          source: 'slack',
          section: 'new_joiners',
          title: msg.text.split('\n')[0].slice(0, 120),
          description: msg.text.slice(0, 500),
          publishedAt: new Date(Number(msg.ts) * 1000),
          rawSignals: { isNewHireIntro: true },
        })
      );
    }
    return { source: 'slack', items, durationMs: Date.now() - start };
  } catch (error) {
    getLogger().error({ runId, source: 'slack', err: error }, 'aggregator.failure');
    return {
      source: 'slack',
      items: [],
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - start,
    };
  }
};
