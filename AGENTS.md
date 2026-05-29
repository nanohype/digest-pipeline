# digest-pipeline — agent entry point

You're an AI client (or the author of one) about to run this service locally, add an aggregator source, wire a Bedrock cachePoint, or ship it as a Platform tenant. This file gets you running in five minutes. For the wider picture — how this repo fits into the nanohype stack — read the [Platform Reference](../nanohype/docs/platform-reference.md).

> Internal service handle: **dispatch**. The GitHub repo and product name are `digest-pipeline`, but the npm package, the OTel `service.name` / `agents.platform`, the `dispatch.*` metric names + template helpers + labels, and the `dispatch/<env>/*` secret prefixes all stay `dispatch` — they're coupled to the landing-zone `dispatch-platform` substrate component.

## What this repo gives you

An automated weekly newsletter pipeline for a Chief of Staff. Every Friday morning it aggregates cross-team activity (GitHub, Linear, Notion, Slack), resolves contributors to canonical identities through WorkOS Directory Sync, redacts PII, ranks and dedupes the items, drafts a voice-matched newsletter with Claude via Bedrock, and posts it to Slack for review. The draft only goes out over SES after a named approver clicks approve in the review UI.

The load-bearing property is the **immutable audit-event ledger**: every mutation to a draft — generation, human edit, approval, send receipt, expiry — is an append-only `audit_events` row keyed on `run_id`. Nothing about a draft's history is recomputed from the current draft text; it's all read back from the ledger. The edit-rate metric (character-level Levenshtein of the human-edited text vs. the auto-generated baseline) is derived from those events, not from diffing the live draft.

It's built from nanohype template patterns (data-pipeline, worker-service, rag-pipeline, module-auth, slack-bot) composed into one app. External-IO services go through a provider registry and typed service ports, so swapping a source's backing API, the identity directory, or the LLM is a change to one module, not the orchestrator.

## Run it in five minutes

```bash
npm install                  # root deps
cp .env.example .env         # fill in the required keys (see CLAUDE.md > Configuration)

npm run dev:api              # Fastify API on :3001 (the review backend)
npm run dev:pipeline         # run the weekly pipeline once locally (needs DB + AWS creds)
```

```bash
npm run migrate:up           # apply pending DB migrations to DATABASE_URL
npm test                     # vitest run
npm run lint && npm run typecheck   # eslint + tsc --noEmit (CI parity)
```

Helm:

```bash
npm run chart:lint                 # helm lint chart
npm run chart:template:staging     # render against values-staging.yaml
```

## Contract surface

Shipping this on a cluster means three artifacts travel together: the **Platform CR**, the **Helm chart**, and the **gitops entry**. They're the tenant contract.

### The Platform CR (`platform.yaml`)

Two CRs under `agents.stxkxs.io/v1alpha1` — a `BudgetPolicy` and the `Platform` that references it:

```yaml
apiVersion: agents.stxkxs.io/v1alpha1
kind: BudgetPolicy
metadata:
  name: dispatch
  namespace: tenants-protohype
spec:
  platformRef: { name: dispatch }
  monthlyUsd: '2000' # kill-switch fires at 120% (USD 2400); Bedrock fanout is weekly, not per-query
  alertThresholdsPercent: [50, 80, 100]
  killSwitchEnabled: true
---
apiVersion: agents.stxkxs.io/v1alpha1
kind: Platform
metadata:
  name: dispatch
  namespace: tenants-protohype
spec:
  displayName: dispatch
  persona: ops
  tenant: protohype
  budget: { name: dispatch }
  identity:
    allowedModelFamilies: [anthropic] # Claude via Bedrock
    extraPolicyArns: [] # app pods assume the landing-zone role directly
  compliance: { soc2: true }
  isolation: namespace
```

The operator reconciles the namespace `tenants-protohype`, ResourceQuota, LimitRange, default-deny NetworkPolicy, ArgoCD AppProject, and a per-Platform IRSA role trusting the `tenant-runtime` SA. **dispatch's own app pods don't use that operator role** — all three workloads assume the landing-zone `dispatch-platform` IRSA role directly via the chart's `aws.platformRoleArn` Helm value. `extraPolicyArns` stays empty for that reason.

### The Helm chart (`chart/`)

