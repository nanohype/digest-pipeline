/**
 * Integration test: each first-party aggregator, wired with a fake
 * service implementation, produces the expected SourceItem shapes.
 * No mocks of mocks — the real services interface is exercised end to
 * end, only the SDK call is stubbed.
 */

import { describe, it, expect, vi } from 'vitest';
import { aggregateGitHub } from './github.js';
import { aggregateLinear } from './linear.js';
import { aggregateSlack } from './slack.js';
import { aggregateNotion } from './notion.js';
import type {
  AggregatorConfig,
  AggregatorContext,
  AggregatorServices,
  IdentitySource,
} from './types.js';
import type { GitHubMergedPR, GitHubService } from '../services/github.js';
import type {
  LinearEpic,
  LinearIssue,
  LinearMilestone,
  LinearService,
} from '../services/linear.js';
import type { SlackMessage, SlackService } from '../services/slack.js';
import type { NotionPage, NotionService } from '../services/notion.js';
import type { ResolvedIdentity } from '../types.js';

function buildContext(overrides: {
  services?: Partial<AggregatorServices>;
  config?: Partial<AggregatorConfig>;
  identities?: Partial<Record<IdentitySource, ResolvedIdentity | null>>;
}): AggregatorContext {
  const services: AggregatorServices = {
    github: { listMergedPRsSince: vi.fn(async () => []) },
    linear: {
      listClosedEpicsSince: vi.fn(async () => []),
      listUpcomingMilestones: vi.fn(async () => []),
      listAskLabeledIssues: vi.fn(async () => []),
    },
    slack: { listChannelHistory: vi.fn(async () => []) },
    notion: { listRecentPagesSince: vi.fn(async () => []) },
    ...overrides.services,
  };
  const config: AggregatorConfig = {
    slack: {
      announcementsChannelId: 'C_ANN',
      teamChannelId: 'C_TEAM',
      hrBotUserIds: [],
    },
    ...overrides.config,
  };
  const resolveIdentity = async (source: IdentitySource): Promise<ResolvedIdentity | null> =>
    overrides.identities?.[source] ?? null;

  return {
    runId: 'test-run',
    since: new Date('2026-04-01T00:00:00Z'),
    resolveIdentity,
    services,
    config,
  };
}

describe('aggregateGitHub', () => {
  it('normalises Octokit PR shape into SourceItems with author resolved', async () => {
    const prs: GitHubMergedPR[] = [
      {
        number: 42,
        title: 'Ship billing migration',
        htmlUrl: 'https://github.com/acme/api/pull/42',
        mergedAt: '2026-04-10T00:00:00Z',
        authorLogin: 'ada',
        body: 'Migrates billing to Stripe invoices',
        labels: ['area:billing'],
        repo: 'acme/api',
      },
    ];
    const github: GitHubService = { listMergedPRsSince: vi.fn(async () => prs) };
    const identity: ResolvedIdentity = {
      userId: '00u1',
      displayName: 'Ada Lovelace',
      role: 'Engineer',
      team: 'Billing',
    };
    const result = await aggregateGitHub(
      buildContext({ services: { github }, identities: { github: identity } })
    );
    expect(result.source).toBe('github');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: 'github-pr-acme/api-42',
      title: 'Ship billing migration',
      author: identity,
      section: 'what_shipped',
      url: 'https://github.com/acme/api/pull/42',
    });
  });

  it('skips PRs carrying any of the skip labels', async () => {
    const prs: GitHubMergedPR[] = [
      {
        number: 1,
        title: 'Bump deps',
        htmlUrl: '',
        mergedAt: '2026-04-10T00:00:00Z',
        authorLogin: 'bot',
        labels: ['chore'],
        repo: 'acme/api',
      },
      {
        number: 2,
        title: 'Real feature',
        htmlUrl: '',
        mergedAt: '2026-04-10T00:00:00Z',
        authorLogin: 'ada',
        labels: ['feature'],
        repo: 'acme/api',
      },
    ];
    const github: GitHubService = { listMergedPRsSince: vi.fn(async () => prs) };
    const result = await aggregateGitHub(buildContext({ services: { github } }));
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe('Real feature');
  });
});

