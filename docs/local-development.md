# Local development

How to iterate on DigestPipeline without deploying — the dev loop, a local Postgres, running a full pipeline end-to-end against staging credentials, and the test suites + what they cover.

## The dev loop

```bash
cp .env.example .env
npm install
npm run typecheck        # tsc --noEmit
npm run lint             # ESLint on src/
npm test                 # vitest run (all suites)
npm run test:watch       # interactive watch
```

Three processes you'll run while iterating:

```bash
npm run dev:pipeline     # tsx watch src/pipeline/entrypoint.ts
npm run dev:api          # tsx watch src/api/entrypoint.ts, listens on :3001
cd web && npm run dev    # Next.js dev server on :3000
```

`dev:pipeline` runs the orchestrator once and exits, mirroring the in-cluster pipeline Job behavior. `dev:api` and the Next.js dev server are long-running.

## Starting Postgres locally

DigestPipeline expects Postgres ≥ 15. The deployed cluster runs Aurora PostgreSQL 16; mirror that locally:

```bash
docker run -d --name digest-pipeline-pg -p 5432:5432 \
  -e POSTGRES_USER=digest_pipeline_app \
  -e POSTGRES_PASSWORD=digest_pipeline_app \
  -e POSTGRES_DB=digest_pipeline postgres:16

# First-time (and after schema changes):
npm run migrate:up

# To tear down:
docker stop digest-pipeline-pg && docker rm digest-pipeline-pg
```

The default `DATABASE_URL` in `.env.example` matches this setup. If you prefer a Postgres you already have, set `DATABASE_URL` accordingly — Aurora's connection string shape (`postgres://user:pass@host:port/db`) works identically.

## Running a full pipeline run locally

`dev:pipeline` hits real AWS services (Bedrock, Secrets Manager, S3) but uses a local Postgres. Expected prerequisites:

- `aws sso login` (or `AWS_PROFILE` with credentials) so Secrets Manager + Bedrock + S3 calls authenticate.
- `AWS_REGION` set (usually from your profile, but the `.env` override wins).
- `OTEL_SDK_DISABLED=true` in `.env` — the SDK won't find a collector on localhost, so disable it to skip the retries-and-warnings path.
- Staging secrets already seeded (see [`secrets.md`](secrets.md)); point the `*_SECRET_ID` env vars at `digest-pipeline/staging/*`.

```bash
# .env overrides for local + staging-creds dev:
BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-6
GITHUB_SECRET_ID=digest-pipeline/staging/github
LINEAR_SECRET_ID=digest-pipeline/staging/linear
SLACK_SECRET_ID=digest-pipeline/staging/slack
NOTION_SECRET_ID=digest-pipeline/staging/notion
WORKOS_DIRECTORY_SECRET_ID=digest-pipeline/staging/workos-directory
VOICE_BASELINE_BUCKET=digest-pipeline-voice-baseline-<account>-staging
RAW_AGGREGATIONS_BUCKET=digest-pipeline-raw-aggregations-<account>-staging
SLACK_REVIEW_CHANNEL_ID=C00STAGING00
DATABASE_URL=postgres://digest_pipeline_app:digest_pipeline_app@localhost:5432/digest_pipeline
OTEL_SDK_DISABLED=true
LOG_LEVEL=debug
```

Then:

```bash
npm run migrate:up
npm run dev:pipeline
```

The orchestrator prints every phase transition. At the end it posts a "Draft ready" message to `SLACK_REVIEW_CHANNEL_ID` — point this at a private test channel rather than the real staging review channel if you don't want to spam approvers.

### Disabling Slack notifications for local runs

Set `SLACK_REVIEW_CHANNEL_ID` to any channel the bot is a member of. If you want to skip Slack entirely, comment out the `notifier` branch in `src/pipeline/entrypoint.ts` or set a stub — the pipeline's `notifier` port accepts any `{ notifyDraftReady, alert }` implementation.

## Running the API + web against local Postgres

For end-to-end UI iteration without redeploying:

```bash
# Terminal 1 — Postgres (see above)

# Terminal 2 — API
npm run dev:api
# listens on :3001, needs WORKOS_ISSUER + WORKOS_CLIENT_ID + APPROVERS_SECRET_ID set

# Terminal 3 — web
cd web
npm run dev
# listens on :3000, proxies API calls to API_BASE_URL (default http://localhost:3001)
```

Sign in via WorkOS AuthKit (needs valid `web-config` credentials). The easiest path: seed `digest-pipeline/local/web-config` with a staging-tier Client ID + a `http://localhost:3000/callback` redirect URI registered on that Client. Then point the web dev server at it:

```bash
# web/.env.local
WORKOS_API_KEY=sk_live_...
WORKOS_CLIENT_ID=client_01...
WORKOS_COOKIE_PASSWORD=<32+ char string>
WORKOS_REDIRECT_URI=http://localhost:3000/callback
API_BASE_URL=http://localhost:3001
```

