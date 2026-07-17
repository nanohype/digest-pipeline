# Forking DigestPipeline for a new client

DigestPipeline is a nanohype composite skeleton. Forking for a different client means swapping **runtime configuration** — Secrets Manager entries, WorkOS directory, Slack workspace, Linear workspace, SES sending identity, Grafana Cloud stack — not editing business logic. Every external integration goes through a constructor-injected client (`src/pipeline/entrypoint.ts`, `src/api/entrypoint.ts`), and every AWS resource carries an env-scoped prefix (`digest-pipeline-<env>`) set by the landing-zone `digest-pipeline-platform` component.

Budget ~3 hours end-to-end: 45 min for third-party account setup, 30 min for local seed, 45 min for a clean staging deploy (substrate apply + chart sync), 30 min for a manual end-to-end run, 30 min to wire voice-baseline + Slack bot memberships.

## Before you start

Have ready:

- An AWS account + region you own (set `AWS_REGION`). Bedrock access must be enabled in the region for the Claude model ID you pick.
- A reachable EKS cluster with the eks-gitops addon catalog (ingress-nginx, cert-manager, external-secrets, OTel collector + log forwarder, kube-prometheus-stack) and the `eks-agent-platform` operator installed.
- Admin access to a Slack workspace where you can create an app. A test workspace is fine for staging.
- A WorkOS account with one Application (Client ID) + one Directory per environment. The free tier handles drill volumes.
- A Linear workspace with workflows + labels matching the aggregator's expectations (closed epics, upcoming milestones, optional `ask`-labeled issues).
- A Notion workspace with an all-hands database the integration can read.
- A GitHub org + PAT with `repo:read` over the repos you want summarized.
- A Grafana Cloud stack (free tier) with a Cloud Access Policy that has `metrics:write` + `traces:write`.
- A verified SES identity (domain or email) in the deployment region.

## 1. Name the fork

Two layers carry naming. The **product name** (`digest-pipeline`) is the GitHub repo + the docs. The **internal service handle** (`digest-pipeline`) is coupled to substrate and telemetry and stays stable unless you intentionally re-cut the whole stack. `digest-pipeline` threads through:

- Secrets Manager path prefix (`digest-pipeline/{env}/...`) — the chart's ExternalSecret `remoteRef` keys
- S3 bucket names (`digest-pipeline-voice-baseline-<account>-<env>`, `digest-pipeline-raw-aggregations-<account>-<env>`) — landing-zone `digest-pipeline-platform` outputs
- The landing-zone `digest-pipeline-platform` component + its IRSA trust on `system:serviceaccount:tenants-protohype:digest-pipeline`
- OTel `agents.platform=digest-pipeline` + the `digest-pipeline.*` metric names + the Helm `digest-pipeline.*` template helpers and `digest-pipeline.io/service` labels
- npm package name (`digest-pipeline`), the Dockerfile non-root user (`digest-pipeline`)
- Tenant identity: `tenant=protohype`, namespace `tenants-protohype`, AppProject `tenant-protohype`

If you want to rename the internal handle too — e.g. `digest` for your company — do a global find-and-replace on `digest-pipeline` (lowercase) across this repo, then re-cut the landing-zone component name + secret prefixes + IRSA trust to match, repoint the ExternalSecret `remoteRef` keys, and update the chart's image repository. That's a coordinated change across this repo + landing-zone, not a local edit. For most forks it's cheaper to keep the internal handle and rename only what's customer-visible (Slack channels, email subjects) plus the GitHub repo / product name.

## 2. Third-party account setup

### Slack app

Follow [`slack-app-setup.md`](slack-app-setup.md) verbatim. You end up with:

