import type { AggregationResult, ResolvedIdentity } from '../types.js';
import type { GitHubService } from '../services/github.js';
import type { LinearService } from '../services/linear.js';
import type { SlackService } from '../services/slack.js';
import type { NotionService } from '../services/notion.js';

export type IdentitySource = 'github' | 'linear' | 'slack';

export interface AggregatorServices {
  github: GitHubService;
  linear: LinearService;
  slack: SlackService;
  notion: NotionService;
}

export interface SlackAggregatorConfig {
  announcementsChannelId: string;
  teamChannelId: string;
  hrBotUserIds: string[];
}

export interface AggregatorConfig {
  slack: SlackAggregatorConfig;
}

export interface AggregatorContext {
  runId: string;
  since: Date;
  services: AggregatorServices;
  config: AggregatorConfig;
  resolveIdentity: (source: IdentitySource, externalId: string) => Promise<ResolvedIdentity | null>;
}

export type Aggregator = (ctx: AggregatorContext) => Promise<AggregationResult>;
