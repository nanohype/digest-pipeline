# Changelog

All notable changes to DigestPipeline are documented here. Dates use ISO 8601 (YYYY-MM-DD).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) — until v1.0.0 any minor version can include breaking changes with a migration path documented in the release entry.

## [Unreleased]

## [0.1.0] — Initial release

DigestPipeline is an automated weekly newsletter pipeline for a Chief of Staff. It aggregates cross-team activity from GitHub, Linear, Notion, and Slack; resolves identities through WorkOS Directory Sync; redacts PII; generates a voice-matched draft with Claude via Bedrock; posts it to Slack for review; and sends via SES only after explicit human approval.

### Added

#### Runtime

- **Pipeline (Kubernetes CronJob, weekly).** Orchestrator runs five OTel-spanned phases: `aggregate`, `dedupe`, `rank`, `generate`, `audit_and_notify`. Aggregators run in parallel via `Promise.allSettled`; a single failed source flips the run to `PARTIAL` and does not fail the batch.
- **Aggregator registry.** One module per source (`github`, `linear`, `notion`, `slack`) registered via `createRegistry<T>` so adding a source never edits the orchestrator. Every external call is wrapped in `withTimeout` (8s default, 15s for Slack history) and `withRetry(3, jitter)`.
- **PII filter.** Regex-based redaction for compensation, performance/HR, contact info, health, HR case IDs, SSN, credit card, DOB. `assertNoPii` runs post-aggregation and post-LLM output. `SanitizedSourceItem` brand type enforces pre-LLM filtering at the type level.
- **WorkOS Directory Sync identity resolver.** Maps GitHub / Linear / Slack external IDs to `{ displayName, role, team }` via custom attributes on directory users. 4-hour in-memory cache; batch-of-10 lookups.
- **Bedrock newsletter generator.** Wraps Claude Sonnet 4.6 with voice-baseline few-shots loaded from S3. Three sub-spans: `bedrock.load_voice_baseline`, `bedrock.invoke_model`, `bedrock.validate_output`. On failure, falls back to a raw skeleton draft built from the ranked sections and audits `PIPELINE_FAILURE`.
- **Fastify API.** Routes: `GET /health`, `GET /drafts/:id`, `POST /drafts/:id/edits`, `POST /drafts/:id/approve`. Every route except `/health` gated by a WorkOS JWT middleware (verified via `jose` against the WorkOS JWKS); `/approve` additionally checks the caller against an approver allow-list loaded from Secrets Manager.
- **Next.js review UI.** `/review/[draftId]` with inline edit, 2-second debounced save, live edit-rate chip (character-level Levenshtein), and approve-and-send action gated by a confirmation dialog. WorkOS AuthKit for sign-in; route handlers proxy to the Fastify API with a session-cookie-extracted access token.
- **Immutable audit ledger.** Every draft mutation (generated, humanEdit, approved, sent, pipelineFailure) is an append-only audit event keyed on `run_id`. Edit-rate is always derivable from the ledger, never recomputed from the current draft.
- **Weekly scheduling.** The pipeline `CronJob` fires `0 9 * * 5` (Friday 09:00 UTC), `concurrencyPolicy: Forbid` with a 30-minute `activeDeadlineSeconds` and a single backoff attempt, so a run never overlaps the next week's trigger.

#### Observability

- **OpenTelemetry traces + metrics** exported OTLP to the cluster Grafana Alloy collector (`alloy.monitoring.svc.cluster.local:4318`) → Tempo (traces) and Amazon Managed Prometheus (metrics). Pipeline phases and Bedrock sub-phases are explicit named spans.
- **Pino → stdout → Loki.** Log shipping is an infrastructure concern: apps emit structured JSON to stdout; the eks-gitops cluster Alloy collector tails it into Loki (`{service="digest-pipeline-pipeline"}` / `digest-pipeline-api`). `trace_id` / `span_id` are auto-injected by `@opentelemetry/instrumentation-pino`, so every log record joins to Tempo.
- **Browser → API trace propagation.** W3C `traceparent` header added to fetch calls by `@opentelemetry/instrumentation-fetch`; the Next.js proxy routes and Fastify auto-instrumentation continue the trace so a single trace spans browser → API → Postgres.
- **Custom metrics**: `digest-pipeline.run.duration_ms{status}`, `digest-pipeline.source.{items,failure}{source}`, `digest-pipeline.bedrock.{tokens{kind,model},fallback}`, `digest-pipeline.draft.edit_rate`, `digest-pipeline.email.sent`.
- **PrometheusRule alerts** (`chart/templates/prometheusrule.yaml`) on the digest-pipeline metrics (run duration, source failures, Bedrock fallback, email sent), consumed by the cluster kube-prometheus-stack and queried from the `grafana-dashboard.yaml` ConfigMap dashboard.

#### Infrastructure (Helm chart + Platform tenant)

