# digest-pipeline

Automated weekly newsletter pipeline — aggregates cross-team activity, drafts with Claude via Bedrock, and gates on human approval before SES send.

> Internal service handle: `digest-pipeline`. The npm package, the OTel `service.name` / `agents.platform`, the `digest-pipeline.*` metric names + Helm helpers + labels, and the `digest-pipeline/<env>/*` secret prefixes all stay `digest-pipeline` — they're coupled to the landing-zone `digest-pipeline-platform` substrate component.

## What This Is

A nanohype composite, shipped as a standalone Platform tenant. It composes patterns from nanohype templates (data-pipeline, worker-service, rag-pipeline, k8s-app-tenant, module-auth, slack-bot) into a working weekly newsletter system for a Chief of Staff.

Runs every Friday morning. Pulls from GitHub, Linear, Notion, and Slack; resolves identities through WorkOS Directory Sync; redacts PII; generates a voice-matched draft; posts to Slack for review; sends via SES only after explicit approval.

**Not a template** — a standalone application composed from template patterns.

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

Core insight: **every mutation to a draft is an immutable audit event**. Human edit deltas, approval timestamps, send receipts, expiry events — all flow through one `audit_events` table keyed on `run_id`. The edit-rate metric (character-level Levenshtein vs. auto-generated baseline) is derived from those events, never recomputed from the current draft text.

## Architecture