Three workloads in one chart — the weekly pipeline, the review API, and the review web app — plus everything that supports them. Templates under `chart/templates/`:

| Template                                   | Owns                                                                                                                                                                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pipeline-cronjob.yaml`                    | The weekly runner — `CronJob` (Friday 09:00 UTC, `concurrencyPolicy: Forbid`, 30-min `activeDeadlineSeconds`)                                                                                                   |
| `api-deployment.yaml` + `api-service.yaml` | The Fastify API (JWT-gated review backend, ClusterIP :3001)                                                                                                                                                     |
| `web-deployment.yaml` + `web-service.yaml` | The Next.js review app (WorkOS AuthKit, ClusterIP :3000; `DISPATCH_API_URL` wired to the api Service DNS)                                                                                                       |
| `ingress.yaml`                             | ingress-nginx + cert-manager TLS — `/api/*` → api (rewrite-target), `/` → web                                                                                                                                   |
| `serviceaccount.yaml`                      | Shared SA across all three workloads; `eks.amazonaws.com/role-arn` rendered from `aws.platformRoleArn`                                                                                                          |
| `externalsecret.yaml`                      | ESO aggregates four Secrets Manager entries (`dispatch/<env>/{approvers,workos-directory,db-credentials,grafana-cloud}`) into one Secret consumed via `envFrom`; composes `DATABASE_URL` in the template engine |
| `migrate-job.yaml`                         | Helm pre-install/pre-upgrade hook running `npm run migrate:up` on the api image so schema lands before new pods roll                                                                                            |
| `networkpolicy.yaml`                       | Default-deny + egress allow-list (DNS, HTTPS for AWS + all aggregator sources, Postgres on the VPC CIDR) + intra-pod ingress                                                                                    |
| `prometheusrule.yaml`                      | Pipeline/Bedrock/send alerts                                                                                                                                                                                    |
| `grafana-dashboard.yaml`                   | ConfigMap loading `chart/dashboards/dispatch.json`                                                                                                                                                              |

`values.yaml` is the base; `values-staging.yaml` / `values-production.yaml` carry the per-env deltas (image tags, `aws.platformRoleArn`, `tenantInfra.*` from the landing-zone outputs, ingress host). The image is `ghcr.io/nanohype/digest-pipeline`, built per workload (`:<tag>-pipeline`, `:<tag>-api`, `:<tag>-web`). OTel attrs `agents.tenant=protohype` + `agents.platform=dispatch` are set in every values file (required by the platform-tenant contract).

### Required tenant files

A valid tenant in this repo is exactly these three, plus the chart's per-env values:

- `platform.yaml` — the `BudgetPolicy` + `Platform` CRs
- `chart/` — the chart above, with `values.yaml` + `values-staging.yaml` + `values-production.yaml`
- `gitops/applicationset-entry.yaml` — the ApplicationSet entry registered into `nanohype/eks-gitops` (matrix generator over clusters × the app, Helm multi-source `$values` resolving `values.yaml` + `values-<env>.yaml`)

## Add an aggregator

An "aggregator" is a source the weekly pipeline pulls activity from (GitHub / Linear / Notion / Slack today). Aggregators live in `src/pipeline/aggregators/` behind a provider registry (`registry.ts`). To add a fifth:

1. **Extend the source type** — add the source name to the `SourceItem['source']` union in `src/pipeline/types.ts`. Every module that switches on source reads this union, so this one edit widens them all.
2. **Write the aggregator** — add `src/pipeline/aggregators/<source>.ts` modeled on `github.ts`. Export an `Aggregator` (a `(ctx: AggregatorContext) => Promise<AggregationResult>` function). Pull from the source via the injected `ctx.services.<source>` port, resolve authors with `ctx.resolveIdentity`, and **wrap every external call in `withTimeout(..., ms)` + `withRetry(..., { attempts, jitter })`** (the resilience contract). On failure, return `{ source, items: [], error, durationMs }` rather than throwing — one failed source must not fail the run (the orchestrator marks the run `PARTIAL`).
3. **Sanitize before you return** — run each item through `sanitizeSourceItem` from `src/pipeline/filters/pii.ts` so it leaves the aggregator as a `SanitizedSourceItem`. The prompt builder only accepts that branded type, so the compiler refuses any item that skipped the PII filter.
4. **Register it** — add one `registry.register('<source>', () => aggregate<Source>)` line in `src/pipeline/aggregators/registry.ts`. The orchestrator iterates `registry.names()`, so it never changes.
5. **Provide the service port** — add the source's typed service to `AggregatorServices` in `aggregators/types.ts` and a `createXxxService` under `src/pipeline/services/`, constructed in the entrypoint.
6. **Test it** — add `src/pipeline/aggregators/<source>.test.ts` covering the happy path, the timeout/retry behavior, and the failure-returns-empty path; assert the items come back branded (PII-filtered).

## Add a Bedrock cachePoint

The newsletter generator (`src/pipeline/ai/generator.ts`) calls Claude via `InvokeModelCommand` with a system prompt that embeds the voice-baseline few-shot examples loaded from S3. Those examples are large and stable across the weekly run (and across retries within a run), which makes the **system block the ideal cache target** — only the small per-run user prompt varies. To cache it:

1. **Convert `system` to the block-array form.** The Anthropic-on-Bedrock body accepts `system` as an array of content blocks. Replace the `system: <string>` field in `callBedrock`'s request body with `system: [{ type: 'text', text: systemPrompt }, { cachePoint: { type: 'default' } }]` — the trailing `cachePoint` marker caches everything before it. (Confirm the exact marker shape against current Bedrock docs before coding — don't guess it.)
2. **Surface cache effectiveness.** Read `cache_read_input_tokens` / `cache_creation_input_tokens` from the response `usage` and record them via the existing `bedrockTokens` counter with `kind` values `cache_read` / `cache_write`, so the savings show up on the Grafana dashboard alongside `kind: input` / `output`.
3. **Test it.** Add a case to the generator test asserting the request body carries the `cachePoint` marker on the system block — this is a behavioral change and the prompt-caching gate is enforced.

## Conventions

- **Provider registry, not orchestrator edits.** Aggregators and identity resolvers register with `createRegistry<T>` (`src/common/registry.ts`). The orchestrator iterates `registry.names()`; adding a source is a registration line, never an orchestrator change.
- **`SanitizedSourceItem` brand.** Items leave an aggregator only after `sanitizeSourceItem`, which stamps a `unique symbol` brand. The LLM prompt builder's signature accepts only the branded type, so the type system enforces "PII-filtered before the model sees it." `assertNoPii` runs again at two runtime checkpoints — on the assembled prompt before the Bedrock call, and on the model's output.
- **Immutable audit-event ledger.** Every draft mutation is an append-only `audit_events` row keyed on `run_id` (`DRAFT_GENERATED`, `HUMAN_EDIT`, `APPROVED`, `SENT`, `EXPIRED`, `SOURCE_FAILURE`, `PIPELINE_FAILURE`). Audit writes are always awaited — zero fire-and-forget.
- **Resilience contract.** Every external call goes through `withTimeout` (8s default, 15s for Slack history) + `withRetry(3, jitter)` from `src/pipeline/utils/resilience.ts`. Explicit timeouts everywhere.
- TypeScript strict, ESM (`"type": "module"`, `.js` extensions in relative imports), Node ≥ 24. Zod at every boundary (API bodies, config, aggregator responses). Pino JSON to stdout with OTel `trace_id`/`span_id` auto-injected. Direct Bedrock SDK via a thin interface — no LLM framework lock-in. ESLint flat config + typescript-eslint, Prettier.

## Pointers

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — bounded contexts, the data-flow pipeline, load-bearing decisions, and where the boundaries sit (landing-zone substrate, eks-gitops addons)
- [`CLAUDE.md`](CLAUDE.md) — per-module breakdown, configuration, observability, full conventions, test map
- [`README.md`](README.md) — front door: run, test, deploy
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — the aggregator / cachePoint / chart-template recipes + the test contract + PR flow
- [`chart/README.md`](chart/README.md) — template-by-template chart reference + the per-tenant infra it expects
- [`docs/`](docs/) — local development, deployment guide, fork-for-a-new-client recipe
- [Platform Reference](../nanohype/docs/platform-reference.md) — the stack-wide view
- [`eks-agent-platform`](https://github.com/nanohype/eks-agent-platform) — the operator that reconciles the Platform CR
- [`landing-zone`](https://github.com/nanohype/landing-zone) — the `dispatch-platform` substrate the chart's IRSA role and data stores live in
