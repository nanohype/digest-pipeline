# Secrets seeding

DigestPipeline keeps credentials in **AWS Secrets Manager** — one secret per integration, with separate rotation cadences. This doc covers what each is, how to seed it, how to rotate, and how to verify.

> Two environments, two parallel secret trees. Staging lives under `digest-pipeline/staging/*`, production under `digest-pipeline/production/*`. The commands below show staging; swap `staging` for `production` to seed the other environment.

## The secrets (per environment)

Every secret below is operator-provisioned with `aws secretsmanager create-secret` **before** the chart is deployed. The chart's `externalsecret.yaml` references them by name through External Secrets Operator — it does not create them, so uninstalling the release leaves the credentials in place untouched, and the values never transit a Helm manifest.

External Secrets can't materialize the Kubernetes Secret until every referenced entry resolves, and the pods mount that Secret via `envFrom` — so a missing row here surfaces as pods stuck without their configuration.

| Secret name (`digest-pipeline/{env}/…`) | Used by | What it is |
|---|---|---|
| `approvers` | api | JSON — `{ cosUserId, backupApproverIds[] }`. The allow-list POST `/drafts/:id/approve` checks against. Rotatable without redeploy. |
| `workos-directory` | pipeline | JSON — `{ apiKey, directoryId }`. WorkOS Directory Sync read-only key for responder resolution. |
| `github` | pipeline | JSON — `{ token, repos: [{ owner, repo }, …] }`. Read-only PAT or GitHub App token; drives merged-PR fetch. |
| `linear` | pipeline | JSON — `{ apiKey, askLabel? }`. Personal API key or service OAuth token; drives closed-epic, milestone, and ask-labeled-issue fetch. `askLabel` defaults to `ask`. |
| `slack` | pipeline + api | JSON — `{ botToken, announcementsChannelId, teamChannelId, hrBotUserIds: [] }`. Bot token (`xoxb-…`) needs exactly four scopes: `channels:history`, `channels:read`, `chat:write`, `users:read` — see [`slack-app-setup.md`](slack-app-setup.md) for the one-time bot provisioning. Two channel IDs are ingestion sources for the Slack aggregator; `hrBotUserIds` are the bot user IDs to filter out (e.g. your HRIS integration). |
| `notion` | pipeline | JSON — `{ apiKey, databaseId }`. Notion internal-integration token + the all-hands database ID. |
| `web-config` | web | JSON — `{ workosApiKey, workosClientId, cookiePassword, redirectUri }`. WorkOS AuthKit for the review UI. `cookiePassword` must be ≥32 chars. |
| `runtime-config` | pipeline + api | JSON — `{ slackReviewChannelId, sesFromAddress, newsletterRecipients }`. Non-credential operational config kept alongside secrets because the ExternalSecret's `remoteRef.property` projects individual JSON fields into discrete env vars. |
| `db-credentials` | **landing-zone-managed** | JSON — `{ username, password, host, port, dbname, engine }`. Created by the `tenant-substrate` component's rds-aurora module; Aurora rotates `password` on the built-in schedule. The ExternalSecret composes these fields into `DATABASE_URL`. |

> **Different external accounts per environment.** Staging and production should have their own Slack workspace (or at minimum their own bot user + review channel), Linear workspace, Notion database, and WorkOS directory. Don't share credentials across envs — a leaked staging token would otherwise unlock production.

## Getting a WorkOS User Management ID for `approvers`

The `approvers` secret expects **User Management user IDs** (`user_01…`) — the same value that appears as the `sub` claim on the AuthKit-issued JWT, and the same value `src/api/auth.ts:48-50` compares against when gating `/drafts/:id/approve`.

> **Directory Sync IDs are a different identifier space.** If you look up your directory user in the WorkOS dashboard and copy something like `directory_user_01KPA9…`, that is **not** what goes in `approvers`. Stripping the `directory_` prefix yields a syntactically valid-looking User Management ID, but it points at nothing — don't do it.

A User Management record is created the first time someone signs in via AuthKit. Until then, the person doesn't have a `user_01…`, even if they're in Directory Sync. The cleanest way to provision yourself without deploying digest-pipeline first:

