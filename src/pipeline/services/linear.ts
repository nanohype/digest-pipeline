/**
 * Linear service — closed epics, upcoming milestones, and ask-labeled
 * issues. GraphQL under the hood via @linear/sdk. Each method returns a
 * plain DTO the aggregator can map without Linear types leaking through.
 */

import { LinearClient, PaginationOrderBy } from "@linear/sdk";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "../../common/http.js";

/** Socket-level floor under the aggregator's `withTimeout` wrap. */
const REQUEST_TIMEOUT_MS = DEFAULT_REQUEST_TIMEOUT_MS;

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
  const askLabel = config.askLabelName ?? "the-ask";

  /**
   * A client per call, because Linear gives no other way to bound one.
   *
   * `LinearClientOptions extends RequestInit`, and the SDK spreads those options
   * into every `fetch` it issues — so `signal` is the only deadline it accepts.
   * It exposes no `timeout` and no injectable fetch (`globalThis.fetch` is read
   * directly), which rules out the wrapper used for Octokit.
   *
   * A single client would therefore have to share one `AbortSignal` across its
   * whole lifetime. That is not a per-request deadline: the signal fires once
   * and stays aborted, so every call after the first deadline fails before it is
   * sent. Building the client per call gives each one a fresh signal. It is a
   * thin wrapper over `globalThis.fetch` with no connection pool or handshake to
   * amortise, so the cost is three object allocations on a job that runs once a
   * week.
   *
   * The deadline covers the method rather than each HTTP round trip, which is
   * the useful scope — `listClosedEpicsSince` follows each project with a
   * `lead` fetch, and bounding those individually would leave the method
   * unbounded in aggregate. It matches the scope of the aggregator's
   * `withTimeout` wrap, so the floor and the wrap describe the same thing.
   */
  const boundedClient = () =>
    new LinearClient({
      apiKey: config.apiKey,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

  return {
    async listClosedEpicsSince(since) {
      const client = boundedClient();
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
      const client = boundedClient();
      const projects = await client.projects({
        filter: { state: { eq: "started" } },
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
      const client = boundedClient();
      const issues = await client.issues({
        filter: {
          labels: { name: { eq: askLabel } },
          state: { type: { neq: "completed" } },
        },
        first: 20,
        orderBy: PaginationOrderBy.CreatedAt,
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