describe('aggregateLinear', () => {
  it('routes closed epics to what_shipped, milestones to whats_coming, asks to the_ask', async () => {
    const epics: LinearEpic[] = [
      {
        id: 'e1',
        identifier: 'PROJ-1',
        title: 'Data pipeline v2',
        description: 'Moved to new warehouse',
        url: 'https://linear.app/e1',
        completedAt: '2026-04-09T00:00:00Z',
      },
    ];
    const milestones: LinearMilestone[] = [
      {
        id: 'm1',
        name: 'Beta launch',
        description: 'External access',
        url: 'https://linear.app/m1',
        issueCount: 12,
      },
    ];
    const issues: LinearIssue[] = [
      {
        id: 'i1',
        title: 'Reviewers needed for design doc',
        url: 'https://linear.app/i1',
        createdAt: '2026-04-10T00:00:00Z',
      },
    ];
    const linear: LinearService = {
      listClosedEpicsSince: vi.fn(async () => epics),
      listUpcomingMilestones: vi.fn(async () => milestones),
      listAskLabeledIssues: vi.fn(async () => issues),
    };
    const result = await aggregateLinear(buildContext({ services: { linear } }));
    const sections = new Set(result.items.map((i) => i.section));
    expect(sections).toEqual(new Set(['what_shipped', 'whats_coming', 'the_ask']));
  });
});

describe('aggregateSlack', () => {
  it('pulls announcements into wins_recognition and new-hire intros into new_joiners; filters HR bot', async () => {
    const announcements: SlackMessage[] = [
      {
        ts: '1743465600.000100',
        channel: 'C_ANN',
        text: 'Huge shout-out to the platform team for shipping the invoice engine on time 🎉',
        userId: 'U_ANN',
        reactionCount: 14,
        replyCount: 3,
      },
    ];
    const teamMessages: SlackMessage[] = [
      {
        ts: '1743466600.000100',
        channel: 'C_TEAM',
        text: 'Please welcome Grace Hopper, joining the compilers team.',
        userId: 'U_HUMAN',
        reactionCount: 0,
        replyCount: 0,
      },
      {
        ts: '1743466700.000100',
        channel: 'C_TEAM',
        text: 'Please welcome Ada Lovelace, but this is a bot post.',
        userId: 'U_HR_BOT',
        reactionCount: 0,
        replyCount: 0,
      },
    ];
    const slack: SlackService = {
      listChannelHistory: vi.fn(async (channel) =>
        channel === 'C_ANN' ? announcements : teamMessages
      ),
    };
    const result = await aggregateSlack(
      buildContext({
        services: { slack },
        config: {
          slack: {
            announcementsChannelId: 'C_ANN',
            teamChannelId: 'C_TEAM',
            hrBotUserIds: ['U_HR_BOT'],
          },
        },
      })
    );
    const sections = result.items.map((i) => ({ section: i.section, text: i.title }));
    expect(sections).toHaveLength(2);
    expect(sections.some((s) => s.section === 'wins_recognition')).toBe(true);
    const joiner = sections.find((s) => s.section === 'new_joiners');
    expect(joiner?.text).toContain('Grace Hopper');
    expect(result.items.every((i) => !i.description?.includes('bot post'))).toBe(true);
  });
});

describe('aggregateNotion', () => {
  it('passes pages through piiFilter and drops PII', async () => {
    const pages: NotionPage[] = [
      {
        id: 'p1',
        title: 'Q2 planning',
        summary: 'Contact jane@example.com for details',
        url: 'https://notion.so/p1',
        createdTime: '2026-04-11T00:00:00Z',
      },
    ];
    const notion: NotionService = { listRecentPagesSince: vi.fn(async () => pages) };
    const result = await aggregateNotion(buildContext({ services: { notion } }));
    expect(result.items).toHaveLength(1);
    expect(result.items[0].description).toContain('[EMAIL]');
    expect(result.items[0].description).not.toContain('jane@example.com');
  });
});