1. WorkOS dashboard → **Authentication → Features → Hosted UI**.
2. In the Hosted UI component, click the hosted AuthKit URL — it opens a new tab (`https://<slug>.authkit.app` or equivalent).
3. Sign in with your corporate SSO. WorkOS provisions (and links, if an SSO connection is in place) the User Management record against your existing email, so no duplicate account is created.
4. WorkOS dashboard → **User Management → Users** — you now appear in the list with a `user_01…` ID. That's the value for `approvers.cosUserId` (or an entry in `backupApproverIds`).

Repeat once per approver. DigestPipeline caches the `approvers` secret for 5 minutes (`src/common/secrets.ts:21`), so adding or removing an approver is live within 5 min of `npm run seed:{env}` — no redeploy, no task rollover.

**If Hosted UI doesn't appear** in that nav, no authentication method is enabled yet for this WorkOS project. Go to **User Management → Authentication → Methods** and turn on at least one (email+password, Google OAuth, or an SSO connection). AuthKit can't provision users without one.

## Telemetry carries no secret

Nothing in this table covers observability, and that is not an omission. The
pods export OTLP to the Grafana Alloy collector at
`alloy.monitoring.svc.cluster.local:4318`, an in-cluster Service whose receiver
takes no authentication — it is reachable only from inside the cluster, and
only through the egress rule in the chart's `networkpolicy.yaml`. Alloy owns
every upstream credential from there: SigV4-signed remote-write to Amazon
Managed Prometheus using its own EKS Pod Identity, with Tempo and Loki both
running in-cluster. No token the app could hold would be read by anything.

Logs take a separate route and also need no credential: pods write structured
JSON to stdout, Alloy tails it off the node into Loki. Query with
`{service="digest-pipeline-pipeline"}`; `trace_id` rides on every line, so the
Tempo ↔ Loki join is one click. See [`troubleshooting.md`](troubleshooting.md)
§ "Logs not in Grafana" for the cluster-side wiring.

## Seed all secrets in one shot (recommended)

Copy the committed template, fill in the real values, and run the seeder:

```bash
cd digest-pipeline
cp secrets.template.json digest-pipeline-secrets.staging.json
# Edit digest-pipeline-secrets.staging.json in your preferred $EDITOR.
#   - Replace every "REPLACE_ME" with the real value.
#   - You can leave web-config.cookiePassword empty — the seeder generates one.
#     from instanceId + apiToken.
#   - The file is gitignored (`digest-pipeline-secrets.*.json`).

npm run seed:staging:dry     # validates shape, lists keys, no AWS calls
npm run seed:staging         # creates or updates every required secret
```

Safety rails in the seeder (`scripts/seed-secrets.sh`):

- Validates the JSON file has every required top-level key; aborts with the missing list before any AWS call.
- Rejects any value containing `REPLACE_ME` (walks every leaf, including nested objects like `github.repos[].owner`).
- Detects whether each secret already exists and picks `put-secret-value` vs. `create-secret` — same command works for first-time seeding (none exist) and rotation (all exist).
- Never logs secret values; only key names, action taken, and character counts in dry-run mode.
- Auto-generates `web-config.cookiePassword` if empty (openssl rand, 48-char ASCII-safe).

`digest-pipeline/{env}/db-credentials` is **landing-zone-managed** and is not in the seeder's key list — the `tenant-substrate` rds-aurora module creates and owns it alongside the Aurora cluster.

After seeding, restart the running workloads so they pick up the freshly-written values. External Secrets refreshes the Kubernetes Secret on its own interval (`externalSecret.refreshInterval`, 1h by default), but `envFrom` is read once at container start:

```bash
NS=tenants-digest-pipeline

# Pull the new values now instead of waiting for the refresh interval.
kubectl -n "$NS" annotate externalsecret digest-pipeline-secrets \
  force-sync="$(date +%s)" --overwrite

kubectl -n "$NS" rollout restart deployment/digest-pipeline-api
kubectl -n "$NS" rollout restart deployment/digest-pipeline-web
# The pipeline CronJob picks up new secrets on its next scheduled run.
```

## Seed by hand (fallback)

If you need to seed from a machine without the repo checked out, the raw `aws secretsmanager` commands below work. The seeder is just a wrapper that applies shape validation + the cookie-password auto-derivation before calling them.

