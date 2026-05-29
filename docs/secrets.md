# Secrets seeding

Dispatch keeps credentials in **AWS Secrets Manager** — one secret per integration, with separate rotation cadences. This doc covers what each is, how to seed it, how to rotate, and how to verify.

> Two environments, two parallel secret trees. Staging lives under `dispatch/staging/*`, production under `dispatch/production/*`. The commands below show staging; swap `staging` for `production` to seed the other environment.

## The secrets (per environment)

Every secret below is operator-provisioned with `aws secretsmanager create-secret` **before** the first `cdk deploy`. CDK references them by name via `Secret.fromSecretNameV2(...)` — it does not create them, so `cdk destroy` leaves the credentials in place untouched, and the values never transit CloudFormation.

ECS refuses to start the pipeline / api / web tasks until the task execution role can resolve every `ecs.Secret.fromSecretsManager(...)` reference, so every row below must exist at `cdk deploy` time.

| Secret name (`dispatch/{env}/…`) | Used by | What it is |
|---|---|---|
| `approvers` | api | JSON — `{ cosUserId, backupApproverIds[] }`. The allow-list POST `/drafts/:id/approve` checks against. Rotatable without redeploy. |
| `workos-directory` | pipeline | JSON — `{ apiKey, directoryId }`. WorkOS Directory Sync read-only key for responder resolution. |
| `github` | pipeline | JSON — `{ token, repos: [{ owner, repo }, …] }`. Read-only PAT or GitHub App token; drives merged-PR fetch. |
| `linear` | pipeline | JSON — `{ apiKey, askLabel? }`. Personal API key or service OAuth token; drives closed-epic, milestone, and ask-labeled-issue fetch. `askLabel` defaults to `ask`. |
| `slack` | pipeline + api | JSON — `{ botToken, announcementsChannelId, teamChannelId, hrBotUserIds: [] }`. Bot token (`xoxb-…`) needs exactly four scopes: `channels:history`, `channels:read`, `chat:write`, `users:read` — see [`slack-app-setup.md`](slack-app-setup.md) for the one-time bot provisioning. Two channel IDs are ingestion sources for the Slack aggregator; `hrBotUserIds` are the bot user IDs to filter out (e.g. your HRIS integration). |
| `notion` | pipeline | JSON — `{ apiKey, databaseId }`. Notion internal-integration token + the all-hands database ID. |
| `web-config` | web | JSON — `{ workosApiKey, workosClientId, cookiePassword, redirectUri }`. WorkOS AuthKit for the review UI. `cookiePassword` must be ≥32 chars. |
| `runtime-config` | pipeline + api | JSON — `{ slackReviewChannelId, sesFromAddress, newsletterRecipients }`. Non-credential operational config kept alongside secrets because ECS's `Secret.fromSecretsManager(..., 'field')` lets us project individual JSON fields into env vars. |
| `db-credentials` | **CDK-managed** | JSON — `{ username, password, host, port, dbname, engine }`. Created by the `DispatchDb` construct (`secretsmanager.Secret(...)` with `generateSecretString`); Aurora rotates `password` on the built-in schedule. Pipeline + api resolve it via `DATABASE_SECRET_ID` in `src/pipeline/entrypoint.ts:87-97`. |
| `grafana-cloud` | ADOT collector sidecar | JSON — `{ instanceId, apiToken, otlpEndpoint, authHeader }`. The operator pre-computes `authHeader = "Basic " + base64("instanceId:apiToken")` once; the collector injects it into the OTLP exporter's `Authorization` header. |

> **Different external accounts per environment.** Staging and production should have their own Slack workspace (or at minimum their own bot user + review channel), Linear workspace, Notion database, WorkOS directory, and Grafana Cloud stack. Don't share credentials across envs — a leaked staging token would otherwise unlock production.

## Getting a WorkOS User Management ID for `approvers`

The `approvers` secret expects **User Management user IDs** (`user_01…`) — the same value that appears as the `sub` claim on the AuthKit-issued JWT, and the same value `src/api/auth.ts:48-50` compares against when gating `/drafts/:id/approve`.

> **Directory Sync IDs are a different identifier space.** If you look up your directory user in the WorkOS dashboard and copy something like `directory_user_01KPA9…`, that is **not** what goes in `approvers`. Stripping the `directory_` prefix yields a syntactically valid-looking User Management ID, but it points at nothing — don't do it.