- **`src/pipeline/`** — weekly one-shot orchestrator (`entrypoint.ts`), shipped as the pipeline `CronJob`. Orchestrator in `index.ts` runs aggregators in parallel (`Promise.allSettled`), deduplicates, ranks, generates, audits, and notifies. One failed source does not fail the run (status becomes `PARTIAL`).
- **`src/pipeline/aggregators/`** — One module per source. Each exports a factory that registers with the aggregator registry (`registry.ts`) so adding a source never edits the orchestrator. All external calls wrapped in `withTimeout` (8s default, 15s for Slack history) + `withRetry(3, jitter)`. Items are passed through `sanitizeSourceItem` before leaving the aggregator so the LLM prompt builder only ever sees PII-filtered content (enforced by the `SanitizedSourceItem` brand).
- **`src/pipeline/filters/pii.ts`** — Redaction policy is the vendored org-wide catalog (`src/vendor/runtime/pii.ts`): secrets/tokens (JWT, AWS keys, GitHub PATs, Slack tokens, API keys), SSN, credit cards, compensation, performance/HR, HR case IDs, health, DOB, contact info, AWS account ids, customer/infrastructure identifiers. Replacements are typed per label (`[EMAIL]`, `[COMPENSATION]`, …). `assertNoPii` runs at two checkpoints: aggregation (post-piiFilter) and post-LLM output.
- **`src/pipeline/identity/workos.ts`** — WorkOS Directory Sync-backed identity resolver with 4-hour in-memory cache and the GitHub/Linear/Slack external-id → custom-attribute mapping, over the vendored directory client (`src/vendor/runtime/workos-directory.ts`). Maps external IDs to canonical `{displayName, role, team}` via custom attributes on directory users.
- **`src/pipeline/ai/`** — `ranker.ts` scores items on age decay + engagement + metadata completeness. `generator.ts` wraps Bedrock Claude with voice-baseline few-shots loaded from S3, PII assertion at both ends, and `withRetry` around the Bedrock call.
- **`src/pipeline/audit.ts`** — Awaited-only audit writes against a `DatabaseClient` interface. Zero fire-and-forget.
- **`src/vendor/runtime/`** — vendored `@nanohype/runtime` modules (`resilience.ts`, `registry.ts`, `pii.ts`, `workos-directory.ts`), byte-identical copies of `nanohype/library/runtime/src` — the same consumption model as the vendored `chart/charts/tenant-chart-base`. `npm run sync:vendored` re-copies from the source of truth; `npm run sync:vendored:check` is the CI drift gate. Behavior changes (and their tests) land in the library first, then re-sync — never edit these copies in place. `withTimeout`/`withRetry` from here are used at every external call site.
- **`src/api/`** — Fastify server. Every route (except `/health`) gated by JWT middleware using `jose` against the WorkOS JWKS. Bodies validated with Zod. SIGTERM handler drains in-flight requests.
- **`web/`** — Next.js App Router. `/review/[draftId]` page with inline edit, live edit-rate indicator, approve-and-send action. Uses WorkOS AuthKit for authentication.
- **`src/data/`** — Postgres-backed `DraftRepository` and `AuditWriter` implementations. Migrations under `migrations/`.
- **`chart/`** — Helm chart for the k8s deployment. `Chart.yaml`, `values.yaml`, per-env deltas (`values-{staging,production}.yaml`), and templates under `chart/templates/`: `pipeline-cronjob.yaml` (CronJob — weekly Friday 09:00 UTC, concurrencyPolicy: Forbid, 30-min activeDeadline), `api-deployment.yaml` + `api-service.yaml` (Fastify on :3001), `web-deployment.yaml` + `web-service.yaml` (Next.js on :3000; wires `DIGEST_PIPELINE_API_URL` to the api Service DNS), `ingress.yaml` (ingress-nginx + cert-manager: `/api/*` → api with rewrite-target, `/` → web), `serviceaccount.yaml` (shared SA across all three workloads, name pinned to the app; bound to the operator-reconciled `<env>-digest-pipeline-tenant` role by the EKS Pod Identity association the landing-zone `digest-pipeline-platform` component creates — no role-arn annotation), `networkpolicy.yaml` (ingress: ingress-nginx + intra-pod; egress: DNS + HTTPS + Postgres on cluster VPC CIDR), `externalsecret.yaml` (aggregates three AWS Secrets Manager entries into one Secret consumed via envFrom; composes `DATABASE_URL` via the External Secrets template engine), `migrate-job.yaml` (Helm pre-install/pre-upgrade hook running `npm run migrate:up` against the api image so schema migrations land before the new pods roll out). Observability flows cluster-level via eks-gitops: structured Pino JSON to stdout → cluster Grafana Alloy collector → Loki; OTLP traces + metrics → `alloy.monitoring.svc.cluster.local:4318` → Tempo (traces) and Amazon Managed Prometheus (metrics). No per-pod sidecars, and no OTLP credential — Alloy's receiver is unauthenticated in-cluster. The chart also ships `prometheusrule.yaml` and `grafana-dashboard.yaml` (ConfigMap loading `chart/dashboards/digest-pipeline.json`). See `chart/README.md` for the full template-by-template description and where the substrate + cluster addons sit.
- **`platform.yaml`** — three CRs declaring digest-pipeline as a tenant of the `growth` team on the `eks-agent-platform` operator: a cluster-scoped `Tenant` (`platform.nanohype.dev/v1alpha1`) naming the owning team, a `BudgetPolicy` (`governance.nanohype.dev/v1alpha1`), and the `Platform` (`platform.nanohype.dev/v1alpha1`) that references both. The Tenant takes no namespace; the BudgetPolicy and Platform live in the team's management namespace `tenants-growth`. `Platform.spec.tenant` must equal the Tenant's `metadata.name`, and the operator derives everything it provisions from the Platform's `metadata.name`. `npm run platform:validate` checks all of that against the CRD schemas vendored in `schemas/crd/`. It reconciles the workload namespace `tenants-digest-pipeline`, ResourceQuota (8 CPU / 16Gi memory across pipeline + api + web), LimitRange, default-deny NetworkPolicy, the ArgoCD AppProject `digest-pipeline`, and the tenant IAM role `<env>-digest-pipeline-tenant` — trusted by the EKS Pod Identity service principal, carrying the agent-iam baseline plus every policy listed in `spec.identity.extraPolicyArns`, with Bedrock invoke clamped to `spec.identity.allowedModels`.
- **`gitops/applicationset-entry.yaml`** — ApplicationSet entry for `nanohype/eks-gitops` (`applicationsets/apps-tenants.yaml`). Matrix generator (clusters × `[digest-pipeline]`), Helm multi-source `$values` pattern, sync wave 100, syncPolicy automated+selfHeal, ServerSideApply, `CreateNamespace=false` (Platform reconciler owns the Namespace).

