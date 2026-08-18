/**
 * Integration test: the weekly orchestrator, end to end.
 *
 * This drives the real `runPipeline` with fakes only at the process edges —
 * the four source SDKs, the WorkOS directory, the model gateway, Postgres and Slack.
 * Everything between them runs for real: the aggregator registry, all four
 * aggregators, the PII filter, the deduper, the ranker, and the audit ledger
 * (a real AuditWriter over a fake DatabaseClient), so an event the ledger
 * writes here is the event production would write.
 *
 * The two behaviors that only exist in the orchestrator are the reason this
 * file is worth its length. "One failed source does not fail the run" and
 * "the model failing degrades to a skeleton rather than losing the week" are
 * both claims the README makes and both are invisible to a unit test of any
 * single module — they are properties of how the modules are wired, which is
 * the definition of what an integration test is for.
 */

import { describe, expect, it, vi } from "vitest";
import type { AggregatorConfig, AggregatorServices } from "./aggregators/types.js";
import { AuditWriter, type DatabaseClient } from "./audit.js";
import {
  type PipelineDeps,
  type PipelineDraftStore,
  type PipelineGenerator,
  type PipelineIdentityResolver,
  type PipelineNotifier,
  runPipeline,
} from "./index.js";
import type { GitHubMergedPR } from "./services/github.js";
import type { LinearEpic } from "./services/linear.js";
import type { SlackMessage } from "./services/slack.js";
import type { AuditEvent, RankedSection } from "./types.js";

const ADA = {
  userId: "00u_ada",
  displayName: "Ada Lovelace",
  role: "Staff Engineer",
  team: "Billing",
};
const GRACE = {
  userId: "00u_grace",
  displayName: "Grace Hopper",
  role: "Principal Engineer",
  team: "Platform",
};
const KATH = {
  userId: "00u_kath",
  displayName: "Katherine Johnson",
  role: "Director",
  team: "Ops",
};

function mergedPR(overrides: Partial<GitHubMergedPR> = {}): GitHubMergedPR {
  return {
    number: 42,
    title: "Ship billing migration",
    htmlUrl: "https://github.com/acme/api/pull/42",
    mergedAt: "2026-04-08T00:00:00Z",
    authorLogin: "ada",
    body: "Moves billing onto Stripe invoices",
    labels: ["area:billing"],
    repo: "acme/api",
    ...overrides,
  };
}

function closedEpic(): LinearEpic {
  return {
    id: "epic_1",
    identifier: "PLAT-7",
    title: "Retire the legacy invoicing path",
    url: "https://linear.app/acme/project/plat-7",
    completedAt: "2026-04-08T00:00:00Z",
    assigneeExternalId: "grace",
    teamName: "Platform",
  };
}

function announcement(): SlackMessage {
  return {
    ts: "1775692800.000100",
    channel: "C_ANN",
    text: "Huge week for the ops crew — the on-call rotation is fully automated now.",
    userId: "U_KATH",
    reactionCount: 12,
    replyCount: 3,
  };
}

interface Harness {
  deps: PipelineDeps;
  events: Array<Omit<AuditEvent, "id">>;
  generated: Array<{ runId: string; sections: RankedSection[] }>;
  created: Array<Parameters<PipelineDraftStore["create"]>[0]>;
  notified: Array<{ runId: string; draftId: string; fullText: string }>;
  alerts: Array<{ runId: string; message: string }>;
  github: { listMergedPRsSince: ReturnType<typeof vi.fn> };
  resolver: PipelineIdentityResolver;
}