A User Management record is created the first time someone signs in via AuthKit. Until then, the person doesn't have a `user_01…`, even if they're in Directory Sync. The cleanest way to provision yourself without deploying dispatch first:

1. WorkOS dashboard → **Authentication → Features → Hosted UI**.
2. In the Hosted UI component, click the hosted AuthKit URL — it opens a new tab (`https://<slug>.authkit.app` or equivalent).
3. Sign in with your corporate SSO. WorkOS provisions (and links, if an SSO connection is in place) the User Management record against your existing email, so no duplicate account is created.
4. WorkOS dashboard → **User Management → Users** — you now appear in the list with a `user_01…` ID. That's the value for `approvers.cosUserId` (or an entry in `backupApproverIds`).

Repeat once per approver. Dispatch caches the `approvers` secret for 5 minutes (`src/common/secrets.ts:21`), so adding or removing an approver is live within 5 min of `npm run seed:{env}` — no redeploy, no task rollover.

**If Hosted UI doesn't appear** in that nav, no authentication method is enabled yet for this WorkOS project. Go to **User Management → Authentication → Methods** and turn on at least one (email+password, Google OAuth, or an SSO connection). AuthKit can't provision users without one.

## The `dispatch/{env}/grafana-cloud` secret (JSON payload)

The ADOT collector sidecar reads the Grafana Cloud OTLP credentials from this one secret and injects them into the collector's `basicauth/grafana` extension via `env:` variables wired in `infra/lib/dispatch-stack.ts`:

```yaml
exporters:
  otlphttp/grafana:
    endpoint: ${env:GRAFANA_OTLP_ENDPOINT}
    headers:
      Authorization: ${env:GRAFANA_AUTH_HEADER}
```

Required schema:

```json
{
  "instanceId":   "<OTLP instance ID from grafana.com → Connections → OpenTelemetry>",
  "apiToken":     "<glc_... from a Cloud Access Policy with metrics:write + traces:write>",
  "otlpEndpoint": "https://otlp-gateway-prod-us-west-0.grafana.net/otlp",
  "authHeader":   "Basic <base64(instanceId:apiToken)>"
}
```

Creating it for the first time (staging shown; repeat with production values):

```bash
OTLP_INSTANCE_ID=...
OTLP_API_TOKEN=glc_...
OTLP_ENDPOINT=https://otlp-gateway-prod-us-west-0.grafana.net/otlp   # pick the right region
AUTH_HEADER="Basic $(printf '%s:%s' "$OTLP_INSTANCE_ID" "$OTLP_API_TOKEN" | base64)"

aws secretsmanager create-secret \
  --region us-west-2 \
  --name dispatch/staging/grafana-cloud \
  --description 'Grafana Cloud (staging): OTLP endpoint + pre-computed basic-auth header.' \
  --secret-string "{
    \"instanceId\":   \"$OTLP_INSTANCE_ID\",
    \"apiToken\":     \"$OTLP_API_TOKEN\",
    \"otlpEndpoint\": \"$OTLP_ENDPOINT\",
    \"authHeader\":   \"$AUTH_HEADER\"
  }"
```

> **Logs do not go through this secret.** Dispatch ships logs directly from stdout via the ECS awslogs driver to CloudWatch. The collector sidecar only handles traces + metrics. There is no `lokiEndpoint` or `lokiUsername` field in `dispatch/{env}/grafana-cloud` — if you see one, it's a leftover from an earlier iteration and can be removed. See [`troubleshooting.md`](troubleshooting.md) § "Logs not in Grafana" for the Grafana-side wiring.

## Seed all secrets in one shot (recommended)

Copy the committed template, fill in the real values, and run the seeder:

```bash
cd dispatch
cp secrets.template.json dispatch-secrets.staging.json
# Edit dispatch-secrets.staging.json in your preferred $EDITOR.
#   - Replace every "REPLACE_ME" with the real value.
#   - You can leave web-config.cookiePassword empty — the seeder generates one.
#   - You can leave grafana-cloud.authHeader empty — the seeder computes it
#     from instanceId + apiToken.
#   - The file is gitignored (`dispatch-secrets.*.json`).

npm run seed:staging:dry     # validates shape, lists keys, no AWS calls
npm run seed:staging         # creates or updates every required secret
```