- **Helm chart** (`chart/`) rendering three workloads into the `tenants-digest-pipeline` namespace: the pipeline `CronJob`, the api `Deployment` (Fastify :3001), and the web `Deployment` (Next.js :3000). One base `values.yaml` plus `values-{staging,production}.yaml` delta files; env-scoped secret paths (`digest-pipeline/{env}/*`).
- **ArgoCD ApplicationSet entry** (`gitops/applicationset-entry.yaml`) for `nanohype/eks-gitops`: matrix generator (clusters × `[digest-pipeline]`), Helm multi-source `$values` pattern, sync wave 100, automated + selfHeal, ServerSideApply, `CreateNamespace=false` (the Platform reconciler owns the Namespace).
- **Platform CR + BudgetPolicy** (`platform.yaml`, applied in the `tenants-growth` management namespace) declaring digest-pipeline as a tenant of the `growth` team on the `eks-agent-platform` operator. The operator reconciles the `tenants-digest-pipeline` workload namespace, ResourceQuota (8 CPU / 16Gi across pipeline + api + web), LimitRange, default-deny NetworkPolicy, the ArgoCD AppProject, and the `<env>-digest-pipeline-tenant` IAM role.
- **Ingress + secrets + migrations.** `ingress.yaml` (ingress-nginx + cert-manager: `/api/*` → api with rewrite-target, `/` → web); `externalsecret.yaml` aggregates three AWS Secrets Manager entries into one Secret consumed via envFrom and composes `DATABASE_URL` via the External Secrets template engine; `migrate-job.yaml` is a Helm pre-install/pre-upgrade hook running `npm run migrate:up` before the new pods roll out.
- **Per-tenant AWS substrate** lives in the landing-zone `digest-pipeline-platform` component: Aurora Serverless v2 Postgres, the voice-baseline (versioned, retained) + raw-aggregations (90-day lifecycle) S3 buckets, the SES verified identity + configuration set, the app-access managed policy, and the EKS Pod Identity association that binds the chart's shared ServiceAccount to the tenant role. The chart carries no IAM — no role, no policy, no role-arn annotation.
- **IAM least privilege.** The tenant role can read only `digest-pipeline/{env}/*` secrets, invoke the Bedrock models listed in `spec.identity.allowedModels`, read the voice-baseline bucket, write the raw-aggregations bucket, and `ses:SendEmail` on the verified identity. Staging and production roles do not cross-read.

#### Operator surface

- `scripts/migrate.ts` — up/down runner against `DATABASE_URL`.
- `migrations/001_initial_schema.{up,down}.sql` — `drafts`, `audit_events` (append-only + status-transition check), `email_analytics`.
- Operator-facing secret shape is documented in [`docs/secrets.md`](docs/secrets.md); rotation + seeding commands live there too.

#### Testing + CI

- Vitest suites: PII regex coverage, ranker scoring + dedupe, resilience state machines (`withTimeout`, `withRetry`), WorkOS identity caching, voice-baseline listing, aggregator → resolver → filter → ranker → mock-Bedrock → audit integration, Levenshtein diff, and a per-aggregator-factory integration test against fake services.
- `.github/workflows/digest-pipeline-ci.yml` on PRs touching `digest-pipeline/**`: `npm audit --omit=dev --audit-level=high`, lint, typecheck, test, build, `helm lint` + chart template render (staging), web typecheck + Next.js standalone build. Node 24.

#### Documentation

- `README.md`, `CLAUDE.md`, `CHANGELOG.md`, `web/README.md`.
- `docs/deployment-guide.md` — first-time AWS setup, staging → production walkthrough, known gotchas.
- `docs/secrets.md` — every secret, JSON payload shape, `put-secret-value` commands, rotation cadence.
- `docs/slack-app-setup.md` — Slack bot app provisioning for the `#newsletter-review` channel + HR bot user list.
- `docs/troubleshooting.md` — concrete errors observed during bring-up with root cause + fix.
- `docs/forking-for-a-new-client.md` — swap secrets, WorkOS directory, Slack workspace, Linear team without touching business logic.
- `docs/local-development.md` — dev loop, local Postgres, running a full pipeline end-to-end, tests that hit real services.

### Security

- WorkOS JWT verification with remote JWKS (`jose`), issuer + audience + expiry checked on every request.
- Approver allow-list loaded from Secrets Manager — rotate approvers without redeploy.
- All SQL parameterized (`pg` `$1, $2, ...`); no string interpolation.
- Zod validation at every system boundary: API bodies, route params, Secrets Manager payloads, config, aggregator responses.
- PII filter at two checkpoints (pre-LLM and post-LLM) enforced by type-level brand.
- `@fastify/cors` with explicit `WEB_ORIGIN` allow-list, `credentials: false`.
- HTML output in the API is entity-escaped; no `dangerouslySetInnerHTML` in the web.
- Secret values never embedded in cluster manifests: the External Secrets operator syncs them from AWS Secrets Manager into an in-cluster Secret at runtime, authorized by the IAM role's scoped `secretsmanager:GetSecretValue` permission on `digest-pipeline/{env}/*`.

[Unreleased]: https://github.com/nanohype/digest-pipeline/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/nanohype/digest-pipeline/releases/tag/v0.1.0
