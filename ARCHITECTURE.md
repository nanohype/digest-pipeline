# Architecture

`digest-pipeline` (internal service handle: **digest-pipeline**) is an automated weekly newsletter pipeline: it aggregates cross-team activity, drafts a voice-matched newsletter with Claude via Bedrock, and gates on human approval before sending over SES. This document covers the bounded contexts, the load-bearing decisions, the data flow of one weekly run, and where the boundaries sit relative to the rest of the stack.

## Bounded contexts

The system organizes around four contexts. External-IO inside the pipeline goes through a provider registry and typed service ports; the entrypoints are the one place real SDK clients are constructed and threaded in.

| Context      | Module path     | What it owns                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **pipeline** | `src/pipeline/` | The weekly runner. `index.ts` orchestrates aggregate → dedupe → rank → generate → audit + notify, running sources in parallel (`Promise.allSettled`) so one failed source degrades the run to `PARTIAL` rather than failing it. Aggregators (`aggregators/`) behind a registry, the WorkOS identity resolver (`identity/`), the PII filter (`filters/pii.ts`), the ranker + the Bedrock generator (`ai/`), and the vendored resilience helpers (`src/runtime/resilience.ts`) |
| **api**      | `src/api/`      | The Fastify review backend. Every route except `/health` is gated by `jose` JWT validation against the WorkOS JWKS; bodies are Zod-validated. Serves the draft, records human edits, and on approve runs the SES send. SIGTERM drains in-flight requests. Holds the approver allow-list gate                                                                                                                                                                                 |
| **web**      | `web/`          | The Next.js App Router review app. `/review/[draftId]` renders the draft with inline edit, a live edit-rate indicator, and an approve-and-send action. WorkOS AuthKit for auth; proxy routes forward to the api with the W3C trace header so a single trace spans browser → api → Postgres                                                                                                                                                                                   |
| **data**     | `src/data/`     | Postgres-backed persistence. `DraftRepository` (drafts.ts) is the draft lifecycle store; `AuditWriter` (audit.ts) is the append-only `audit_events` ledger + the derived `email_analytics` row on send. `pool.ts` builds the `pg` pool. Migrations live under `migrations/`                                                                                                                                                                                                  |

Cross-cutting (`src/common/`): `otel-bootstrap.ts` (loaded via `--import` in the pipeline + api), `tracer.ts` (`getTracer`, explicit pipeline-phase spans), `metrics.ts` (the `digest-pipeline.*` OTel instruments), `logger.ts` (one shared Pino factory; `OTEL_SERVICE_NAME` drives the `service` field), `secrets.ts`, `string.ts` (Levenshtein for the edit-rate).

Vendored (`src/runtime/`): byte-identical copies of the `@nanohype/runtime` modules this app consumes — `resilience.ts` (`withTimeout`/`withRetry`), `registry.ts` (`createRegistry<T>`), `pii.ts` (the org-wide redaction catalog), `workos-directory.ts` (the Directory Sync client). Same consumption model as the vendored `tenant-chart-base` chart: `nanohype/library/runtime` is the single source of truth (with the unit tests), `npm run sync:runtime` re-copies, and CI's `sync:runtime:check` job fails on drift.

## Key decisions

### Immutable audit-event ledger keyed on `run_id`

Every mutation to a draft — `DRAFT_GENERATED`, `HUMAN_EDIT`, `APPROVED`, `SENT`, `EXPIRED`, `SOURCE_FAILURE`, `PIPELINE_FAILURE` — is an append-only row in one `audit_events` table, keyed on the run's `run_id`. Nothing about a draft's history is recomputed from the live draft text. The edit-rate metric is the canonical example: when a human saves an edit, the api computes the character-level Levenshtein distance of the edited text against the auto-generated baseline once, stamps it onto the `HUMAN_EDIT` event, and the dashboard reads it back from the ledger. Diffing the current draft later would lose intermediate edits and conflate them; the ledger keeps the full, ordered provenance and makes "what happened to this draft, and who did it" a single query, which is what the SOC 2 posture needs.

### `SanitizedSourceItem` brand so the LLM only sees PII-filtered content

A raw `SourceItem` becomes a `SanitizedSourceItem` only by passing through `sanitizeSourceItem` (`src/pipeline/filters/pii.ts`), which stamps a `unique symbol` brand the type alone can't fabricate. The prompt builder, the ranker, and every type downstream of an aggregator accept only the branded type — so an aggregator that forgets to sanitize fails to compile, not at runtime. The PII filter applies the vendored org-wide catalog (`src/runtime/pii.ts`): secrets/tokens, SSN, credit cards, compensation, performance/HR, HR case IDs, health, DOB, contact info, AWS account ids, and customer/infrastructure identifiers — each replaced with a typed token (`[EMAIL]`, `[COMPENSATION]`, …). Belt-and-braces, `assertNoPii` runs again at two runtime checkpoints: on the assembled prompt before the Bedrock call (so any aggregator regression blocks the call rather than leaking) and on the model's output.

### Provider-registry aggregators

Aggregators register with a `createRegistry<T>` registry (`src/pipeline/aggregators/registry.ts`, over `src/runtime/registry.ts`); the orchestrator iterates `registry.names()` and never names a source directly. Adding GitHub/Linear/Notion/Slack — or a fifth source — is a registration line plus a module, not an orchestrator edit. The same registry pattern backs the identity resolvers. Each aggregator wraps its external calls in `withTimeout` + `withRetry` and returns `{ items: [], error }` on failure, so the parallel `Promise.allSettled` run absorbs a flaky source as a `PARTIAL` instead of an outage.

