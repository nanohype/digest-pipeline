# digest-pipeline — agent entry point

You're an AI client (or the author of one) about to run this service locally, add an aggregator source, wire a Bedrock cachePoint, or ship it as a Platform tenant. This file gets you running in five minutes. For the wider picture — how this repo fits into the nanohype stack — read the [Platform Reference](../nanohype/docs/platform-reference.md).

> Internal service handle: **digest-pipeline**. The GitHub repo and product name are `digest-pipeline`, but the npm package, the OTel `service.name` / `agents.platform`, the `digest-pipeline.*` metric names + template helpers + labels, and the `digest-pipeline/<env>/*` secret prefixes all stay `digest-pipeline` — the platform name the operator and `tenant-substrate` compose the tenant's per-datastore resource names from.

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
npm run lint && npm run typecheck   # biome lint + tsc --noEmit (CI parity)
```

Helm:

```bash
npm run chart:lint                 # helm lint chart
npm run chart:template:staging     # render against values-staging.yaml
```

## Contract surface

Shipping this on a cluster means three artifacts travel together: the **Platform CR**, the **Helm chart**, and the **gitops entry**. They're the tenant contract.

### The Platform CR (`platform.yaml`)

Three CRs — a cluster-scoped `Tenant` (`platform.nanohype.dev/v1alpha1`) for the owning team, a `BudgetPolicy` (`governance.nanohype.dev/v1alpha1`), and the `Platform` (`platform.nanohype.dev/v1alpha1`) that references both. `Tenant` is cluster-scoped and takes no namespace; the BudgetPolicy and Platform live in `tenants-growth`, the growth team's management namespace, which is separate from the workload namespace the operator provisions:

```yaml
apiVersion: platform.nanohype.dev/v1alpha1
kind: Tenant
metadata:
  name: growth
  labels:
    agents.nanohype.dev/tenant: growth
spec:
  displayName: Growth
  primaryPersona: ops
  aggregateMonthlyBudgetUsd: '2000' # soft cap on the sum of owned Platforms' budgets
  compliance: { soc2: true, hipaa: false }
---
apiVersion: governance.nanohype.dev/v1alpha1
kind: BudgetPolicy
metadata:
  name: digest-pipeline
  namespace: tenants-growth
spec:
  platformRef: { name: digest-pipeline }
  monthlyUsd: '2000' # kill-switch fires at 120% (USD 2400); Bedrock fanout is weekly, not per-query
  alertThresholdsPercent: [50, 80, 100]
  killSwitchEnabled: true
---
apiVersion: platform.nanohype.dev/v1alpha1
kind: Platform
metadata:
  name: digest-pipeline
  namespace: tenants-growth
spec:
  displayName: digest-pipeline
  persona: ops
  tenant: growth
  budget: { name: digest-pipeline }
  identity:
    allowedModels: [anthropic.claude-sonnet-4-6] # Bedrock invoke is clamped to this
    extraPolicyArns: [] # escape hatch; substrate + SES grants are operator-generated
    capabilities: [ses] # SES send — operator generates the grant
  compliance: { soc2: true }
  isolation: namespace
  datastores:
    - { name: main, kind: relational } # Aurora Postgres — draft + audit tables
    - { name: voice-baseline, kind: objectStore } # voice few-shot corpus
    - { name: raw-aggregations, kind: objectStore } # raw source snapshots