Sign in and navigate to `http://localhost:3000/review/<draftId>` — you need a draft row in Postgres. Easiest way: run `dev:pipeline` once, which creates a draft and prints the draft ID in the exit log.

## Tests

```bash
npm test                 # vitest run — all suites
npm run test:watch       # watch mode
```

Test files under `src/`:

| File | Covers |
|---|---|
| `src/pipeline/filters/pii.test.ts` | The app's PII wiring over the vendored catalog: typed tokens, widened categories live at this boundary, `assertNoPii` run-id semantics, `sanitizeSourceItem`. (The full pattern matrix is tested upstream in `nanohype/library/runtime`.) |
| `src/pipeline/ai/ranker.test.ts` | Scoring (age decay + engagement + metadata), dedup thresholds, section mapping, 5-item-per-section cap. |
| `src/pipeline/identity/workos.test.ts` | Identity cache hits + misses, batch resolution, stale-cache fallback. |
| `src/pipeline/services/voice-baseline.test.ts` | S3 listing + fetch for baseline corpus. |
| `src/pipeline/aggregators/aggregators.integration.test.ts` | Each aggregator factory against fake services — `SourceItem` shape validation end-to-end. |
| `src/pipeline/pipeline.integration.test.ts` | Fake aggregators → real resolver + filter + ranker → mock Bedrock → audit. One run end-to-end, no network. |
| `web/lib/diff.test.ts` | Levenshtein exact + sampling fallback on short and long inputs. |

`OTEL_SDK_DISABLED` and `LOG_LEVEL=silent` are set in `vitest.config.ts` so tests run clean. The SDK's worker thread is expensive to initialize; disabling it for tests saves ~2s per run.

### Static analysis

```bash
npm run typecheck   # tsc --noEmit with strict + NodeNext
npm run lint        # ESLint on src/
```

`tsconfig.json` enforces strict mode with `NodeNext` module resolution, so relative imports require the `.js` suffix. ESLint's `no-floating-promises` rule catches any accidentally un-`await`ed audit write.

## Running CI parity locally

The fastest path is `task ci`, which runs the full CI sequence in one shot. Or run the steps directly:

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build                   # tsc → dist/
npm run chart:lint              # helm lint chart
npm run chart:template:staging  # render chart with staging values
npm run chart:template:production
cd web && npm ci && npx tsc --noEmit && npm run build
```

This mirrors what `.github/workflows/ci.yml` runs. If all of these pass locally, CI should be green.

## Debugging a failing staging run

When a scheduled staging / production run fails, reproduce locally:

1. Get the `run_id` from the failure alert in Slack.
2. Pull the audit trail:

   ```bash
   DB_SECRET=$(aws secretsmanager get-secret-value --region us-west-2 \
     --secret-id digest-pipeline/staging/db-credentials \
     --query SecretString --output text)
   export PGPASSWORD=$(echo "$DB_SECRET" | jq -r .password)

   psql -h $(echo "$DB_SECRET" | jq -r .host) \
        -U $(echo "$DB_SECRET" | jq -r .username) \
        -d $(echo "$DB_SECRET" | jq -r .dbname) \
        -c "SELECT event_type, details, created_at
            FROM audit_events
            WHERE run_id = '<run_id>'
            ORDER BY created_at;"
   ```

3. The `details` JSON blob on `PIPELINE_FAILURE` records which phase failed and the error message. Armed with that, rerun locally with the same inputs (or copy the raw aggregation from `s3://digest-pipeline-raw-aggregations-<account>-staging/<run_id>/` if the snapshot made it that far).

4. Pull the run's logs. The pipeline Job's stdout goes to Grafana Cloud Loki via the cluster log forwarder — filter on `service="digest-pipeline-pipeline"` and the `run_id` field. For the live Job pod: `kubectl -n tenants-protohype logs job/<job-name>` (the CronJob spawns `digest-pipeline-pipeline-<timestamp>` Jobs). Every line carries `trace_id` so you can jump into Tempo.

## Common dev-time gotchas

- **Bedrock 403 from a local run.** Your AWS profile must have `bedrock:InvokeModel` on `anthropic.claude-*`. Request model access in the console if you haven't already, and add the permission to the IAM user or role your profile uses.
- **Aurora-shaped `DATABASE_URL` doesn't work locally.** The `digest-pipeline/<env>/db-credentials` secret (owned by the landing-zone `digest-pipeline-platform` rds-aurora module) uses `host`, `port`, `username`, `password`, `dbname` keys; the chart's ExternalSecret composes them into a `postgres://…` URL. Locally, set the simpler `postgres://…` URL directly — it's equivalent.
- **`dev:pipeline` runs forever.** `tsx watch` re-runs on every file change in `src/`; if a test file watcher is also running, you can see overlapping runs. Use `tsx src/pipeline/entrypoint.ts` (without `watch`) for a one-shot run.
- **Live-edit save fails with 401 locally.** Your WorkOS access token expired. Refresh the page to trigger AuthKit re-auth.
