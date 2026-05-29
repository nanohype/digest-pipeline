# Contributing

## Workflow

1. Branch from `main` with a conventional prefix: `feat/`, `fix/`, `chore/`, `docs/`, `refactor/`, `test/`.
2. Run `task ci` locally before pushing. CI must pass.
3. Use the structured commit-message format from `~/.claude/CLAUDE.md` (section headers, file-level detail, scaled verbosity).
4. Open a PR. Reviews are required for changes under `src/pipeline/filters/`, `src/api/`, and `chart/`.

## Local prereqs

| Tool     | Version                           |
| -------- | --------------------------------- |
| `node`   | see `package.json` engines (≥ 24) |
| `npm`    | bundled with Node 24              |
| `helm`   | matches the target cluster minor  |
| `task`   | latest                            |
| `docker` | for the container build job       |

The `web/` Next.js app has its **own** `package.json` and build (`next build`); `task ci`
installs and builds it as a separate step. Run `task --list` to see every task.

## Layout

See [README.md](./README.md), [AGENTS.md](./AGENTS.md), and [ARCHITECTURE.md](./ARCHITECTURE.md).

## The test contract

Tests are Vitest, colocated as `src/**/*.test.ts`. The load-bearing integration test
(`src/pipeline/pipeline.integration.test.ts`) runs against a **real Postgres container** and
mocks **only Bedrock and the external source SDKs** — the aggregator → identity resolve → PII
filter → rank/dedupe → generate → audit path runs end to end against real schema and real
migrations. Mock at the source boundary, not the module under test: aggregators take a typed
service port, so inject a fake; AWS SDK clients use `aws-sdk-client-mock` (client-level), never
module-level mocking.

New boundary code needs a port-injected test; new pure logic (PII regex class, ranker scoring,
resilience, diff) needs a direct test.

## Adding an aggregator

1. Add a module in `src/pipeline/aggregators/<source>.ts` exporting an `Aggregator` factory
   (match the shape of `github.ts` / `linear.ts` / `notion.ts` / `slack.ts`).
2. Register it in `buildAggregatorRegistry` (`src/pipeline/aggregators/registry.ts`) with
   `registry.register('<source>', () => aggregate<Source>)` — the orchestrator iterates the
   registry, so adding a source never edits `entrypoint.ts`.
3. Wrap every external call in `withRetry(() => withTimeout(call, TIMEOUT_MS), …)`
   (`src/pipeline/utils/resilience.ts`) — 8s default timeout, 15s for chat history.
4. Pass every emitted item through `sanitizeSourceItem` (`src/pipeline/filters/pii.ts`) before
   returning it, so only `SanitizedSourceItem`s leave the aggregator (the brand is what lets the
   item reach the prompt builder — see [SECURITY.md](./SECURITY.md)).
5. Add a test: inject a fake source service, assert items are sanitized and that one failed
   source yields a partial result rather than failing the run.

## Adding a Bedrock cachePoint

The generator (`src/pipeline/ai/generator.ts`) builds the Anthropic-on-Bedrock request body.
Prompt caching is mandatory — the **system prompt is the cache target** because it carries the
voice-baseline few-shot corpus, which is large and stable across the weekly run and across
retries within a run.

1. Build `system` as an array of content blocks with a trailing
   `{ cachePoint: { type: 'default' } }` marker so the few-shot corpus is cached and only the
   small per-run user prompt varies. (Confirm the exact marker shape against current Bedrock
   docs before changing it — do not guess.)
2. Read `cache_read_input_tokens` / `cache_creation_input_tokens` from the response `usage`
   and record them via the existing `dispatch.bedrock.tokens` metric with `kind` label values
   `cache_read` / `cache_write`, so savings show up on the Grafana dashboard.
3. Add a generator test asserting the request body carries the `cachePoint` marker on the
   system block.

## Adding a chart template

1. Add the template under `chart/templates/<name>.yaml`. Use the `dispatch.*` helpers
   (`dispatch.fullname`, `dispatch.labels`, the shared `serviceaccount`) from `_helpers.tpl` —
   internal naming stays `dispatch`.
2. Thread any new toggles/values through `values.yaml` and both per-env deltas
   (`values-staging.yaml`, `values-production.yaml`).
3. Keep it in-chart only: **no inline IAM, no cloud resources, no cluster addons.** Namespaced
   RBAC (`Role`/`RoleBinding`) is fine; IAM lives in `landing-zone`, cluster addons in
   `eks-gitops` (see [ARCHITECTURE.md](./ARCHITECTURE.md#boundaries)).
4. Render it: `task helm:template` lints and templates against staging + production.

## Deploy contract

This app ships as a Platform tenant: a Helm `chart/`, a `platform.yaml` (Platform +
BudgetPolicy CRs), and a `gitops/applicationset-entry.yaml`. Per-tenant AWS substrate lives in
`landing-zone` (the `dispatch-platform` component); cluster addons live in `eks-gitops`. Do not
add IAM, cloud resources, or cluster addons to the chart — see
[ARCHITECTURE.md](./ARCHITECTURE.md#boundaries).

## Code of Conduct

See [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