Safety rails in the seeder (`scripts/seed-secrets.sh`):

- Validates the JSON file has every required top-level key; aborts with the missing list before any AWS call.
- Rejects any value containing `REPLACE_ME` (walks every leaf, including nested objects like `github.repos[].owner`).
- Detects whether each secret already exists and picks `put-secret-value` vs. `create-secret` — same command works for first-time seeding (none exist) and rotation (all exist).
- Never logs secret values; only key names, action taken, and character counts in dry-run mode.
- Auto-generates `web-config.cookiePassword` if empty (openssl rand, 48-char ASCII-safe).
- Auto-computes `grafana-cloud.authHeader = "Basic " + base64(instanceId:apiToken)` if empty.

`dispatch/{env}/db-credentials` is **CDK-managed** and is not in the seeder's key list — the `DispatchDb` construct creates and owns it alongside the Aurora cluster.

After seeding, force an ECS rollover so the already-running api + web tasks pick up the freshly-written values:

```bash
CLUSTER=$(aws cloudformation describe-stacks --region us-west-2 \
  --stack-name DispatchStaging \
  --query "Stacks[0].Resources[?ResourceType=='AWS::ECS::Cluster'].PhysicalResourceId" \
  --output text)

aws ecs update-service --region us-west-2 --cluster "$CLUSTER" \
  --service DispatchApiService --force-new-deployment
aws ecs update-service --region us-west-2 --cluster "$CLUSTER" \
  --service DispatchWebService --force-new-deployment
# The pipeline picks up new secrets on the next scheduled run.
```

## Seed by hand (fallback)

If you need to seed from a machine without the repo checked out, the raw `aws secretsmanager` commands below work. The seeder is just a wrapper that applies shape validation + the two auto-derivations before calling them.

```bash
ENV=staging                                          # or: production

# ── approvers ───────────────────────────────────────────────────────────
aws secretsmanager create-secret \
  --region us-west-2 \
  --name dispatch/${ENV}/approvers \
  --description 'WorkOS user IDs allowed to approve + send a draft.' \
  --secret-string '{
    "cosUserId":        "user_01ABC...",
    "backupApproverIds":["user_01XYZ..."]
  }'

# ── workos-directory ───────────────────────────────────────────────────
aws secretsmanager create-secret \
  --region us-west-2 \
  --name dispatch/${ENV}/workos-directory \
  --description 'WorkOS Directory Sync read-only API key + directory ID.' \
  --secret-string '{
    "apiKey":     "sk_live_...",
    "directoryId":"directory_01..."
  }'

# ── github ─────────────────────────────────────────────────────────────
aws secretsmanager create-secret \
  --region us-west-2 \
  --name dispatch/${ENV}/github \
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
  --name dispatch/${ENV}/linear \
  --description 'Linear personal API key + optional ask-label override.' \
  --secret-string '{
    "apiKey":  "lin_api_...",
    "askLabel":"ask"
  }'

# ── slack ──────────────────────────────────────────────────────────────
aws secretsmanager create-secret \
  --region us-west-2 \
  --name dispatch/${ENV}/slack \
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
  --name dispatch/${ENV}/notion \
  --description 'Notion internal integration token + all-hands database ID.' \
  --secret-string '{
    "apiKey":     "secret_...",
    "databaseId": "..."
  }'

# ── web-config (WorkOS AuthKit for the review UI) ──────────────────────
COOKIE_PASSWORD=$(openssl rand -base64 48 | tr -d '\n/' | cut -c1-48)
aws secretsmanager create-secret \
  --region us-west-2 \
  --name dispatch/${ENV}/web-config \
  --description 'WorkOS AuthKit credentials for the Next.js review UI.' \
  --secret-string "{
    \"workosApiKey\":     \"sk_live_...\",
    \"workosClientId\":   \"client_01...\",
    \"cookiePassword\":   \"${COOKIE_PASSWORD}\",
    \"redirectUri\":      \"https://dispatch-${ENV}.internal.company.com/callback\"
  }"

# ── runtime-config (non-credential operational config) ────────────────
aws secretsmanager create-secret \
  --region us-west-2 \
  --name dispatch/${ENV}/runtime-config \
  --description 'Operational knobs consumed by the pipeline + API tasks.' \
  --secret-string '{
    "slackReviewChannelId": "C00REVIEW00",
    "sesFromAddress":       "dispatch@yourco.com",
    "newsletterRecipients": "exec-list@yourco.com,staff@yourco.com"
  }'

# ── grafana-cloud (see schema above) ───────────────────────────────────
# Create separately using the snippet in § "The dispatch/{env}/grafana-cloud secret".
```