```

Everything the operator provisions is derived from the Platform's `metadata.name`, not from `spec.tenant`: the workload namespace `tenants-digest-pipeline`, its ResourceQuota, LimitRange and default-deny NetworkPolicy, the ArgoCD AppProject `digest-pipeline`, and the tenant IAM role `<env>-digest-pipeline-tenant`. `spec.tenant` names the owning team — it must match the `Tenant`'s `metadata.name` — and rides along as a label, an AWS `Team` tag, and the `agents.tenant` OTel attribute. The Tenant itself carries the aggregate view: it sums the budgets and readiness of every Platform that names it, so a team with several apps has one place to look.

`npm run platform:validate` checks all three documents against the operator's CRD schemas — including the cross-document references (`Platform.spec.tenant` → `Tenant.metadata.name`, `Platform.spec.budget.name` → the BudgetPolicy, and `agents.tenant` in the chart values) that no single-document schema can express. CI runs it on every pull request.

The schemas it checks against are byte-identical copies of the controller-gen output in `nanohype/eks-agent-platform`, vendored under `schemas/crd/`. Vendoring keeps the gate offline and deterministic — a validator that fetches its schema at run time reports success when the fetch fails, the one outcome a gate must never produce — and `schemas/crd/source.json` is what keeps the copies honest, from both directions:

- **Tamper.** The manifest carries a SHA-256 per file. The validator hashes each schema before parsing it, so a vendored CRD edited in place — an enum widened, a `required` dropped — aborts the run with exit 2. Still valid YAML, still rejected. No network needed, so it is the same check on a laptop and on a runner.
- **Drift.** The manifest also pins the operator commit in `upstream.ref`, which must be a full 40-character SHA — a branch name would make the verdict depend on when the gate ran. `npm run schemas:check` reads the CRDs from `nanohype/eks-agent-platform` at exactly that commit and byte-compares. A pin bumped without a re-vendor, or a copy edited and its digest quietly re-recorded to match, fails here. An unreachable upstream fails too — there is no skip path.

Both questions are answerable from the commit under test, which is what makes them safe to block on. Whether the pin has fallen behind upstream is not: that answer changes when someone pushes to the operator repo, and nothing here is broken when it comes back "behind". `npm run schemas:freshness` asks it on a weekly schedule (`.github/workflows/crd-schema-freshness.yml`), never on a pull request.

Re-vendoring is `npm run schemas:sync -- --ref=<sha>`, which rewrites the copies, the ref, and the digests together so one reviewable commit carries the schema diff and the pin move.

`npm run platform:validate` also runs the gate's `--self-test`, answering "does this gate catch anything?" — it mutates in-memory copies of `platform.yaml` and asserts each one is rejected, then asserts the committed manifest still passes.

**One Platform, one privilege domain.** All three app workloads and any AgentFleet pods run as that single `<env>-digest-pipeline-tenant` role. Its trust policy is the EKS Pod Identity service principal (`pods.eks.amazonaws.com`) — the `(namespace, service-account)` binding lives in a Pod Identity association the operator creates for the operator-owned `tenant-runtime` ServiceAccount. Bedrock invoke on the role is the agent-iam baseline clamped to `spec.identity.allowedModels`; the app's substrate grants (S3, Secrets Manager) are the datastore-access policy the operator generates from `spec.datastores`, and SES send is the capability-access policy generated from `spec.identity.capabilities`.

### The Helm chart (`chart/`)

Three workloads in one chart — the weekly pipeline, the review API, and the review web app — plus everything that supports them. Templates under `chart/templates/`:

| Template                                   | Owns                                                                                                                                                                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pipeline-cronjob.yaml`                    | The weekly runner — `CronJob` (Friday 09:00 UTC, `concurrencyPolicy: Forbid`, 30-min `activeDeadlineSeconds`)                                                                                                          |
| `api-deployment.yaml` + `api-service.yaml` | The Fastify API (JWT-gated review backend, ClusterIP :3001)                                                                                                                                                            |
| `web-deployment.yaml` + `web-service.yaml` | The Next.js review app (WorkOS AuthKit, ClusterIP :3000; `API_BASE_URL` wired to the api Service DNS)                                                                                                       |
| `ingress.yaml`                             | The single public entry point: everything under the host → web, on the `alb` class the eks-gitops load balancer controller serves. TLS terminates on the ALB against ACM. api is not routed publicly                    |
| `serviceaccount.yaml`                      | Shared SA across all three workloads, name pinned to the app; bound to the tenant IAM role by a Pod Identity association                                                                                               |
| `externalsecret.yaml`                      | ESO aggregates three Secrets Manager entries (`digest-pipeline/<env>/{approvers,workos-directory,db-credentials}`) into one Secret consumed via `envFrom`; composes `DATABASE_URL` in the template engine |
| `migrate-job.yaml`                         | Helm pre-install/pre-upgrade hook running `npm run migrate:up` on the api image so schema lands before new pods roll                                                                                                   |
| `networkpolicy.yaml`                       | Default-deny + egress allow-list (DNS, HTTPS for AWS + all aggregator sources, Postgres on the VPC CIDR) + intra-pod ingress                                                                                           |
| `prometheusrule.yaml`                      | Pipeline/Bedrock/send alert rules. `prometheusRule.enabled: false` by default — it needs a cluster running its own ruler (the local `kx` cluster does); on EKS, alerting is Grafana-managed against AMP                  |
| `grafana-dashboard.yaml`                   | `GrafanaDashboard` CR (`grafana.integreatly.org/v1beta1`) carrying `chart/dashboards/digest-pipeline.json` inline; grafana-operator imports it into the external Amazon Managed Grafana                                 |

