# digest-pipeline

![Build](https://github.com/nanohype/digest-pipeline/actions/workflows/ci.yml/badge.svg)
![License](https://img.shields.io/badge/License-Apache--2.0-green)
![Node](https://img.shields.io/badge/Node-%3E%3D24-339933?logo=node.js)
![Kubernetes](https://img.shields.io/badge/Kubernetes-Tenant-326CE5?logo=kubernetes)

Automated weekly newsletter pipeline for a Chief of Staff. Aggregates cross-team activity from GitHub, Linear, Notion, and Slack; resolves identities through WorkOS Directory Sync; redacts PII; drafts with Claude via Bedrock; gates on human approval before SES send. The internal service handle is `digest-pipeline` (the npm package, OTel `service.name` / `agents.platform`, the `digest-pipeline.*` metrics + Helm helpers + labels, and the `digest-pipeline/<env>/*` secret prefixes all stay `digest-pipeline`).

Runs every Friday morning on a single weekly CronJob (09:00 UTC). One failed source does not fail the run — status becomes `PARTIAL` and the remaining sources still produce a draft. Every mutation to a draft is an immutable audit event; the edit-rate metric is derived from the ledger, never recomputed from current draft text.

**AI clients / agents start here:** [`AGENTS.md`](AGENTS.md). For the stack-wide view, see the [Platform Reference](https://github.com/nanohype/nanohype/blob/main/docs/platform-reference.md).

## What This Is

A nanohype composite composing templates (`data-pipeline`, `worker-service`, `rag-pipeline`, `k8s-app-tenant`, `module-auth`, `slack-bot`) into a standalone weekly newsletter system, shipped as a Platform tenant. Helm chart in `chart/`, app code in `src/` + `web/`, test suites in `src/**/*.test.ts`, migrations in `migrations/`.

**Not a template** — a real application. Fork it for a different client by swapping secrets, WorkOS directory, Slack workspace, Linear project, and Notion database — [`docs/forking-for-a-new-client.md`](docs/forking-for-a-new-client.md).

## How It Works

```
        CronJob (weekly Friday 09:00 UTC)
                      │
                      ▼
 ┌──────────── pipeline Job ─────────────────────┐
 │  Aggregators (provider registry)              │
 │   ├─ GitHub                                   │
 │   ├─ Linear                                   │
 │   ├─ Notion                                   │
 │   └─ Slack                                    │
 │                                               │
 │  → WorkOS Directory identity resolver          │
 │  → PII filter (pre AND post generation)       │
 │  → Ranker + deduper                           │
 │  → NewsletterGenerator (Bedrock + voice)      │
 │  → Draft written to Aurora + audit event      │
 └──────────┬────────────────────────────────────┘
            │
            ▼
 ┌──────── Slack #newsletter-review ─────────────┐
 │  "Draft ready — review by 11am"               │
 └──────────┬────────────────────────────────────┘
            │
            ▼
 ┌──────── web Deployment (Next.js :3000) ───────┐
 │  /review/[draftId] — inline edit, approve     │
 │   ↕ api Deployment (Fastify :3001, WorkOS JWT) │
 │     GET  /drafts/:id                          │
 │     POST /drafts/:id/edits                    │
 │     POST /drafts/:id/approve  → SES send      │
 └───────────────────────────────────────────────┘
```

**Core invariant:** every mutation to a draft is an immutable audit event. Human edit deltas, approval timestamps, send receipts, expiry events — all flow through one `audit_events` table keyed on `run_id`. The edit-rate metric (character-level Levenshtein vs. auto-generated baseline) is derived from those events, never recomputed from the current draft text. That makes "who approved what and when" answerable in SQL forever.

**PII invariant:** items from aggregators cannot reach the LLM until they've passed through `sanitizeSourceItem`. The type system enforces this via a `SanitizedSourceItem` brand in `src/pipeline/types.ts` — the prompt builder literally cannot accept unsanitized items. `assertNoPii` then runs a second time on the LLM output.

## Architecture

- **`src/pipeline/index.ts`** — orchestrator. Five phases as OTel spans: `aggregate`, `dedupe`, `rank`, `generate`, `audit_and_notify`. Aggregators run in parallel via `Promise.allSettled`; a failed source is logged + counted in a metric, not fatal.
- **`src/pipeline/aggregators/`** — one module per source (`github`, `linear`, `notion`, `slack`). Each registers with the aggregator registry (`registry.ts`) via `createRegistry<T>` so adding a source never edits the orchestrator. Every external call is wrapped in `withTimeout` (8s default, 15s for Slack history) + `withRetry(3, jitter)`. Items pass through `sanitizeSourceItem` before leaving the aggregator.
- **`src/pipeline/filters/pii.ts`** — the app's PII wiring over the vendored org-wide redaction catalog (`src/vendor/runtime/pii.ts`): secrets/tokens (JWT, AWS keys, GitHub PATs, Slack tokens, API keys), SSN, credit cards, compensation, performance/HR, HR case IDs, health, DOB, contact info, AWS account ids, customer/infrastructure identifiers. Replacements are typed per label (`[EMAIL]`, `[COMPENSATION]`, …). `assertNoPii` runs at two checkpoints (post-aggregation and post-LLM output).
- **`src/pipeline/identity/workos.ts`** — WorkOS Directory Sync-backed identity resolver: 4-hour in-memory cache plus the GitHub / Linear / Slack external-id → custom-attribute mapping, over the vendored directory client (`src/vendor/runtime/workos-directory.ts`). Maps external IDs to `{ displayName, role, team }` via custom attributes on directory users. Batch-of-10 lookups; stale-cache fallback if the directory is unreachable.
- **`src/pipeline/ai/ranker.ts`** — scores items on age decay + engagement + metadata completeness, dedupes, maps to five canonical sections (`what_shipped`, `whats_coming`, `new_joiners`, `wins_recognition`, `the_ask`), caps each section at five items.
- **`src/pipeline/ai/generator.ts`** — `NewsletterGenerator` wraps Bedrock Claude with voice-baseline few-shots loaded from S3. Three sub-spans: `bedrock.load_voice_baseline`, `bedrock.invoke_model`, `bedrock.validate_output`. PII assertion at both ends; `withRetry` around the Bedrock call. On failure, falls back to a raw skeleton draft and audits `PIPELINE_FAILURE`.
- **`src/pipeline/audit.ts`** — awaited-only audit writes against the `DatabaseClient` interface. Zero fire-and-forget.
- **`src/vendor/runtime/`** — vendored `@nanohype/runtime` modules (`resilience.ts`, `registry.ts`, `pii.ts`, `workos-directory.ts`): byte-identical copies of `nanohype/library/runtime/src`, the same consumption model as the vendored `tenant-chart-base` chart. `npm run sync:vendored` re-copies from the source of truth; CI runs `npm run sync:vendored:check` as a drift gate. `withTimeout` + `withRetry` from here bound every external call site; `TimeoutError` is a distinct type so callers can branch on it.
- **`src/api/`** — Fastify server. Every route except `/health` is gated by a WorkOS JWT middleware (verified via `jose` against the WorkOS JWKS). `/approve` additionally checks the caller against an approver allow-list loaded from Secrets Manager (cached 5 min, rotatable without redeploy). Zod schemas at every boundary. SIGTERM drains in-flight requests before exit.
- **`web/`** — Next.js App Router review UI. `/review/[draftId]` page with inline edit, 2-second debounced save, live edit-rate chip (character-level Levenshtein), approve-and-send with a confirmation dialog. WorkOS AuthKit for sign-in.
- **`src/data/`** — Postgres-backed `DraftRepository` + `AuditWriter` implementations. Status transitions (`PENDING → APPROVED → SENT`) guarded by SQL `WHERE` clauses, so a draft cannot be approved twice or sent from a non-approved state.
- **`src/common/`** — shared Pino logger (stdout only — log shipping is an infrastructure concern), OTel bootstrap (`--import` loaded before app code), tracer + metrics accessors, Secrets Manager client with Zod-validated 5-minute cache.
- **`chart/`** — Helm chart with `pipeline-cronjob.yaml` (weekly Friday 09:00 UTC), `api-deployment.yaml` + `api-service.yaml` (Fastify on :3001), `web-deployment.yaml` + `web-service.yaml` (Next.js on :3000), `ingress.yaml` (ALB, ACM TLS; everything → web, which proxies to api server-side), `externalsecret.yaml` aggregating three Secrets Manager entries, `migrate-job.yaml` Helm pre-install/pre-upgrade hook running schema migrations against Aurora. See [`chart/README.md`](chart/README.md) for the full template-by-template description.
- **`platform.yaml`** — three CRs declaring digest-pipeline as a tenant of the `growth` team on the `eks-agent-platform` operator: a cluster-scoped `Tenant` (`platform.nanohype.dev/v1alpha1`) for the owning team, a `BudgetPolicy` (`governance.nanohype.dev/v1alpha1`), and the `Platform` (`platform.nanohype.dev/v1alpha1`) that references both. Operator reconciles the workload namespace, ResourceQuota, LimitRange, default-deny NetworkPolicy, the ArgoCD AppProject, and the tenant IAM role. `npm run platform:validate` gates the file against the operator's CRD schemas.
- **`gitops/applicationset-entry.yaml`** — ApplicationSet entry registered with `nanohype/eks-gitops` for ArgoCD reconciliation.

## Run locally

```bash
cp .env.example .env
npm install
npm run typecheck
npm test
```

Full local-dev loop (Postgres, running a pipeline end-to-end with staging credentials, debugging a failing staging run): [`docs/local-development.md`](docs/local-development.md).

Quick Postgres:

```bash
docker run -d --name digest-pipeline-pg -p 5432:5432 \
  -e POSTGRES_USER=digest_pipeline_app -e POSTGRES_PASSWORD=digest_pipeline_app \
  -e POSTGRES_DB=digest_pipeline postgres:16
npm run migrate:up
npm run dev:pipeline
```

Long-running processes while iterating:

```bash
npm run dev:pipeline     # tsx watch src/pipeline/entrypoint.ts (one-shot orchestrator run)
npm run dev:api          # tsx watch src/api/entrypoint.ts, :3001
cd web && npm run dev    # Next.js dev server, :3000
```

## Test

```bash
npm test                 # vitest run — all suites
npm run test:watch       # interactive watch
npm run typecheck        # tsc --noEmit
npm run lint             # Biome lint
```

Trophy-shaped test distribution — strict static analysis (`tsconfig` strict + NodeNext, Biome lint + format), integration-heavy behavioral tests at the decision points (aggregator factories, orchestrator composition, identity cache, PII regex catalogue, resilience state machines, ranker scoring, Levenshtein diff), fewer pure unit tests, no e2e beyond the manual end-to-end in [`docs/deployment-guide.md`](docs/deployment-guide.md). Details + per-file coverage: [`docs/local-development.md`](docs/local-development.md) § "Tests".

## Build

```bash
npm run build            # tsc → dist/ (production build)
cd web && npm run build  # Next.js standalone bundle for Dockerfile.web
```

## Deploy

Renders as a Platform tenant on the [`eks-agent-platform`](https://github.com/nanohype/eks-agent-platform) operator. The chart produces three workloads (pipeline CronJob + api Deployment + web Deployment), an ingress that fronts both api and web, an ExternalSecret aggregating three Secrets Manager entries into one Kubernetes Secret, and a Helm pre-install/pre-upgrade hook that runs schema migrations against Aurora before any pod from the new version rolls out.

Telemetry ships through the cluster-level OpenTelemetry Collector installed by `eks-gitops` — no per-pod sidecars. Resource names, secret paths, and IAM grants are env-scoped (`digest-pipeline/staging/*` vs `digest-pipeline/production/*`). The staging IAM role **cannot** read production secrets and vice versa.

```bash
cp secrets.template.json digest-pipeline-secrets.staging.json
# Fill in real values — replace every REPLACE_ME. cookiePassword + authHeader
# auto-derive if left empty. `digest-pipeline-secrets.*.json` is gitignored.
npm run seed:staging:dry            # validates shape, no AWS calls
npm run seed:staging                # creates/updates nine secrets in digest-pipeline/staging/*

npm run chart:lint                  # helm lint chart
npm run chart:template:staging      # render chart with staging values

# ArgoCD owns the rollout — bump image.tag in chart/values-{env}.yaml,
# commit, push. Initial tenant setup is documented in chart/README.md
# (apply platform.yaml → wait Ready → register ApplicationSet entry).
```

Requires Bedrock model access enabled in the deployment region. The per-tenant AWS substrate (the Aurora Serverless v2 store + two S3 buckets) is declared in `platform.yaml` (`spec.datastores`) and provisioned by the generic `tenant-substrate` component in [`landing-zone`](https://github.com/nanohype/landing-zone); the operator generates the scoped IAM (datastore-access + the `ses` capability grant), and SES's verified sending identity is account-level mail infrastructure. Documented in [`chart/README.md`](chart/README.md) under "Per-tenant infra".

Full first-time walkthrough covering AWS prerequisites (Bedrock model access + on-demand-throughput caveat, SES identity verification), third-party account setup, Secrets Manager seeding, WorkOS AuthKit wiring, voice-baseline corpus bootstrap, and the promotion path to production — [`docs/deployment-guide.md`](docs/deployment-guide.md).

**Forking DigestPipeline for a different client** — swap secrets, WorkOS directory, Slack workspace, Linear workspace, Notion database, and Grafana tenant without touching application code — [`docs/forking-for-a-new-client.md`](docs/forking-for-a-new-client.md).

**Secret seeding + rotation** — env-scoped inventory (`digest-pipeline/staging/*`, `digest-pipeline/production/*`), JSON payload shapes, `put-secret-value` commands, rotation cadence — [`docs/secrets.md`](docs/secrets.md).

**Slack app setup** — one-time Slack app provisioning per environment (bot scopes, channel memberships, HR-bot filtering) — [`docs/slack-app-setup.md`](docs/slack-app-setup.md).

## Boundaries

This repo owns the application — the aggregation pipeline, the PII filter, the WorkOS identity resolution, the Bedrock generator, the review API + web UI, and the tenant trio that deploys it. It does **not** own:

- AWS substrate (the Aurora Serverless v2 store + two S3 buckets, declared in `spec.datastores`) → the generic `tenant-substrate` component in [`landing-zone`](https://github.com/nanohype/landing-zone). The operator generates the datastore-access + `ses` capability grants and binds the operator-owned `tenant-runtime` ServiceAccount to the `<env>-digest-pipeline-tenant` role via a Pod Identity association; SES's verified sending identity is account-level mail infra.
- Cluster addons (cert-manager, external-secrets, external-dns, the AWS Load Balancer Controller, the OpenTelemetry Collector — the OTLP receiver and log shipper — Tempo, Loki, and grafana-operator) → [`eks-gitops`](https://github.com/nanohype/eks-gitops). This chart's `Ingress` requests the `alb` class that catalog's load balancer controller serves; see [`chart/README.md`](chart/README.md).

## Configuration

All configuration via env vars (validated by Zod at startup — `src/api/config.ts` for the API, the `PipelineEnvSchema` in `src/pipeline/entrypoint.ts` for the pipeline). In-cluster, secret values come from AWS Secrets Manager via the chart's ExternalSecret, which the External Secrets Operator syncs into one Kubernetes Secret the pods consume `envFrom`; `.env.example` is for local dev only. Full inventory + JSON payload shapes in [`docs/secrets.md`](docs/secrets.md).

| Variable                                                                         | Source                                                                                                 | Purpose                                                                                                                                                                                               |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AWS_REGION`                                                                     | chart env                                                                                              | Region for Bedrock, S3, SES, Secrets Manager                                                                                                                                                          |
| `BEDROCK_MODEL_ID`                                                               | chart env                                                                                              | Claude model to invoke (default `us.anthropic.claude-sonnet-5` — the current Claude family is inference-profile-only, so the prefix is required; switch to `eu.` in eu-central-1, `au.` in ap-southeast-2, `global.` elsewhere)              |
| `WORKOS_ISSUER` / `WORKOS_CLIENT_ID`                                             | chart env                                                                                              | JWT validation against WorkOS JWKS — `aud` claim matches Client ID                                                                                                                                    |
| `APPROVERS_SECRET_ID`                                                            | chart env → secret `digest-pipeline/{env}/approvers`                                                   | `{ cosUserId, backupApproverIds[] }` — API reads on every `/approve` call (5-min cache)                                                                                                               |
| `WORKOS_DIRECTORY_SECRET_ID`                                                     | chart env → secret `digest-pipeline/{env}/workos-directory`                                            | `{ apiKey, directoryId }` for Directory Sync                                                                                                                                                          |
| `GITHUB_SECRET_ID` / `LINEAR_SECRET_ID` / `SLACK_SECRET_ID` / `NOTION_SECRET_ID` | chart env → `digest-pipeline/{env}/{github,linear,slack,notion}`                                       | Per-provider credentials + integration config                                                                                                                                                         |
| `SLACK_REVIEW_CHANNEL_ID` / `SES_FROM_ADDRESS` / `NEWSLETTER_RECIPIENT_LIST`     | ExternalSecret → fields of secret `digest-pipeline/{env}/runtime-config`                               | Operational config co-located with secrets; the ExternalSecret projects each JSON field of `runtime-config` into its own env var on the consumed Secret                                               |
| `DATABASE_URL`                                                                   | local dev only — in-cluster the ExternalSecret composes it from `digest-pipeline/{env}/db-credentials` | Postgres connection                                                                                                                                                                                   |
| `VOICE_BASELINE_BUCKET` / `RAW_AGGREGATIONS_BUCKET`                              | chart env / ExternalSecret                                                                             | S3 bucket names (the `tenant-substrate` outputs for the `voice-baseline` + `raw-aggregations` datastores feed the per-env values)                                                                     |
| `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_SERVICE_NAME` / `OTEL_RESOURCE_ATTRIBUTES` | chart env                                                                                              | OTLP target is the cluster's OpenTelemetry Collector at `telemetry.monitoring.svc.cluster.local:4318` (no sidecar, no credential); tags traces with `service` + `agents.tenant`/`agents.platform` + `deployment.environment` |
| `OTEL_SDK_DISABLED`                                                              | tests + any run where the cluster collector isn't reachable                                            | Short-circuits the SDK; Pino still writes to stdout                                                                                                                                                   |

## Observability

OpenTelemetry for traces + metrics. Logs are decoupled from OTel — apps emit Pino JSON to stdout, the cluster collector (eks-gitops OpenTelemetry Collector) tails it into Loki, Grafana joins it to traces + metrics on `trace_id`. This keeps log routing out of the app: adding a Python or Go subsystem later is "emit JSON to stdout, done" with zero per-language transport plumbing. No per-pod sidecars.

- **Bootstrap** (`src/common/otel-bootstrap.ts`) loaded via `--import` in the pipeline + API Dockerfiles. Web uses `web/instrumentation.ts` (Next.js convention) + `web/lib/otel-browser.ts` (mounted via `OtelInit` client component).
- **Spans** — pipeline phases (`pipeline.run`, `phase.aggregate`, `phase.dedupe`, `phase.rank`, `phase.generate`, `phase.audit_and_notify`) and generator sub-phases (`bedrock.load_voice_baseline`, `bedrock.invoke_model`, `bedrock.validate_output`) are explicit. Fastify auto-instrumentation wraps every API request.
- **Metrics** (`src/common/metrics.ts`) — `digest-pipeline.run.duration_ms{status}`, `digest-pipeline.source.{items,failure}{source}`, `digest-pipeline.bedrock.{tokens{kind,model},fallback}`, `digest-pipeline.draft.edit_rate`, `digest-pipeline.email.sent`. OTLP → cluster OpenTelemetry Collector → Amazon Managed Prometheus; the chart's `prometheusrule.yaml` alerts and `grafana-dashboard.yaml` (`chart/dashboards/digest-pipeline.json`) query them.
- **Logs** — Pino → stdout → cluster OpenTelemetry Collector → Loki. `trace_id` / `span_id` auto-injected by `@opentelemetry/instrumentation-pino`.
- **Resource attributes** — `agents.tenant=growth` + `agents.platform=digest-pipeline` ride on every span/metric, keying the cluster collector pipeline + dashboard queries.
- **Sampling** — 100% (parent-based always-on at the SDK; the collector batches but does not down-sample).
- **Browser → API trace propagation** — W3C `traceparent` via `@opentelemetry/instrumentation-fetch`; the Next.js proxy routes and Fastify continue the trace, so a single trace spans browser → API → Postgres.

The app ships no telemetry credentials. The gateway's OTLP receiver is unauthenticated in-cluster (reachable only through the chart's NetworkPolicy egress rule), and the gateway owns the upstream auth itself — SigV4 remote-write to Amazon Managed Prometheus signed with its own EKS Pod Identity, with Tempo and Loki both in-cluster. There is nothing for the app to hold.

`OTEL_SDK_DISABLED=true` short-circuits the SDK — used by tests and any run where the cluster collector isn't reachable. Pino still writes to stdout regardless.

## Conventions

- TypeScript, ESM (`"type": "module"`, `.js` extensions in relative imports)
- Node >= 24 (Active LTS)
- Zod for all input validation (API bodies, config, aggregator responses, Secrets Manager payloads)
- Structured JSON logging via Pino (`getLogger()` from `src/common/logger.ts`); the API uses Fastify's `logger: getLogger()`; the pipeline uses its own. `OTEL_SERVICE_NAME` drives the `service` field. `LOG_LEVEL=silent` in tests.
- Provider registry pattern (`createRegistry<T>` from `src/vendor/runtime/registry.ts`) for aggregators and identity resolvers
- Resilience contract: every external call uses `withTimeout` (8s default, 15s for Slack history) + `withRetry(3, jitter)`
- Vendored runtime primitives (`src/vendor/runtime/`) are never edited in place — change `nanohype/library/runtime` and re-sync (`npm run sync:vendored`)
- Audit writes are always awaited. Fire-and-forget on an audit event is a correctness bug, not a style issue.
- PII filter enforced via the `SanitizedSourceItem` brand: aggregators must call `sanitizeSourceItem` before items leave the boundary; the LLM prompt builder accepts only sanitized items.
- No framework lock-in for LLMs — direct Bedrock SDK via a thin interface.

## Dependencies

- `fastify` — API server
- `jose` — JWT validation against WorkOS JWKS
- `zod` — input validation
- `@aws-sdk/client-bedrock-runtime` — Claude via Bedrock
- `@aws-sdk/client-s3` — voice baseline corpus + raw aggregation snapshots
- `@aws-sdk/client-secrets-manager` — approvers, directory credentials, provider tokens
- `@aws-sdk/client-ses` — newsletter send
- `pg` — Postgres client
- `next`, `@workos-inc/authkit-nextjs`, `react` — web approval UI
- `@opentelemetry/*` — traces + metrics; `@opentelemetry/instrumentation-pino` for trace-context injection into log records

## Reference docs

| Document                                               | Path                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------- |
| Deployment guide (step-by-step, first-time)            | [docs/deployment-guide.md](docs/deployment-guide.md)                 |
| Secrets inventory + seeding + rotation                 | [docs/secrets.md](docs/secrets.md)                                   |
| Slack app setup (one-time per env)                     | [docs/slack-app-setup.md](docs/slack-app-setup.md)                   |
| Local development (dev loop + debugging failed runs)   | [docs/local-development.md](docs/local-development.md)               |
| Troubleshooting catalogue (every concrete error + fix) | [docs/troubleshooting.md](docs/troubleshooting.md)                   |
| Forking DigestPipeline for a new client                | [docs/forking-for-a-new-client.md](docs/forking-for-a-new-client.md) |
| Changelog                                              | [CHANGELOG.md](CHANGELOG.md)                                         |
| Web review UI                                          | [web/README.md](web/README.md)                                       |