## Commands

```bash
npm install

npm run dev:pipeline      # Run pipeline locally (needs DB + AWS creds)
npm run dev:api           # Fastify API on :3001

npm run build             # tsc → dist/
npm run typecheck         # tsc --noEmit
npm run lint              # Biome on src/
npm test                  # vitest run
npm run test:watch        # interactive watch

npm run migrate:up        # Apply pending migrations to DATABASE_URL
npm run migrate:down      # Roll back most recent migration

npm run sync:vendored                # re-sync vendored copies (runtime, config, chart base) from ../nanohype
npm run sync:vendored:check          # CI drift gate: vendored copies match the source of truth

npm run chart:lint                  # helm lint chart
npm run chart:template:staging      # render chart with staging values
npm run chart:template:production   # render chart with production values
```

## Configuration

All config via environment variables, validated with Zod. See `.env.example`.

Key ones:

- `AWS_REGION` — for Bedrock, S3, SES, Secrets Manager (default `us-east-1`)
- `BEDROCK_MODEL_ID` — defaults to Claude Sonnet 4
- `WORKOS_ISSUER` / `WORKOS_CLIENT_ID` — JWT validation against WorkOS JWKS
- `APPROVERS_SECRET_ID` — Secrets Manager secret with `{cosUserId, backupApproverIds[]}`
- `WORKOS_DIRECTORY_SECRET_ID` — Secrets Manager secret with `{apiKey, directoryId}` for WorkOS Directory Sync
- `DATABASE_URL` — Postgres connection. In-cluster it's composed by the chart's ExternalSecret from `digest-pipeline/{env}/db-credentials`
- `VOICE_BASELINE_BUCKET`, `RAW_AGGREGATIONS_BUCKET` — S3 buckets
- `SLACK_REVIEW_CHANNEL_ID` — channel for "draft ready" notifications

## Observability

OpenTelemetry for traces + metrics. Logs are decoupled from OTel —
apps emit Pino JSON to stdout, the cluster log forwarder (eks-gitops)
tails it into Loki, Grafana joins it to traces + metrics on
`trace_id`. This keeps log routing out of the app: adding a Python or
Go subsystem later is "emit JSON to stdout, done" with zero per-language
transport plumbing.

- **Bootstrap**: `src/common/otel-bootstrap.ts` loaded via `--import` in the pipeline + API Dockerfiles. Web uses `web/instrumentation.ts` (Next.js convention) for server-side and `web/lib/otel-browser.ts` (mounted via `OtelInit` client component in `app/layout.tsx`) for browser-side.
- **Tracer**: `getTracer()` from `src/common/tracer.ts`. Pipeline phases (`pipeline.run`, `phase.aggregate`, `phase.dedupe`, `phase.rank`, `phase.generate`, `phase.audit_and_notify`) and generator sub-phases (`bedrock.load_voice_baseline`, `bedrock.invoke_model`, `bedrock.validate_output`) are explicit spans.
- **Metrics**: defined in `src/common/metrics.ts`. `digest-pipeline.run.duration_ms{status}`, `digest-pipeline.source.{items,failure}{source}`, `digest-pipeline.bedrock.{tokens{kind,model},fallback}`, `digest-pipeline.draft.edit_rate{run_id}`, `digest-pipeline.email.sent{run_id}`. Exported OTLP to the cluster Grafana Alloy collector → Amazon Managed Prometheus; the `prometheusrule.yaml` alerts and the `grafana-dashboard.yaml` dashboard (`chart/dashboards/digest-pipeline.json`) query them.
- **Logs**: Pino → stdout → cluster Grafana Alloy collector → Loki. Trace context (`trace_id`, `span_id`) is auto-injected into log records by `@opentelemetry/instrumentation-pino`, so every line carries the trace_id you need to jump into Tempo. One shared Pino factory (`getLogger()`) is used by both the pipeline orchestrator and the Fastify API (`Fastify({ logger: getLogger() })`); the `OTEL_SERVICE_NAME` env var drives the `service` field, so the same factory tags pipeline logs `digest-pipeline-pipeline` and API logs `digest-pipeline-api`.
- **Resource attributes**: `agents.tenant=growth` + `agents.platform=digest-pipeline` ride on every span/metric, keying the cluster collector pipeline + dashboard queries.
- **Sampling**: 100% (parent-based always-on at the SDK; the collector batches but does not down-sample).
- **Browser → API trace propagation**: W3C `traceparent` header is added to fetch calls by `@opentelemetry/instrumentation-fetch`. The Next.js proxy routes and the Fastify auto-instrumentation continue the trace, so a single trace spans browser → API → Postgres.