- Bot token (`xoxb-…`)
- Announcements channel ID
- Team channel ID
- Review channel ID
- HR bot user IDs (optional — usually your HRIS integration's user IDs)

Register the bot in each channel (`/invite @<bot>`).

### WorkOS

- **One Application per environment** → produces a Client ID (`client_01…`).
  - Set its redirect URI to `https://<stagingDomain>/callback` (and `https://<productionDomain>/callback` when you promote). Without this, AuthKit sign-in fails with `invalid_redirect_uri`.
- **One Directory per environment**, connected to your IdP.
  - Populate custom attributes on directory users for the external IDs the pipeline resolves against: `githubLogin`, `slackUserId`, `linearUserId`. If your IdP doesn't push them, set them manually via the WorkOS API or dashboard.
- **API key** (`sk_live_…`) from the dashboard. Staging and production should have separate keys.

### Linear

- Personal API key (Linear → Settings → API → Personal API keys). Read-only scope is sufficient.
- Optional: if your team tags external asks with a non-default label, set `askLabel` in `digest-pipeline/{env}/linear` to match (default is `ask`).

### Notion

- Internal integration (Notion → Settings → Connections → Develop or manage integrations) with a token (`secret_…`).
- Database ID of the all-hands page. Share the database with the integration from the Notion UI — integrations can't read pages they're not invited to.

### GitHub

- PAT with `repo:read` on the repos you want aggregated. For org-owned repos that require SSO, **authorize the token for the org** from the GitHub PAT page; otherwise the Octokit calls 404 even with valid credentials.

### Grafana Cloud

Single JSON blob at `digest-pipeline/{env}/grafana-cloud`:

- `instanceId` — grafana.com → Connections → OpenTelemetry → "Instance ID"
- `apiToken` — a Cloud Access Policy token (`glc_…`) with `metrics:write` + `traces:write`
- `otlpEndpoint` — the region-specific OTLP gateway URL, e.g. `https://otlp-gateway-prod-us-west-0.grafana.net/otlp`
- `authHeader` — pre-computed `Basic ` + base64 of `instanceId:apiToken` (the seeder snippet in [`secrets.md`](secrets.md) § "The `digest-pipeline/{env}/grafana-cloud` secret" shows the one-liner)

### SES

- Verify your sending identity (domain or email) in the deployment region.
- If SES is in sandbox mode, verify each recipient email too. Request production access via AWS Support to skip the per-recipient verification for `newsletterRecipients`.

## 3. Seed secrets

Copy the template, fill it in, seed:

```bash
cp secrets.template.json digest-pipeline-secrets.staging.json
# Edit digest-pipeline-secrets.staging.json — replace every REPLACE_ME.
# Leave web-config.cookiePassword and grafana-cloud.authHeader empty if you
# want the seeder to generate / compute them.
npm run seed:staging:dry     # validates shape, no AWS calls
AWS_PROFILE=<yours> npm run seed:staging
```

The seeder blocks if any `REPLACE_ME` slips through. `digest-pipeline-secrets.{env}.json` is in `.gitignore` — do not commit it. The chart's ExternalSecret syncs these into the in-cluster Secret once the tenant is up.

## 4. Provision the substrate, then deploy staging

The per-tenant AWS substrate (Aurora, the two S3 buckets, the SES identity, the IAM role, `db-credentials`) is the landing-zone `digest-pipeline-platform` component. Apply it, then plumb its IRSA output into the chart:

```bash
cd landing-zone
terragrunt apply --terragrunt-working-dir live/aws/workload-staging/us-west-2/staging/digest-pipeline-platform
tofu -chdir=live/aws/workload-staging/us-west-2/staging/digest-pipeline-platform output -raw irsa_role_arn
# the IAM role is bound by landing-zone's Pod Identity association — nothing to paste
```

Set `web.workosClientId` (and the API `WORKOS_CLIENT_ID`) and `image.tag` in `chart/values-staging.yaml`. Then bring the tenant up:

```bash
cd ../digest-pipeline
npm ci && npm run typecheck && npm test    # or: task ci

kubectl apply -f platform.yaml             # once; wait for Platform → Ready
# Add gitops/applicationset-entry.yaml to eks-gitops/applicationsets/apps-tenants.yaml,
# commit, push — ArgoCD renders the Application and syncs the chart.
```

The `migrate-job` pre-install hook applies the schema before the pods roll. Full step-by-step in [`deployment-guide.md`](deployment-guide.md).

## 5. Run migrations (if you need to by hand)

The chart's `migrate-job` hook normally handles this. To run migrations manually from inside the VPC (bastion, Session Manager, or a VPN):

```bash
DB_SECRET=$(aws secretsmanager get-secret-value \
  --region us-west-2 --secret-id digest-pipeline/staging/db-credentials \
  --query SecretString --output text)

export DATABASE_URL="postgres://$(echo "$DB_SECRET" | jq -r '.username'):$(echo "$DB_SECRET" | jq -r '.password' | jq -sRr @uri)@$(echo "$DB_SECRET" | jq -r '.host'):$(echo "$DB_SECRET" | jq -r '.port')/$(echo "$DB_SECRET" | jq -r '.dbname')"

npm run migrate:up
```

## 6. Upload voice-baseline corpus

```bash
aws s3 cp ./voice-baseline/example-1.md \
  s3://digest-pipeline-voice-baseline-<account>-staging/baseline/example-1.md
```

At least one file is required for voice-matching. Five is a good floor. Each file is a plain markdown newsletter that the CoS has signed off on.

## 7. Fire a manual end-to-end

The weekly `CronJob` is the scheduled runner. To kick off one run before Friday, create a Job from the CronJob template:

```bash
kubectl -n tenants-protohype create job digest-pipeline-pipeline-manual-$(date +%s) \
  --from=cronjob/digest-pipeline-pipeline
```

Watch (stdout also reaches Grafana Cloud Loki — filter `service="digest-pipeline-pipeline"`):

```bash
kubectl -n tenants-protohype logs -f job/digest-pipeline-pipeline-manual-<ts>
```

Expected: `pipeline.start` → `phase.aggregate` (per-source item counts) → `phase.dedupe` → `phase.rank` → `phase.generate` (Bedrock span with token usage) → `phase.audit_and_notify` → `slack.notify-draft` → `pipeline.exit` with `status: "OK"` (if every source returned items and Bedrock succeeded).

The review channel should get a "📰 Weekly newsletter draft ready" message with a draft ID and a link to the review page. Sign in with WorkOS, edit a few characters, approve. SES sends to the recipient list; the audit trail records `humanEdit` → `approved` → `sent`.

If all three of those pass, the fork is working.

## 8. Promote to production when you're ready

```bash
# Provision the prod substrate + seed production secrets first
# (secrets.md — repeat with env=production).
cd landing-zone
terragrunt apply --terragrunt-working-dir live/aws/workload-production/us-west-2/production/digest-pipeline-platform

cd ../digest-pipeline
npm run seed:production
# Set image.tag + web.workosClientId in
# chart/values-production.yaml, commit, push — the ApplicationSet renders
# the production Application and ArgoCD syncs it.
```

The weekly `CronJob` runs in production at the next Friday 09:00 UTC after sync. Watch the first real run carefully.

## What you should NOT touch

- `src/pipeline/filters/pii.ts` — the regex catalogue is the vendored org-wide set (`src/vendor/runtime/pii.ts`), tuned to avoid false positives on newsletter-appropriate content. Category changes land in `nanohype/library/runtime` first, then re-sync (`npm run sync:vendored`); weakening an existing category is a security regression.
- `src/pipeline/audit.ts` + `src/data/audit.ts` — all writes must stay awaited. Fire-and-forget on an audit event breaks the edit-rate derivation contract (the metric is computed from the ledger, not from current draft text).
- `src/api/auth.ts` — WorkOS JWT verification + approver allow-list. Changes here are the security-critical surface of the whole system. If you simplify this to a constant token or a different auth provider, also update the landing-zone `digest-pipeline-platform` IRSA policy + [`secrets.md`](secrets.md).
- The `SanitizedSourceItem` brand type (`src/pipeline/types.ts`). The PII filter runs before items leave the aggregator; the brand enforces this at the type level. Stripping the brand removes the compiler-enforced guarantee.

## What you might want to change

- **Schedule time** — the pipeline `CronJob` runs weekly Friday 09:00 UTC (`pipeline.schedule` in `chart/values.yaml`). Change the cron expression to match your team's rhythm and timezone.
- **Section names** (`src/pipeline/ai/ranker.ts` `section` mapping + `src/pipeline/types.ts` `SectionName` type) — defaults to `what_shipped` / `whats_coming` / `new_joiners` / `wins_recognition` / `the_ask`. Change names and the prompt builder will carry them through; Bedrock will generate headers matching whatever you name.
- **Section caps** (`src/pipeline/ai/ranker.ts`) — 5 items per section by default. Longer company, longer newsletter.
- **Ranker weights** (`src/pipeline/ai/ranker.ts`) — age decay, engagement, metadata completeness. Tune if the generated output overweights PR activity vs. Linear closures vs. Slack wins in a way that doesn't feel right.
- **Voice-baseline corpus size** — the generator loads every object under `baseline/` and concatenates them. Target length is implicit in the Bedrock context window; ~5-10 full examples is sensible, dozens starts saturating context.
- **Bedrock model ID** — default `us.anthropic.claude-sonnet-4-6` (US cross-region inference profile, on-demand). Switch to `eu.anthropic.claude-sonnet-4-6` or `ap.anthropic.claude-sonnet-4-6` outside the US, or to a bare model ID (`anthropic.claude-sonnet-4-6`) if you have provisioned-throughput capacity. See [`troubleshooting.md`](troubleshooting.md) § "Bedrock errors".
- **Approval UI copy** (`web/components/*.tsx`, `web/app/review/[draftId]/page.tsx`) — the "Approve & Send" button copy, the confirmation dialog wording. Customer-visible UX; change to match your tone.

## Support contract

DigestPipeline is a nanohype composite skeleton. Treat the code as yours after forking — there's no upstream sync path. Pull design ideas, not code.