function harness(
  opts: {
    prs?: GitHubMergedPR[];
    epics?: LinearEpic[];
    announcements?: SlackMessage[];
    /** Make one source reject, to exercise the partial-failure path. */
    linearFails?: string;
    /** Make the model call reject, to exercise the skeleton fallback. */
    generatorFails?: string;
    /** Drafts left PENDING by an earlier week, which the run should expire. */
    stalePending?: Array<{ id: string; runId: string }>;
    now?: Date;
    lookbackDays?: number;
  } = {},
): Harness {
  const events: Array<Omit<AuditEvent, "id">> = [];
  const generated: Harness["generated"] = [];
  const created: Harness["created"] = [];
  const notified: Harness["notified"] = [];
  const alerts: Harness["alerts"] = [];
  const expiring = opts.stalePending ?? [];

  const db: DatabaseClient = {
    insertAuditEvent: async (event) => {
      events.push(event);
    },
  };

  const github = { listMergedPRsSince: vi.fn(async () => opts.prs ?? []) };
  const services: AggregatorServices = {
    github,
    linear: {
      listClosedEpicsSince: vi.fn(async () => {
        if (opts.linearFails) throw new Error(opts.linearFails);
        return opts.epics ?? [];
      }),
      listUpcomingMilestones: vi.fn(async () => []),
      listAskLabeledIssues: vi.fn(async () => []),
    },
    slack: {
      listChannelHistory: vi.fn(async (channelId: string) =>
        channelId === "C_ANN" ? (opts.announcements ?? []) : [],
      ),
    },
    notion: { listRecentPagesSince: vi.fn(async () => []) },
  };

  const aggregatorConfig: AggregatorConfig = {
    slack: { announcementsChannelId: "C_ANN", teamChannelId: "C_TEAM", hrBotUserIds: [] },
  };

  // Each resolver answers for its own namespace only, so a test can tell
  // "resolved through the right arm" from "resolved at all".
  const resolver: PipelineIdentityResolver = {
    resolveGitHubUser: vi.fn(async (login: string) => (login === "ada" ? ADA : null)),
    resolveLinearUser: vi.fn(async (id: string) => (id === "grace" ? GRACE : null)),
    resolveSlackUser: vi.fn(async (id: string) => (id === "U_KATH" ? KATH : null)),
  };

  const generator: PipelineGenerator = {
    generate: vi.fn(async (runId: string, sections: RankedSection[]) => {
      generated.push({ runId, sections });
      if (opts.generatorFails) throw new Error(opts.generatorFails);
      return {
        fullText: "## What Shipped\n\nBilling shipped this week.\n",
        sections,
        tokensUsed: 8_421,
      };
    }),
  };

  const draftStore: PipelineDraftStore = {
    create: vi.fn(async (input) => {
      created.push(input);
      return "draft_1";
    }),
    expirePending: vi.fn(async () => expiring),
  };

  const notifier: PipelineNotifier = {
    notifyDraftReady: vi.fn(async (runId, draftId, fullText) => {
      notified.push({ runId, draftId, fullText });
    }),
    alert: vi.fn(async (runId, message) => {
      alerts.push({ runId, message });
    }),
  };

  const deps: PipelineDeps = {
    resolver,
    generator,
    auditWriter: new AuditWriter(db),
    draftStore,
    notifier,
    services,
    aggregatorConfig,
    ...(opts.now ? { now: () => opts.now as Date } : {}),
    ...(opts.lookbackDays !== undefined ? { lookbackDays: opts.lookbackDays } : {}),
  };

  return { deps, events, generated, created, notified, alerts, github, resolver };
}

interface LedgerSourceResult {
  source: string;
  itemCount: number;
  error?: string;
}

/** The per-source block the DRAFT_GENERATED event carries, or a clear failure. */
function sourceResultsOf(events: Array<Omit<AuditEvent, "id">>): LedgerSourceResult[] {
  const drafted = events.find((e) => e.eventType === "DRAFT_GENERATED");
  if (!drafted) throw new Error("the run wrote no DRAFT_GENERATED event");
  return (drafted.payload as { sourceResults: LedgerSourceResult[] }).sourceResults;
}

/** Local-time constructors so the day-of-week assertions hold in any TZ. */
const WEDNESDAY = new Date(2026, 3, 8, 10, 0, 0); // Wed 8 April 2026
const FRIDAY = new Date(2026, 3, 10, 9, 0, 0); // Fri 10 April 2026, the cron's own day