No telemetry secret. Alloy's OTLP receiver takes no authentication in-cluster, and Alloy signs its own upstream writes to Amazon Managed Prometheus with SigV4 from its EKS Pod Identity; Tempo and Loki are in-cluster. The app holds no observability credential of any kind.

`OTEL_SDK_DISABLED=true` short-circuits the SDK — used by tests and any run where the cluster collector isn't reachable. Pino still writes to stdout regardless.

## Conventions

- TypeScript, ESM (`"type": "module"`, `.js` extensions in relative imports)
- Node >= 24 (Active LTS)
- Zod for all input validation (API bodies, config, aggregator responses)
- Structured JSON logging via Pino (`getLogger()` from `src/common/logger.ts`); the API uses Fastify's bundled Pino instance, the pipeline uses its own. Both emit JSON. `LOG_LEVEL=silent` in tests.
- Provider registry pattern (`createRegistry<T>`) for aggregators and identity resolvers
- Resilience contract: every external call uses `withTimeout` (8s default, 15s for Slack history) + `withRetry(3, jitter)`
- Audit writes are always awaited
- No framework lock-in for LLMs — direct Bedrock SDK via a thin interface

## Testing

Unit tests per module with Vitest. Integration tests exercise the pipeline orchestrator (fake aggregators → real filter/ranker → mocked Bedrock → audited) and the API (Fastify `app.inject` with in-memory ports); Bedrock and the external SDKs are the only mocked boundaries. The data layer's status transitions are enforced by the database rather than by application code — conditional `WHERE` clauses plus the `status` and `event_type` CHECK constraints in `migrations/001_initial_schema.up.sql` — so the guard lives where a test could not bypass it.

- `src/pipeline/filters/pii.test.ts` — the app's PII wiring over the vendored catalog (typed tokens, widened categories live, `assertNoPii` run-id semantics, `sanitizeSourceItem`)
- `src/pipeline/ai/ranker.test.ts` — scoring, dedup, section mapping, 5-item cap
- `src/web/lib/diff.test.ts` — Levenshtein on short + long inputs
- `src/pipeline/pipeline.integration.test.ts` — fake aggregators → resolver → filter → ranker → mock Bedrock → audit

Vendored `src/vendor/runtime/` modules are not re-tested here — their unit tests live upstream in `nanohype/library/runtime` alongside the source of truth. This suite tests the app's wiring over them.

Target: ≥ 42 passing assertions. Run with `npm test`.

## Dependencies

- `fastify` — API server
- `jose` — JWT validation against WorkOS JWKS
- `zod` — input validation
- `@aws-sdk/client-bedrock-runtime` — Claude via Bedrock
- `@aws-sdk/client-s3` — voice baseline corpus
- `@aws-sdk/client-secrets-manager` — approver list, WorkOS directory credentials, provider tokens
- `@aws-sdk/client-ses` — newsletter send
- `pg` — Postgres client
- `next`, `@workos-inc/authkit-nextjs`, `react` — web approval UI
