# Changelog

All notable changes to Dispatch are documented here. Dates use ISO 8601 (YYYY-MM-DD).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) — until v1.0.0 any minor version can include breaking changes with a migration path documented in the release entry.

## [Unreleased]

## [0.1.0] — Initial release

Dispatch is an automated weekly newsletter pipeline for a Chief of Staff. It aggregates cross-team activity from GitHub, Linear, Notion, and Slack; resolves identities through WorkOS Directory Sync; redacts PII; generates a voice-matched draft with Claude via Bedrock; posts it to Slack for review; and sends via SES only after explicit human approval.

### Added

#### Runtime

- **Pipeline (ECS Fargate, weekly).** Orchestrator runs five OTel-spanned phases: `aggregate`, `dedupe`, `rank`, `generate`, `audit_and_notify`. Aggregators run in parallel via `Promise.allSettled`; a single failed source flips the run to `PARTIAL` and does not fail the batch.
- **Aggregator registry.** One module per source (`github`, `linear`, `notion`, `slack`) registered via `createRegistry<T>` so adding a source never edits the orchestrator. Every external call is wrapped in `withTimeout` (8s default, 15s for Slack history) and `withRetry(3, jitter)`.
- **PII filter.** Regex-based redaction for compensation, performance/HR, contact info, health, HR case IDs, SSN, credit card, DOB. `assertNoPii` runs post-aggregation and post-LLM output. `SanitizedSourceItem` brand type enforces pre-LLM filtering at the type level.
- **WorkOS Directory Sync identity resolver.** Maps GitHub / Linear / Slack external IDs to `{ displayName, role, team }` via custom attributes on directory users. 4-hour in-memory cache; batch-of-10 lookups.
- **Bedrock newsletter generator.** Wraps Claude Sonnet 4.6 with voice-baseline few-shots loaded from S3. Three sub-spans: `bedrock.load_voice_baseline`, `bedrock.invoke_model`, `bedrock.validate_output`. On failure, falls back to a raw skeleton draft built from the ranked sections and audits `PIPELINE_FAILURE`.
- **Fastify API.** Routes: `GET /health`, `GET /drafts/:id`, `POST /drafts/:id/edits`, `POST /drafts/:id/approve`. Every route except `/health` gated by a WorkOS JWT middleware (verified via `jose` against the WorkOS JWKS); `/approve` additionally checks the caller against an approver allow-list loaded from Secrets Manager.
- **Next.js review UI.** `/review/[draftId]` with inline edit, 2-second debounced save, live edit-rate chip (character-level Levenshtein), and approve-and-send action gated by a confirmation dialog. WorkOS AuthKit for sign-in; route handlers proxy to the Fastify API with a session-cookie-extracted access token.
- **Immutable audit ledger.** Every draft mutation (generated, humanEdit, approved, sent, pipelineFailure) is an append-only audit event keyed on `run_id`. Edit-rate is always derivable from the ledger, never recomputed from the current draft.
- **DST-correct scheduling.** Two EventBridge rules — `cron(30 17 ? * FRI * 1-3,11-12)` for PST and `cron(30 16 ? * FRI * 4-10)` for PDT — so the Friday 9:30 AM PT run survives the time-change edge weekends.

#### Observability

- **OpenTelemetry traces + metrics** shipped via the ADOT collector sidecar to Grafana Cloud Tempo + Mimir. Pipeline phases and Bedrock sub-phases are explicit named spans.
- **Pino → stdout → CloudWatch.** Log shipping is an infrastructure concern: apps emit structured JSON; the ECS awslogs driver ships to CloudWatch log groups (`/dispatch/{env}/{pipeline,api,web}`). `trace_id` / `span_id` are auto-injected by `@opentelemetry/instrumentation-pino`, so every log record joins to Tempo. Grafana adds CloudWatch as a data source for unified UI.
- **Browser → API trace propagation.** W3C `traceparent` header added to fetch calls by `@opentelemetry/instrumentation-fetch`; the Next.js proxy routes and Fastify auto-instrumentation continue the trace so a single trace spans browser → API → Postgres.
- **Custom metrics**: `dispatch.run.duration_ms{status}`, `dispatch.source.{items,failure}{source}`, `dispatch.bedrock.{tokens{kind,model},fallback}`, `dispatch.draft.edit_rate`, `dispatch.email.sent`.
- **CloudWatch alarm** on the API's ALB 5xx count (threshold 5 in a 5-minute window, 2 consecutive periods).

#### Infrastructure (CDK v2)

- **Two-stack pattern** (`DispatchStaging`, `DispatchProduction`) sharing one codebase. Env-scoped secret paths (`dispatch/{env}/*`); staging and production can coexist in one account.
- **VPC** with public / private-with-egress / isolated subnets; Aurora Serverless v2 Postgres in the isolated subnets. Production runs a reader instance; staging is writer-only.
- **S3**: `dispatch-voice-baseline-{account}-{env}` (versioned, RETAIN in prod) for the few-shot corpus; `dispatch-raw-aggregations-{account}-{env}` (90-day lifecycle) for per-run source snapshots.
- **ECS cluster** with three Fargate services: pipeline (weekly task, scheduled by EventBridge), api (ALB-fronted, `/health` health check), web (Next.js standalone, public ALB). Each task runs an ADOT collector sidecar for traces + metrics.
- **IAM least privilege.** Pipeline task role can read only `dispatch/{env}/*` secrets, invoke `anthropic.claude-*` foundation models, read the voice-baseline bucket, write the raw-aggregations bucket. API task role adds `ses:SendEmail`. Staging and production roles do not cross-read.
- **Deletion protection** + 14-day Aurora backup retention on production; 3-day retention + `DESTROY` S3 buckets on staging.

#### Operator surface

- `scripts/migrate.ts` — up/down runner against `DATABASE_URL`.
- `migrations/001_initial_schema.{up,down}.sql` — `drafts`, `audit_events` (append-only + status-transition check), `email_analytics`.
- Operator-facing secret shape is documented in [`docs/secrets.md`](docs/secrets.md); rotation + seeding commands live there too.

#### Testing + CI

- Vitest suites: PII regex coverage, ranker scoring + dedupe, resilience state machines (`withTimeout`, `withRetry`), WorkOS identity caching, voice-baseline listing, aggregator → resolver → filter → ranker → mock-Bedrock → audit integration, Levenshtein diff, and a per-aggregator-factory integration test against fake services.
- `.github/workflows/dispatch-ci.yml` on PRs touching `dispatch/**`: `npm audit --omit=dev --audit-level=high`, lint, typecheck, test, build, CDK synth (`DispatchStaging`), web typecheck + Next.js standalone build. Node 24.

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
- Secret values never embedded in CloudFormation: CDK references secrets by name; ECS pulls values at task start via the task execution role's scoped `secretsmanager:GetSecretValue` permission.

[Unreleased]: https://github.com/nanohype/protohype/compare/feature/dispatch-v1...HEAD
[0.1.0]: https://github.com/nanohype/protohype/releases/tag/dispatch-v0.1.0