describe("runPipeline — the whole week, wired", () => {
  it("aggregates, ranks, generates, stores, audits and notifies under one run id", async () => {
    const h = harness({ prs: [mergedPR()], now: WEDNESDAY });
    const result = await runPipeline(h.deps);

    expect(result.status).toBe("SUCCESS");
    expect(result.draftId).toBe("draft_1");
    expect(result.sourceResults.map((r) => r.source).sort()).toEqual([
      "github",
      "linear",
      "notion",
      "slack",
    ]);

    // The correlation id is the whole point of the ledger: one run id has to
    // be the same string on the draft, on every audit event, and on the Slack
    // notification, or none of them can be joined after the fact.
    expect(result.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.created[0].runId).toBe(result.runId);
    expect(h.notified[0]).toMatchObject({ runId: result.runId, draftId: "draft_1" });
    for (const event of h.events) expect(event.runId).toBe(result.runId);
  });

  it("carries the model's real token spend into the ledger", async () => {
    const h = harness({ prs: [mergedPR()], now: WEDNESDAY });
    await runPipeline(h.deps);

    const drafted = h.events.find((e) => e.eventType === "DRAFT_GENERATED");
    expect(drafted?.payload).toMatchObject({ draftId: "draft_1", llmTokensUsed: 8_421 });
  });

  it("records per-source item counts on the DRAFT_GENERATED event", async () => {
    const h = harness({ prs: [mergedPR(), mergedPR({ number: 43, title: "Add invoice export" })] });
    await runPipeline(h.deps);

    const sourceResults = sourceResultsOf(h.events);
    expect(sourceResults.find((r) => r.source === "github")).toMatchObject({ itemCount: 2 });
    expect(sourceResults.find((r) => r.source === "slack")).toMatchObject({ itemCount: 0 });
  });

  it("sends each source's handles to that source's resolver, not another's", async () => {
    // The orchestrator dispatches on the source name across three resolvers.
    // Swapping two arms still resolves every author to *somebody*, so the
    // failure is not an error — it is Grace Hopper's name under Katherine
    // Johnson's announcement, in an email to the whole company. Only asserting
    // the arms independently catches that.
    const h = harness({
      prs: [mergedPR()],
      epics: [closedEpic()],
      announcements: [announcement()],
    });
    await runPipeline(h.deps);

    expect(h.resolver.resolveGitHubUser).toHaveBeenCalledWith("ada");
    expect(h.resolver.resolveLinearUser).toHaveBeenCalledWith("grace");
    expect(h.resolver.resolveSlackUser).toHaveBeenCalledWith("U_KATH");

    expect(h.resolver.resolveGitHubUser).not.toHaveBeenCalledWith("grace");
    expect(h.resolver.resolveLinearUser).not.toHaveBeenCalledWith("U_KATH");

    const byTitle = new Map(
      h.generated[0].sections
        .flatMap((s) => s.items)
        .map((i) => [i.title, i.author?.displayName] as const),
    );
    expect(byTitle.get("Ship billing migration")).toBe("Ada Lovelace");
    expect(byTitle.get("Retire the legacy invoicing path")).toBe("Grace Hopper");
  });
});