`values.yaml` is the base; `values-staging.yaml` / `values-production.yaml` carry the per-env deltas (image tags, `tenantInfra.*` from the landing-zone outputs, ingress host). The image is `ghcr.io/nanohype/digest-pipeline`, built per workload (`:<tag>-pipeline`, `:<tag>-api`, `:<tag>-web`). OTel attrs `agents.tenant=growth` + `agents.platform=digest-pipeline` are set in every values file (required by the platform-tenant contract).

### Required tenant files

A valid tenant in this repo is exactly these three files, plus the chart's per-env values:

- `platform.yaml` — the `Tenant` + `BudgetPolicy` + `Platform` CRs
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

- **Provider registry, not orchestrator edits.** Aggregators and identity resolvers register with `createRegistry<T>` (vendored `src/vendor/runtime/registry.ts`). The orchestrator iterates `registry.names()`; adding a source is a registration line, never an orchestrator change.
- **`SanitizedSourceItem` brand.** Items leave an aggregator only after `sanitizeSourceItem`, which stamps a `unique symbol` brand. The LLM prompt builder's signature accepts only the branded type, so the type system enforces "PII-filtered before the model sees it." `assertNoPii` runs again at two runtime checkpoints — on the assembled prompt before the Bedrock call, and on the model's output.
- **Immutable audit-event ledger.** Every draft mutation is an append-only `audit_events` row keyed on `run_id` (`DRAFT_GENERATED`, `HUMAN_EDIT`, `APPROVED`, `SENT`, `EXPIRED`, `SOURCE_FAILURE`, `PIPELINE_FAILURE`). Audit writes are always awaited — zero fire-and-forget.
- **Resilience contract.** Every external call goes through `withTimeout` (8s default, 15s for Slack history) + `withRetry(3, jitter)` from the vendored `src/vendor/runtime/resilience.ts`. Explicit timeouts everywhere.
- **Vendored runtime modules are read-only.** `src/vendor/runtime/` is a byte-identical copy of `nanohype/library/runtime/src` (same model as the vendored `tenant-chart-base` chart). Change the library, then `npm run sync:vendored`; CI fails on drift.
- TypeScript strict, ESM (`"type": "module"`, `.js` extensions in relative imports), Node ≥ 24. Zod at every boundary (API bodies, config, aggregator responses). Pino JSON to stdout with OTel `trace_id`/`span_id` auto-injected. Direct Bedrock SDK via a thin interface — no LLM framework lock-in. Biome for lint + format.

## Pointers

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — bounded contexts, the data-flow pipeline, load-bearing decisions, and where the boundaries sit (landing-zone substrate, eks-gitops addons)
- [`CLAUDE.md`](CLAUDE.md) — per-module breakdown, configuration, observability, full conventions, test map
- [`README.md`](README.md) — front door: run, test, deploy
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — the aggregator / cachePoint / chart-template recipes + the test contract + PR flow
- [`chart/README.md`](chart/README.md) — template-by-template chart reference + the per-tenant infra it expects
- [`docs/`](docs/) — local development, deployment guide, fork-for-a-new-client recipe
- [Platform Reference](../nanohype/docs/platform-reference.md) — the stack-wide view
- [`eks-agent-platform`](https://github.com/nanohype/eks-agent-platform) — the operator that reconciles the Platform CR
- [`landing-zone`](https://github.com/nanohype/landing-zone) — the generic `tenant-substrate` component that provisions the tenant's declared datastores, plus `agent-iam` for the operator's IAM substrate
