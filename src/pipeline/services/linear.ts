/**
 * Linear service — closed epics, upcoming milestones, and ask-labeled
 * issues. GraphQL under the hood via @linear/sdk. Each method returns a
 * plain DTO the aggregator can map without Linear types leaking through.
 */

import { LinearClient } from '@linear/sdk';

export interface LinearEpic {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  url: string;
  completedAt: string;
  assigneeExternalId?: string;
  teamName?: string;
  priority?: number;
}

export interface LinearMilestone {
  id: string;
  name: string;
  description?: string;
  url: string;
  targetDate?: string;
  issueCount: number;
}

export interface LinearIssue {
  id: string;
  title: string;
  description?: string;
  url: string;
  createdAt: string;
  priority?: number;
}

export interface LinearService {
  listClosedEpicsSince(since: Date): Promise<LinearEpic[]>;
  listUpcomingMilestones(): Promise<LinearMilestone[]>;
  listAskLabeledIssues(): Promise<LinearIssue[]>;
}

export interface LinearServiceConfig {
  apiKey: string;
  askLabelName?: string;
}

export function createLinearService(config: LinearServiceConfig): LinearService {
  const client = new LinearClient({ apiKey: config.apiKey });
  const askLabel = config.askLabelName ?? 'the-ask';

  return {
    async listClosedEpicsSince(since) {
      const projects = await client.projects({
        filter: {
          completedAt: { gte: since.toISOString() },
        },
        first: 50,
      });

      const epics: LinearEpic[] = [];
      for (const project of projects.nodes) {
        const lead = project.lead ? await project.lead : undefined;
        epics.push({
          id: project.id,
          identifier: project.slugId,
          title: project.name,
          description: project.description ?? undefined,
          url: project.url,
          completedAt: project.completedAt?.toISOString() ?? since.toISOString(),
          assigneeExternalId: lead?.id,
          priority: project.priority,
        });
      }
      return epics;
    },

    async listUpcomingMilestones() {
      const projects = await client.projects({
        filter: { state: { eq: 'started' } },
        first: 50,
      });

      return projects.nodes.map<LinearMilestone>((project) => ({
        id: project.id,
        name: project.name,
        description: project.description ?? undefined,
        url: project.url,
        targetDate: project.targetDate ?? undefined,
        issueCount: project.issueCountHistory?.length ?? 0,
      }));
    },

    async listAskLabeledIssues() {
      const issues = await client.issues({
        filter: {
          labels: { name: { eq: askLabel } },
          state: { type: { neq: 'completed' } },
        },
        first: 20,
        orderBy: 'createdAt' as never,
      });

      return issues.nodes.map<LinearIssue>((issue) => ({
        id: issue.id,
        title: issue.title,
        description: issue.description ?? undefined,
        url: issue.url,
        createdAt: issue.createdAt.toISOString(),
        priority: issue.priority,
      }));
    },
  };
}