`dispatch/{env}/db-credentials` is **CDK-managed** — don't create it by hand. The `DispatchDb` construct creates and rotates it alongside the Aurora cluster.

## Rotate a single credential

`put-secret-value` overwrites the previous value (Secrets Manager keeps a version history). Rotate the target environment's secret, then bounce that env's ECS service(s) so the task execution role pulls the new value at container start:

```bash
ENV=staging

aws secretsmanager put-secret-value \
  --region us-west-2 \
  --secret-id dispatch/${ENV}/github \
  --secret-string "$(jq -c '.token = "ghp_NEW..."' < github-${ENV}.json)"

# Force rollover of any service that consumes the rotated secret.
aws ecs update-service \
  --region us-west-2 \
  --cluster DispatchCluster-... \
  --service DispatchPipelineService-... \
  --force-new-deployment
aws ecs update-service \
  --region us-west-2 \
  --cluster DispatchCluster-... \
  --service DispatchApiService-... \
  --force-new-deployment
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
| Grafana Cloud write token (`grafana-cloud.apiToken`) | 90 days | When rotating, regenerate `authHeader` from the new `instanceId:apiToken`. The collector sidecar picks up the new value on the next task rollover. |

> Rotate staging and production on independent calendars. Rotating both simultaneously maximises blast radius; staggering by ≥7 days means a bad secret surfaces in staging first.

## Verification

After seeding, confirm every secret for the target env is non-empty and ECS sees them:

```bash
ENV=staging

# 1. Are all required secrets present + populated?
for s in approvers workos-directory github linear slack notion \
         web-config runtime-config grafana-cloud; do
  aws secretsmanager describe-secret --region us-west-2 \
    --secret-id dispatch/${ENV}/${s} \
    --query '{name:Name,lastChanged:LastChangedDate}' --output text
done

# 2. Did the ECS tasks start clean?
CLUSTER=$(aws cloudformation describe-stacks --region us-west-2 \
  --stack-name Dispatch$(echo ${ENV^}) \
  --query "Stacks[0].Outputs[?OutputKey=='ClusterName'].OutputValue" --output text)
aws ecs describe-services \
  --region us-west-2 --cluster "$CLUSTER" \
  --services DispatchApiService DispatchWebService \
  --query 'services[].{name:serviceName,desired:desiredCount,running:runningCount,lastEvent:events[0].message}'

# 3. Tail the pipeline log for Zod config errors on a fresh run.
aws logs tail /dispatch/${ENV}/pipeline --follow --since 5m
```

If the pipeline / api task crash-loops, look for `ZodError: required … missing` in CloudWatch — one of the seeded secrets has a typo or is missing a required key.

## Security posture

- Secrets Manager encrypts at rest with an AWS-managed KMS key. To use a customer-managed key, recreate each secret under a CMK via the console or CLI. CDK doesn't own the key choice because it doesn't own the secret lifecycle.
- The pipeline / api / web task roles are each granted `secretsmanager:GetSecretValue` only on `arn:aws:secretsmanager:…:secret:dispatch/{env}/*` (`infra/lib/dispatch-stack.ts:183`, `:259`). No wildcards. The staging task role cannot read production secrets and vice versa.
- CDK imports every secret via `secretsmanager.Secret.fromSecretNameV2(...)` — the secret values never transit CloudFormation. `cdk destroy` does not delete the secrets because CDK never owned them.
- `GetSecretValue` calls are audited to CloudTrail with the invoking principal. Rotation should be performed by a dedicated deploy role, not a personal IAM user.
- Never paste a populated secret into chat, issues, or a notebook — Secrets Manager is the authoritative store. Generated values (cookie passwords, OTLP `authHeader`) should be piped directly into `create-secret` / `put-secret-value` without being written to disk.