### The weekly CronJob is the only runner

The pipeline ships as a `CronJob` (Friday 09:00 UTC, `concurrencyPolicy: Forbid`, 30-min `activeDeadlineSeconds`, `restartPolicy: Never`) — there's no always-on pipeline pod. A weekly newsletter doesn't need one, and `Forbid` plus the deadline means a stuck run can't stack onto the next week's. Off-cycle runs are an operator break-glass action — `kubectl create job --from=cronjob/digest-pipeline-pipeline` — so an ad-hoc run reuses the exact definition the scheduler uses. There's no second runner and no app-side RBAC.

### Human-approval gate before SES send

The pipeline never sends. It writes the draft, records `DRAFT_GENERATED`, and posts "draft ready" to the Slack review channel — then stops. Sending happens only when a named approver (checked against the approver allow-list loaded from Secrets Manager) hits `POST /drafts/:id/approve` in the api, which records `APPROVED`, runs the SES send, and records `SENT` with the SES message id. A draft that nobody approves expires (`EXPIRED`) and never goes out. The whole product is "a machine drafts, a human ships" — the gate is the point, not a safety net bolted on.

## Data flow: a single weekly run

```
1.  CronJob fires (Fri 09:00 UTC)            → pipeline Job (src/pipeline/entrypoint.ts)
2.  aggregate (parallel, registry-driven)    → GitHub / Linear / Notion / Slack, each withTimeout+withRetry
3.  resolve identity (WorkOS Directory Sync, 4h in-memory cache)
                                             → external IDs → canonical {displayName, role, team}
4.  PII filter (sanitizeSourceItem)          → items leave aggregators branded SanitizedSourceItem
5.  rank + dedupe (ai/ranker.ts)             → age-decay + engagement + completeness; 5 sections, ≤5 items each
6.  generate (ai/generator.ts → Bedrock Claude over the voice-baseline few-shots; assertNoPii pre + post)
                                             → Bedrock failure? skeleton draft + alert, run goes PARTIAL
7.  audit + notify                           → draftStore.create → DRAFT_GENERATED event → Slack "draft ready"
8.  review UI (web /review/[draftId])         → inline edit; each save → POST /drafts/:id/edits → HUMAN_EDIT event
9.  approve (api POST /drafts/:id/approve)    → approver allow-list check → APPROVED event
10. SES send                                 → SES send → SENT event (+ email_analytics) → Slack "sent" confirm
```

A run with no approval expires rather than sending. The generator handles a Bedrock failure gracefully — it posts a raw skeleton draft for manual editing and marks the run `PARTIAL` instead of producing nothing. Everything that touches a draft after generation flows back through the same `run_id`-keyed audit ledger.

## What this repo deliberately does NOT do

- **Not its own cloud substrate.** It does not provision Aurora, the S3 buckets, the SES identity, KMS, or the IAM role. Those are landing-zone (see Boundaries). The chart consumes their outputs.
- **Not a model host.** Bedrock runs Claude inference outside the cluster on-account. No self-hosted models.
- **Not a cluster bootstrap.** The EKS cluster, ArgoCD, and the cluster addons it depends on (ESO, ingress-nginx, cert-manager, the observability stack) must already exist (eks-gitops).
- **Not the tenant operator.** It declares a `Platform` CR; the `eks-agent-platform` operator reconciles the namespace, IRSA, and AppProject.
- **Not an always-on service for the pipeline.** The pipeline is a scheduled `CronJob`, not a long-running pod. Only the api and web run continuously.

## Boundaries

This repo owns the application — source, chart, Platform CR, gitops entry. Everything underneath it lives in two other repos.

### Substrate → `landing-zone`

`landing-zone/components/aws/digest-pipeline-platform/` provisions the per-tenant AWS data plane and does not move here:

- Aurora Serverless v2 Postgres (the draft store + audit ledger)
- Two S3 buckets (voice-baseline corpus, raw aggregations)
- SES verified identity + configuration set (the newsletter send; DKIM CNAMEs are emitted as outputs for the operator to publish)
- Bedrock invoke policy on the IAM role
- Secrets Manager seeding (`digest-pipeline/<env>/{approvers,workos-directory,db-credentials,grafana-cloud}`)

Its IAM role is the role digest-pipeline's app pods assume, bound to the chart's ServiceAccount by an EKS Pod Identity association; the bucket names, channel id, and secret ids land in the chart's `tenantInfra.*`. The chart contains **no inline IAM**; the role and the association are owned in landing-zone and consumed by reference. All three workloads share one SA, all assume the `digest-pipeline-platform` role.

### Cluster addons → `eks-gitops`

The chart assumes these cluster-level capabilities are already installed and reconciled by `eks-gitops`:

- **External Secrets Operator** — backs `externalsecret.yaml` (aggregates the four `digest-pipeline/<env>/*` Secrets Manager entries into one Secret, composing `DATABASE_URL`)
- **ingress-nginx** + **cert-manager** — back `ingress.yaml` (TLS for `/` → web and `/api/*` → api)
- **observability stack** — the cluster OTel Collector (`otel-collector.observability.svc.cluster.local:4318`) and log forwarder that carry traces/metrics/logs to Grafana Cloud. The app emits OTLP and structured Pino JSON to stdout; there are no per-pod sidecars. The `prometheusrule.yaml` alerts and the `grafana-dashboard.yaml` dashboard (`chart/dashboards/digest-pipeline.json`) load into that stack, querying the `digest-pipeline.*` metrics.