```bash
ENV=staging                                          # or: production

# ── approvers ───────────────────────────────────────────────────────────
aws secretsmanager create-secret \
  --region us-west-2 \
  --name digest-pipeline/${ENV}/approvers \
  --description 'WorkOS user IDs allowed to approve + send a draft.' \
  --secret-string '{
    "cosUserId":        "user_01ABC...",
    "backupApproverIds":["user_01XYZ..."]
  }'

# ── workos-directory ───────────────────────────────────────────────────
aws secretsmanager create-secret \
  --region us-west-2 \
  --name digest-pipeline/${ENV}/workos-directory \
  --description 'WorkOS Directory Sync read-only API key + directory ID.' \
  --secret-string '{
    "apiKey":     "sk_live_...",
    "directoryId":"directory_01..."
  }'

# ── github ─────────────────────────────────────────────────────────────
aws secretsmanager create-secret \
  --region us-west-2 \
  --name digest-pipeline/${ENV}/github \
  --description 'Read-only PAT or GitHub App token + repos to aggregate from.' \
  --secret-string '{
    "token": "ghp_...",
    "repos": [
      { "owner": "yourorg", "repo": "platform" },
      { "owner": "yourorg", "repo": "ingest" }
    ]
  }'

# ── linear ─────────────────────────────────────────────────────────────
aws secretsmanager create-secret \
  --region us-west-2 \
  --name digest-pipeline/${ENV}/linear \
  --description 'Linear personal API key + optional ask-label override.' \
  --secret-string '{
    "apiKey":  "lin_api_...",
    "askLabel":"ask"
  }'

# ── slack ──────────────────────────────────────────────────────────────
aws secretsmanager create-secret \
  --region us-west-2 \
  --name digest-pipeline/${ENV}/slack \
  --description 'Slack bot token + channels + HR-bot user IDs to filter out.' \
  --secret-string '{
    "botToken":               "xoxb-...",
    "announcementsChannelId": "C0000000000",
    "teamChannelId":          "C0000000001",
    "hrBotUserIds":           ["U0HRBOT0001"]
  }'

# ── notion ─────────────────────────────────────────────────────────────
aws secretsmanager create-secret \
  --region us-west-2 \
  --name digest-pipeline/${ENV}/notion \
  --description 'Notion internal integration token + all-hands database ID.' \
  --secret-string '{
    "apiKey":     "secret_...",
    "databaseId": "..."
  }'

# ── web-config (WorkOS AuthKit for the review UI) ──────────────────────
COOKIE_PASSWORD=$(openssl rand -base64 48 | tr -d '\n/' | cut -c1-48)
aws secretsmanager create-secret \
  --region us-west-2 \
  --name digest-pipeline/${ENV}/web-config \
  --description 'WorkOS AuthKit credentials for the Next.js review UI.' \
  --secret-string "{
    \"workosApiKey\":     \"sk_live_...\",
    \"workosClientId\":   \"client_01...\",
    \"cookiePassword\":   \"${COOKIE_PASSWORD}\",
    \"redirectUri\":      \"https://digest-pipeline-${ENV}.internal.company.com/callback\"
  }"

# ── runtime-config (non-credential operational config) ────────────────
aws secretsmanager create-secret \
  --region us-west-2 \
  --name digest-pipeline/${ENV}/runtime-config \
  --description 'Operational knobs consumed by the pipeline + API tasks.' \
  --secret-string '{
    "slackReviewChannelId": "C00REVIEW00",
    "sesFromAddress":       "digest-pipeline@yourco.com",
    "newsletterRecipients": "exec-list@yourco.com,staff@yourco.com"
  }'

```

`digest-pipeline/{env}/db-credentials` is **landing-zone-managed** — don't create it by hand. The `tenant-substrate` rds-aurora module creates and rotates it alongside the Aurora cluster.

## Rotate a single credential

`put-secret-value` overwrites the previous value (Secrets Manager keeps a version history). Rotate the target environment's secret, then restart that env's workloads so the new value is read at container start:

```bash
ENV=staging

aws secretsmanager put-secret-value \
  --region us-west-2 \
  --secret-id digest-pipeline/${ENV}/github \
  --secret-string "$(jq -c '.token = "ghp_NEW..."' < github-${ENV}.json)"

# Force a re-sync, then restart whatever consumes the rotated secret.
kubectl -n tenants-digest-pipeline annotate externalsecret digest-pipeline-secrets \
  force-sync="$(date +%s)" --overwrite
kubectl -n tenants-digest-pipeline rollout restart deployment/digest-pipeline-api
```

> The `approvers` secret is an exception. `src/api/auth.ts` reads it via `config.loadApprovers()` on every approve call through a `SecretsClient` that caches with a 5-minute TTL (`src/common/secrets.ts:21`), so approver rotation takes effect within 5 minutes without a redeploy or task rollover.

Rotation cadence guidance:

| Family | Cadence | Notes |
|---|---|---|
| WorkOS API key (`workos-directory`, `web-config.workosApiKey`) | 90 days | Rotate during business hours; directory lookups fail closed (PARTIAL status) if mid-rotation. |
| Slack bot token (`slack.botToken`, `web-config`) | 90 days | Or when personnel change. Must re-install the bot in the review channel after rotation. |
| GitHub / Linear / Notion tokens | 180 days | Read-only, low blast radius. |
| WorkOS AuthKit cookie password (`web-config.cookiePassword`) | 365 days | Rotation invalidates all active sessions — users must re-login. |
| SES verified identity | n/a | `sesFromAddress` is an identity name, not a credential; only rotate when the org renames the sending domain. |
| Approvers allow-list (`approvers`) | n/a | Rotates by content, not by schedule. Updated whenever the Chief of Staff changes or adds a backup approver. |

> Rotate staging and production on independent calendars. Rotating both simultaneously maximises blast radius; staggering by ≥7 days means a bad secret surfaces in staging first.

## Verification

After seeding, confirm every secret for the target env is non-empty and the cluster sees them:

```bash
ENV=staging

# 1. Are all required secrets present + populated?
for s in approvers workos-directory github linear slack notion \
         web-config runtime-config; do
  aws secretsmanager describe-secret --region us-west-2 \
    --secret-id digest-pipeline/${ENV}/${s} \
    --query '{name:Name,lastChanged:LastChangedDate}' --output text
done

# 2. Did External Secrets materialize the Kubernetes Secret?
kubectl -n tenants-digest-pipeline get externalsecret digest-pipeline-secrets \
  -o jsonpath='{.status.conditions[?(@.type=="Ready")]}'

# 3. Did the workloads start clean?
kubectl -n tenants-digest-pipeline get pods

# 4. Tail the pipeline log for Zod config errors on a fresh run.
kubectl -n tenants-digest-pipeline logs -l app.kubernetes.io/component=pipeline --tail=100 -f
```

If the pipeline / api pods crash-loop, look for `ZodError: required … missing` in the logs — one of the seeded secrets has a typo or is missing a required key.

## Security posture

- Secrets Manager encrypts at rest with an AWS-managed KMS key. To use a customer-managed key, recreate each secret under a CMK via the console or CLI. The chart doesn't own the key choice because it doesn't own the secret lifecycle.
- The `main` relational datastore's RDS-managed master secret is read by the `<env>-digest-pipeline-tenant` role through the operator-generated datastore-access policy, scoped to `secret:rds!cluster-*`. The app's own config secrets under `digest-pipeline/{env}/*` are synced into the in-cluster Secret by the external-secrets `ClusterSecretStore` (the ESO controller's own IAM), and the tenant role reads its own `digest-pipeline/{env}/*` prefix for any direct SDK fetch. No wildcards across environments — the staging role cannot read production secrets and vice versa.
- The chart references every secret by name through External Secrets Operator — the values never transit a Helm manifest or the ArgoCD state. Uninstalling the release does not delete the secrets, because the chart never owned them.
- `GetSecretValue` calls are audited to CloudTrail with the invoking principal. Rotation should be performed by a dedicated deploy role, not a personal IAM user.
- Never paste a populated secret into chat, issues, or a notebook — Secrets Manager is the authoritative store. Generated values (cookie passwords, OTLP `authHeader`) should be piped directly into `create-secret` / `put-secret-value` without being written to disk.