describe("runPipeline — the run window", () => {
  it("targets the coming Friday when it runs mid-week", async () => {
    const h = harness({ now: WEDNESDAY });
    const { weekOf } = await runPipeline(h.deps);

    expect(weekOf.getDay()).toBe(5);
    expect([weekOf.getFullYear(), weekOf.getMonth(), weekOf.getDate()]).toEqual([2026, 3, 10]);
    expect(weekOf.getHours()).toBe(0);
  });

  it("targets today when it runs on Friday, which is when the CronJob fires", async () => {
    // The chart schedules this for Friday 09:00. If `getThisFriday` rounded up
    // to the *next* Friday the newsletter would be stamped a week ahead on
    // every single real run — the one input this function actually receives.
    const h = harness({ now: FRIDAY });
    const { weekOf } = await runPipeline(h.deps);

    expect([weekOf.getFullYear(), weekOf.getMonth(), weekOf.getDate()]).toEqual([2026, 3, 10]);
  });

  it("looks back one week from the target Friday by default", async () => {
    const h = harness({ now: WEDNESDAY });
    const { weekOf } = await runPipeline(h.deps);

    const since = h.github.listMergedPRsSince.mock.calls[0][0] as Date;
    expect(weekOf.getTime() - since.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("widens the window for a catch-up run", async () => {
    const h = harness({ now: WEDNESDAY, lookbackDays: 21 });
    const { weekOf } = await runPipeline(h.deps);

    const since = h.github.listMergedPRsSince.mock.calls[0][0] as Date;
    expect(weekOf.getTime() - since.getTime()).toBe(21 * 24 * 60 * 60 * 1000);
  });
});

describe("runPipeline — one source down", () => {
  it("finishes the run as PARTIAL and keeps the healthy sources' items", async () => {
    const h = harness({ prs: [mergedPR()], linearFails: "Linear API 503" });
    const result = await runPipeline(h.deps);

    expect(result.status).toBe("PARTIAL");
    expect(result.draftId).toBe("draft_1");

    const linear = result.sourceResults.find((r) => r.source === "linear");
    expect(linear).toMatchObject({ error: "Linear API 503", items: [] });

    // The surviving source still reached the model — a degraded week is still
    // a newsletter, which is the entire reason for allSettled here.
    const titles = h.generated[0].sections.flatMap((s) => s.items).map((i) => i.title);
    expect(titles).toContain("Ship billing migration");
  });

  it("puts the source's error in the ledger, not only in the logs", async () => {
    const h = harness({ linearFails: "Linear API 503" });
    await runPipeline(h.deps);

    const sourceResults = sourceResultsOf(h.events);
    expect(sourceResults.find((r) => r.source === "linear")?.error).toBe("Linear API 503");
  });
});

describe("runPipeline — model gateway down", () => {
  it("posts a skeleton draft rather than losing the week", async () => {
    const h = harness({ prs: [mergedPR()], generatorFails: "model gateway throttled" });
    const result = await runPipeline(h.deps);

    expect(result.status).toBe("PARTIAL");
    expect(result.draftId).toBe("draft_1");

    const { fullText } = h.created[0];
    expect(fullText).toContain("Auto-generated skeleton");
    expect(fullText).toContain("Ship billing migration");
    // A section with nothing in it still gets rendered, so the reviewer sees
    // the shape of the newsletter they are editing rather than a truncated one.
    expect(fullText).toContain("_Nothing to report this week._");
  });

  it("writes PIPELINE_FAILURE and alerts a human with the reason", async () => {
    const h = harness({ generatorFails: "model gateway throttled" });
    await runPipeline(h.deps);

    const failure = h.events.find((e) => e.eventType === "PIPELINE_FAILURE");
    expect(failure).toMatchObject({
      actor: "system",
      payload: { phase: "generation", error: "model gateway throttled", fallback: "skeleton" },
    });
    expect(h.alerts[0].message).toContain("model gateway throttled");
  });

  it("records zero tokens rather than a stale count when no model call landed", async () => {
    const h = harness({ generatorFails: "model gateway throttled" });
    await runPipeline(h.deps);

    const drafted = h.events.find((e) => e.eventType === "DRAFT_GENERATED");
    expect(drafted?.payload).toMatchObject({ llmTokensUsed: 0 });
  });

  it("still notifies the reviewer, because a skeleton nobody is told about is a lost week", async () => {
    const h = harness({ generatorFails: "model gateway throttled" });
    const result = await runPipeline(h.deps);

    expect(h.notified).toHaveLength(1);
    expect(h.notified[0].draftId).toBe(result.draftId);
  });
});

describe("runPipeline — closing out last week", () => {
  const STALE = [
    { id: "draft_prev", runId: "run_prev" },
    { id: "draft_older", runId: "run_older" },
  ];

  it("expires drafts nobody approved, before this week's draft exists", async () => {
    const h = harness({ prs: [mergedPR()], stalePending: STALE, now: FRIDAY });
    await runPipeline(h.deps);

    const expirePending = h.deps.draftStore.expirePending as ReturnType<typeof vi.fn>;
    const create = h.deps.draftStore.create as ReturnType<typeof vi.fn>;

    expect(expirePending).toHaveBeenCalledTimes(1);
    // Cut off at this run's target week, so only earlier weeks are swept.
    expect(expirePending.mock.calls[0][0]).toEqual(h.created[0].weekOf);
    // Ordering is the claim in the name, so it is asserted rather than implied:
    // sweeping after the insert would expire nothing and leave two PENDING
    // drafts for one week, which is the state the sweep exists to prevent.
    expect(expirePending.mock.invocationCallOrder[0]).toBeLessThan(
      create.mock.invocationCallOrder[0],
    );
  });

  /**
   * Audited against the run that produced each draft rather than this one:
   * audit_events is keyed on run_id, and the expiry of last week's draft is an
   * event in last week's story. Writing them all under the current run would
   * make the ledger unable to answer "what happened to run_prev's draft".
   */
  it("writes an EXPIRED event per draft, keyed to the run that produced it", async () => {
    const h = harness({ prs: [mergedPR()], stalePending: STALE, now: FRIDAY });
    await runPipeline(h.deps);

    const expired = h.events.filter((e) => e.eventType === "EXPIRED");
    expect(expired).toHaveLength(2);
    expect(
      expired.map((e) => ({ runId: e.runId, draftId: (e.payload as { draftId: string }).draftId })),
    ).toEqual([
      { runId: "run_prev", draftId: "draft_prev" },
      { runId: "run_older", draftId: "draft_older" },
    ]);
    expect(expired.every((e) => e.actor === "system")).toBe(true);
  });

  it("writes no EXPIRED events on a week that left nothing open", async () => {
    const h = harness({ prs: [mergedPR()], now: FRIDAY });
    await runPipeline(h.deps);

    expect(h.events.filter((e) => e.eventType === "EXPIRED")).toHaveLength(0);
  });

  it("still produces the week's draft after expiring the old ones", async () => {
    const h = harness({ prs: [mergedPR()], stalePending: STALE, now: FRIDAY });
    const result = await runPipeline(h.deps);

    expect(result.status).toBe("SUCCESS");
    expect(h.created).toHaveLength(1);
    expect(h.notified).toHaveLength(1);
  });
});
