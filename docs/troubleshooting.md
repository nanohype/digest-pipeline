# Troubleshooting catalogue

Every concrete error DigestPipeline has surfaced during bring-up and operation, with root cause and fix. Keyed on the exact error text where possible so you (or the next operator) can grep-find the answer instead of re-diagnosing.

Sections:
- [CloudFormation / CDK deploy errors](#cloudformation--cdk-deploy-errors)
- [Build / TypeScript errors](#build--typescript-errors)
- [ECS task startup errors](#ecs-task-startup-errors)
- [Pipeline runtime errors](#pipeline-runtime-errors)
- [API runtime errors](#api-runtime-errors)
- [Web / Next.js errors](#web--nextjs-errors)
- [Bedrock errors](#bedrock-errors)
- [SES errors](#ses-errors)
- [WorkOS errors](#workos-errors)
- [Slack errors](#slack-errors)
- [Observability errors](#observability-errors)
- [Database / migration errors](#database--migration-errors)

## CloudFormation / CDK deploy errors

### `ResourceNotFoundException: Secrets Manager can't find the specified secret. (digest-pipeline/{env}/...)`

**Cause:** The secret referenced by `Secret.fromSecretNameV2(...)` doesn't exist yet. CDK resolves the ARN at deploy time via the SDK, and missing secrets fail the synth-to-CloudFormation transition.

**Fix:** Create the missing secret before retrying the deploy. See [`secrets.md`](secrets.md) § "Seeding every secret" for the full per-secret commands. `digest-pipeline/{env}/db-credentials` is the exception — CDK owns it; don't create by hand.

### `cdk deploy` stuck at `UPDATE_IN_PROGRESS` → ECS task never becomes healthy → CloudFormation rolls back after ~60 min

**Cause:** The task starts but Zod-validates its config and exits non-zero because a JSON secret has a missing or mistyped field. ECS retries on the deployment circuit breaker until CloudFormation times out.

**Fix:** Tail the task logs while the deploy is in progress (CloudWatch starts accepting records the moment the task starts, even if CFN still shows `UPDATE_IN_PROGRESS`):

```bash
aws logs tail /digest-pipeline/{env}/pipeline --follow --since 10m
# or .../api, .../web
```

Look for `ZodError: … required` or `ZodError: expected string`. `put-secret-value` the fix, then `aws ecs update-service --force-new-deployment` on the affected service — the task will re-pull the secret at container start and succeed.

### `Resource handler returned message: "DatabaseName <name> cannot be used. It is a reserved word for this engine"` on the RDS cluster

**Cause:** Aurora PostgreSQL reserves a fixed list of identifiers that cannot be used as the default database name (the list is engine-specific and grows over major versions). On Aurora PostgreSQL 16, `digest-pipeline` is reserved.

**Fix:** The stack uses `defaultDatabaseName: 'digest_pipeline'` (`infra/lib/digest-pipeline-stack.ts`). If you fork and pick a new project name, also rename the database in:
- `infra/lib/digest-pipeline-stack.ts` → `defaultDatabaseName`
- `.env.example`, `docs/local-development.md`, `README.md` → the local `DATABASE_URL` and `POSTGRES_DB` examples
- The pipeline + API resolve the database name from the secret (`secret.dbname`), so no source code change is needed when you rename the default.

### `Resource of type 'AWS::S3::Bucket' with identifier 'digest-pipeline-voice-baseline-{account}-production' already exists`

**Cause:** The voice-baseline bucket has `RemovalPolicy.RETAIN` in production. A previous failed deploy rolled back but left the bucket behind. CFN tries to create a new bucket with the same name and S3 rejects the collision (bucket names are globally unique).

**Fix:** Verify the bucket is empty or its contents are safe to keep, then either delete it or adopt it into the new stack:

```bash
# Delete path (dev/staging only — never for production voice-baseline):
aws s3 rm --recursive s3://digest-pipeline-voice-baseline-${CDK_DEFAULT_ACCOUNT}-production/
aws s3api delete-bucket --bucket digest-pipeline-voice-baseline-${CDK_DEFAULT_ACCOUNT}-production

# Adopt path (production): use CloudFormation Import to bring the existing
# bucket under the new stack's management. See AWS docs → CloudFormation
# → Import existing resources.
```

RETAIN is deliberate for `voice-baseline` — the few-shot corpus is weeks of hand-curation work. Double-check the delete path before running it on production.

### `Resource of type 'AWS::RDS::DBCluster' ... cannot be deleted because deletion protection is enabled`

**Cause:** Production Aurora has `deletionProtection: true`. `cdk destroy DigestPipelineProduction` fails before it can remove the cluster.

**Fix:** Disable deletion protection via the console/CLI, then retry `cdk destroy`:

```bash
CLUSTER_ID=$(aws rds describe-db-clusters --region us-west-2 \
  --query 'DBClusters[?DBClusterIdentifier==`digest-pipelineproduction-digest_pipeline-...`].DBClusterIdentifier' \
  --output text)
aws rds modify-db-cluster --region us-west-2 \
  --db-cluster-identifier "$CLUSTER_ID" \
  --no-deletion-protection --apply-immediately

# Wait a minute for the modify to settle, then:
cd digest-pipeline/infra && npx cdk destroy DigestPipelineProduction
```

## Build / TypeScript errors

### `npm run typecheck` fails with AWS SDK peer-dep errors but `npm run dev:pipeline` works

**Cause:** Stale `package-lock.json`. The peer-dependency graph drifted between incompatible minor versions of `@aws-sdk/*` packages — the runtime exports are intact but the type declarations conflict.

**Fix:**

```bash
rm -rf node_modules package-lock.json
npm install
npx tsc --noEmit   # should now report 0 errors
```

Commit the refreshed `package-lock.json`. The digest-pipeline CI workflow uses `npm install` (not `npm ci`) specifically because the macOS-generated lockfile omits Linux platform-conditional deps (rolldown, lightningcss, esbuild) that vitest + Next.js pull in on CI runners.

### Web build fails on Linux with `Cannot find module '@rolldown/binding-linux-x64-gnu'`

**Cause:** Same class of issue — platform-conditional optional deps. The macOS lockfile doesn't carry the Linux binary.

**Fix:** Let `npm install` resolve the platform deps instead of `npm ci`. The CI workflow already does this (`.github/workflows/digest-pipeline-ci.yml:34,62`). Locally, if you need to validate the Linux build, use `docker build -f Dockerfile.web .` rather than wrestling with the lockfile.

### `cdk deploy` fails to build a Docker asset with `npm error EUSAGE … Missing: @img/sharp-linux-x64@… from lock file` (or `@unrs/resolver-binding-*`, `@emnapi/*`)

**Cause:** Same lockfile-vs-platform mismatch that bites CI, now in the Docker build CDK runs to push the `pipeline` / `api` / `web` images. The lockfile is generated on macOS; sharp (Next.js image processing), `@unrs/resolver-binding-*` (eslint-import resolver pulled in by `eslint-config-next`), and `@emnapi/*` (Emscripten napi runtime) are platform-conditional and only get recorded for the host you ran `npm install` on. `npm ci` inside the Linux Alpine image then refuses because the lockfile has no Linux entries.

**Fix:** All three `Dockerfile.{pipeline,api,web}` use `npm install --prefer-offline --no-audit --no-fund` instead of `npm ci`. Version pinning still comes from the lockfile; the install resolves the missing platform deps on the build platform. If you regenerated `package-lock.json` and saw this error, the Dockerfile already handles it — make sure you didn't manually swap back to `npm ci`.

If you want to keep `npm ci` for stricter reproducibility, regenerate the lockfile inside a Linux container so all platforms are recorded:

```bash
docker run --rm -v "$PWD:/app" -w /app node:24-alpine \
  sh -c 'rm -rf node_modules package-lock.json && npm install --no-audit --no-fund'
```

Commit the regenerated `package-lock.json`. Reverse: same trick on macOS to repopulate the local node_modules.

### `cdk deploy` web build fails at the runtime stage with `failed to compute cache key … "/app/public": not found`

**Cause:** Next.js's standalone output treats `public/` as optional, but `Dockerfile.web`'s runtime stage `COPY --from=build /app/public ./public` requires the directory. DigestPipeline ships without static assets, so a fresh checkout has no `web/public/`.

**Fix:** `Dockerfile.web` pre-creates the directory in the build stage (`RUN mkdir -p public`), so the runtime COPY always finds an empty dir. If you add static assets to `web/public/`, the existing `COPY web/ ./` in the build stage pulls them in and the runtime layer carries them through — no Dockerfile change needed.

## ECS task startup errors

### `ResourceInitializationError: unable to retrieve secret from asm: … AccessDeniedException … is not authorized to perform: secretsmanager:GetSecretValue`

**Cause:** The **task execution role** lacks `secretsmanager:GetSecretValue` on the secret ARN, or the ARN in the policy doesn't match the resource being requested.

**Fix:** `infra/lib/digest-pipeline-stack.ts:183,259` grants `secretsmanager:GetSecretValue` on `arn:aws:secretsmanager:…:secret:digest-pipeline/{env}/*` to both the task role AND the execution role via CDK's `.grantRead()` helpers. If you see this after a manual edit, confirm the inline policy still covers the env-scoped prefix.

### `ResourceInitializationError: … ResourceNotFoundException: Secrets Manager can't find the specified secret` with a partial ARN in the error

**Cause:** The ECS task def's `valueFrom` field carries a partial ARN like `arn:aws:secretsmanager:us-west-2:…:secret:digest-pipeline/staging/runtime-config` (no 6-char random suffix). `GetSecretValue` accepts either the full suffixed ARN or just the friendly name (no `arn:…` prefix) — a partial ARN looks ARN-shaped but matches nothing, and Secrets Manager returns `ResourceNotFoundException`.

`secretsmanager.Secret.fromSecretNameV2(this, id, name)` returns an `ISecret` whose `secretArn` is the partial form. `ecs.Secret.fromSecretsManager(...)` then puts that partial ARN into the task def's `secrets:` block — and ECS dies on first task start.

**Fix (in the digest-pipeline stack):** `infra/lib/digest-pipeline-stack.ts` defines `refSecret(id, name)` which uses an `AwsCustomResource` to call `DescribeSecret` at deploy time, then imports the result via `secretsmanager.Secret.fromSecretCompleteArn(this, id, lookup.getResponseField('ARN'))`. The full suffixed ARN ends up in `valueFrom`. CDK auto-creates one `*Lookup` resource per imported secret.

**Verify the lookup resources are present:**

```bash
AWS_PROFILE=stxkxs aws cloudformation describe-stack-resources --region us-west-2 \
  --stack-name DigestPipelineStaging \
  --query "StackResources[?contains(LogicalResourceId, 'Lookup')].LogicalResourceId" \
  --output text
```

Expect one `*Lookup` per operator-seeded secret: `ApproversSecretLookup`, `WorkOsDirectorySecretLookup`, `GitHubSecretLookup`, `LinearSecretLookup`, `SlackSecretLookup`, `NotionSecretLookup`, `WebConfigSecretLookup`, `RuntimeConfigLookup`, `GrafanaCloudSecretLookup`.

If the lookup resources exist but you still hit `ResourceNotFoundException`, the underlying secret really doesn't exist in Secrets Manager — re-run `npm run seed:{env}` and re-check via `docs/secrets.md` § "Verification".

### `digest-pipeline API failed to start: ResourceNotFoundException` from inside the running container

**Cause:** Different from the ECS-startup variant above. This one fires when the **app code** (`src/common/secrets.ts` → `GetSecretValue`) is given a `SecretId` that includes Secrets Manager's 6-char random suffix as if it were part of the friendly name — e.g. `digest-pipeline/staging/approvers-mBkByn`. Secrets Manager treats that as a different secret name and returns `ResourceNotFoundException`.

The trap: for an `ISecret` returned by `secretsmanager.Secret.fromSecretCompleteArn(scope, id, completeArn)`, CDK's `.secretName` getter returns the raw post-`:secret:` portion of the ARN with the suffix still attached, because friendly names can themselves contain hyphens and CDK can't reliably strip the suffix at synth time. So `approversSecret.secretName` resolves to `digest-pipeline/staging/approvers-mBkByn` instead of `digest-pipeline/staging/approvers`.

**Fix (in the digest-pipeline stack):** for any imported secret (anything passing through `refSecret`), pass `.secretArn` to env vars instead of `.secretName`. `GetSecretValue` accepts either a friendly name OR a full ARN, so the ARN form works without app changes. CDK-owned secrets created with an explicit `secretName` (e.g. `dbSecret`) keep `.secretName` — that getter returns the literal value you passed at construction.

```typescript
// Imported (refSecret → fromSecretCompleteArn): pass ARN
WORKOS_DIRECTORY_SECRET_ID: workosDirectorySecret.secretArn,
GITHUB_SECRET_ID:           githubSecret.secretArn,

// CDK-owned with explicit secretName: pass name
DATABASE_SECRET_ID: dbSecret.secretName,
```

If you add a new secret env var to the stack, default to `.secretArn` unless the secret is created in-stack with `new secretsmanager.Secret(this, ..., { secretName: ... })`.

### `Essential container in task exited` / `exec /usr/local/bin/docker-entrypoint.sh: exec format error`

**Cause:** Docker architecture mismatch. The image was built for one architecture (typically arm64 on Apple Silicon), Fargate launched on another. ECS's task scheduler pulls the platform manifest matching the task def's `runtimePlatform.cpuArchitecture`; if the image only carries a single-arch manifest for the wrong arch, the container can't `exec` the entrypoint binary.

**Fix (already in the stack):** `infra/lib/digest-pipeline-stack.ts` pins both sides to ARM64:

- Each `FargateTaskDefinition` carries `runtimePlatform: { cpuArchitecture: ARM64, operatingSystemFamily: LINUX }` via the shared `fargateRuntimePlatform` constant.
- Each `ContainerImage.fromAsset(...)` passes `platform: ecr_assets.Platform.LINUX_ARM64` so the local Docker build emits an arm64 image (no QEMU cross-compile on Apple Silicon; on x86 builders, Docker Buildx invokes QEMU).

ARM64 was chosen because it's ~20% cheaper on Fargate (Graviton) and matches the Apple Silicon build hosts used by most contributors.

If you switch a deploy host to x86 and hit slower builds, that's expected — the build invokes QEMU under the hood. To switch the whole stack to amd64 instead: change `cpuArchitecture: ARM64` → `X86_64` and `Platform.LINUX_ARM64` → `Platform.LINUX_AMD64` in `digest-pipeline-stack.ts`. The collector sidecar image (`public.ecr.aws/aws-observability/aws-otel-collector:latest`) is a multi-arch manifest and works for either.

### `Task failed container health checks` on the API or web service — ALB target marked unhealthy

**Cause:** The health-check path isn't responding `200`. The API's `/health` is unauthenticated and should return immediately; the web's `/api/health` is likewise unauthenticated. If either is returning 5xx, the task is starting but the app is crashing inside.

**Fix:** `aws logs tail /digest-pipeline/{env}/{api,web} --follow` and look for the stack trace. Most common causes:

- API: Zod validation failure on `loadApiConfig()` at startup — a missing env or malformed `WORKOS_ISSUER` URL. The `EnvSchema` in `src/api/config.ts:10-21` throws before the server even binds, so the task dies within the first second.
- Web: WorkOS `cookiePassword` shorter than 32 chars. AuthKit hard-fails at middleware init.

## Pipeline runtime errors

### `PIPELINE_FAILURE` audit event with `Bedrock generation failed — raw skeleton draft posted`

**Cause:** `phase.generate` threw — Bedrock returned a non-JSON response, an access-denied, or a throttle. The orchestrator catches it in `src/pipeline/index.ts:104-127`, audits `PIPELINE_FAILURE`, falls back to a skeleton draft built from the ranked items, and still notifies Slack.

**Fix:** The skeleton is legible and approvable — the CoS can edit + send. Diagnose the underlying Bedrock error via `aws logs tail /digest-pipeline/{env}/pipeline` — look for the `phase.generate` span error message. If it's `AccessDeniedException`, enable model access (console) or switch to an inference-profile model ID (see [Bedrock errors](#bedrock-errors) below).

### Pipeline status `PARTIAL` with `slack.history-failed: not_in_channel`

**Cause:** The Slack bot is not a member of `announcementsChannelId` or `teamChannelId`.

**Fix:** `/invite @digest-pipeline-{env}` in the missing channel. See [`slack-app-setup.md`](slack-app-setup.md) § 4.

### Pipeline status `PARTIAL` — every source returns items but identity resolution logs `resolver.miss` for every author

**Cause:** WorkOS Directory users don't have the GitHub / Linear / Slack external-ID custom attributes populated. The resolver falls back to raw author strings; the newsletter attribution is unparsed usernames rather than display names.

**Fix:** In the WorkOS dashboard → Directory → pick each user → set the custom attributes `githubLogin`, `slackUserId`, `linearUserId`. These are standard WorkOS Directory custom-attribute fields; if your IdP doesn't push them, you can mirror them via the WorkOS API or by editing each user manually. Clear the pipeline's 4-hour resolver cache by restarting the task.

### `TimeoutError` wrapping every external call in one phase

**Cause:** A specific provider is saturated or unreachable from the VPC. `withTimeout(8_000)` (15_000 for Slack history) fires the `TimeoutError` branch, `withRetry(3, jitter)` exhausts all three attempts, and the aggregator returns an error-marked `AggregationResult`.

**Fix:** Most often a transient provider issue — the next weekly run clears it. If persistent:
- Confirm the NAT gateway is healthy (`aws ec2 describe-nat-gateways`).
- Confirm the provider's status page (GitHub, Linear, Notion, Slack).
- If only one provider is affected, temporarily remove it from the registry (`src/pipeline/entrypoint.ts`) and redeploy; the pipeline keeps running with the remaining sources and status `PARTIAL`.

### Pipeline task hangs in `RUNNING` after the app exits

**Cause:** The collector sidecar is `essential: false` on the pipeline task (`infra/lib/digest-pipeline-stack.ts:199`), so the app's exit should terminate the run. If ECS still lists the task as `RUNNING`, the collector's batch processor is flushing on shutdown and hasn't finished yet (batch `timeout: 10s` in the collector config).

**Fix:** Wait up to 30 seconds. If it persists beyond that, `aws ecs describe-tasks` and check each container's `lastStatus` + `exitCode`. A lingering collector with no app container is safe to `stop-task` manually.

## API runtime errors

### `digest-pipeline API failed to start: FastifyError: logger options only accepts a configuration object` (`FST_ERR_LOG_INVALID_LOGGER_CONFIG`)

**Cause:** Fastify v5 split the logger setup into two distinct options:
- `logger: true` or `logger: { … }` — Fastify creates its own Pino instance from the supplied config object (or defaults).
- `loggerInstance: <pinoInstance>` — Fastify uses a pre-built Pino instance directly.

Pre-v5 accepted a Pino instance via `logger`. v5 rejects that with `FST_ERR_LOG_INVALID_LOGGER_CONFIG` at boot.

**Fix (in the digest-pipeline stack):** `src/api/server.ts` uses `loggerInstance: getLogger()` so Fastify reuses the shared Pino instance from `src/common/logger.ts` (carrying the `service` field, OTel trace-context injection, and stdout transport). The return statement casts to `FastifyInstance` because `loggerInstance` types the instance with Pino's `Logger` (which has `msgPrefix`) while `FastifyInstance`'s default generic uses `FastifyBaseLogger` (which doesn't) — the two are call-compatible at runtime.

### `Invalid or expired token` (401) from `/drafts/:id/approve` (or any JWT-gated route) right after a fresh sign-in

**Cause:** The WorkOS User Management session JWT's `iss` claim is **fully qualified per-Application**, not the bare `WORKOS_ISSUER`:

```
iss = https://api.workos.com/user_management/<client_id>
```

So calling `jwtVerify(token, jwks, { issuer: 'https://api.workos.com' })` throws `JWTClaimValidationFailed: unexpected "iss" claim value`. Same applies to the `aud` claim — AuthKit User Management tokens don't populate `aud` with the client_id (they put it in a separate `client_id` claim instead), so requiring `aud === clientId` also rejects valid tokens.

**Fix (in `src/api/auth.ts`):**

```typescript
// Construct the per-Application issuer string explicitly.
const expectedIssuer = `${issuer}/user_management/${options.clientId}`;

// Verify signature + issuer only (no aud check, matches WorkOS Node SDK).
const { payload } = await jwtVerify(token, jwks, { issuer: expectedIssuer });
```

The preHandler also logs the failure with the token's `iss`/`aud`/`exp`/`sub` (no secrets) so future verification failures are diagnosable from CloudWatch directly. To inspect a failure, grep CloudWatch for `auth.verify-failed`.

Authorization (who can do what) lives in `isApprover()` against the explicit allow-list in the `approvers` secret, not in JWT claims.

### `401 Unauthorized` on every request except `/health`

**Cause:** WorkOS JWT verification is failing. Possible roots: wrong issuer, wrong `aud` claim, expired token, JWKS endpoint unreachable.

**Fix:** Hit the WorkOS JWKS endpoint directly to confirm the API can reach it from the VPC:

```bash
# From an ECS exec session on the api task:
curl -sS https://api.workos.com/.well-known/jwks.json | jq '.keys | length'
```

Expected: `>0`. If zero or unreachable, the NAT gateway is the first suspect.

Verify the `aud` claim on a real token: decode it at jwt.io, check that `aud === WORKOS_CLIENT_ID`. A mismatch means the web is signing tokens with a different Client ID than the API is validating against. Both should use the same `workosClientId` context value at `cdk deploy`.

### `ValidationError: Invalid UUID` on `GET /drafts/:id`

**Cause:** The `draftId` path parameter isn't a valid UUID. `DraftIdParamSchema` in `src/api/schemas.ts` uses `z.string().uuid()` which rejects anything else with a 400.

**Fix:** Expected for malformed URLs. If it's happening from the web, trace through the proxy routes — a bad `params.draftId` dynamic route extraction is the most likely bug.

### `403 Forbidden: not an approver` on `POST /drafts/:id/approve`

**Cause:** The caller's `sub` (WorkOS user ID) isn't in the `approvers` allow-list.

**Fix:** Add the user to `digest-pipeline/{env}/approvers`:

```bash
aws secretsmanager put-secret-value \
  --region us-west-2 --secret-id digest-pipeline/{env}/approvers \
  --secret-string '{"cosUserId":"user_01COS...","backupApproverIds":["user_01NEW..."]}'
```

The API's `SecretsClient` caches approvers with a 5-minute TTL, so the new value is picked up within 5 minutes without a redeploy or task rollover.

### `408 Request Timeout` on `POST /drafts/:id/edits` with a very long diff

**Cause:** Fastify's `requestTimeout: 30_000` (`src/api/server.ts:79`) fires if the Postgres save or the Levenshtein compute stalls past 30 seconds. In practice only happens on pathologically long drafts (>100k chars).

**Fix:** The body schema already caps `editedText` at 100k chars (`src/api/schemas.ts:28`), so well-formed clients can't trip this. If you're seeing it in production, inspect the request — a raw `curl` with a much larger body is the usual culprit.

## Web / Next.js errors

### `/review/[draftId]` bounces to `/callback?error=invalid_redirect_uri`

**Cause:** The WorkOS Client ID's registered redirect URIs don't include the web service's `/callback`.

**Fix:** In the WorkOS dashboard → Applications → pick the Client ID → **Redirects** → add `https://<domain>/callback` for each env you're deploying.

### Web console: `dangerouslySetInnerHTML called without a string`

**Cause:** DigestPipeline never uses `dangerouslySetInnerHTML` — if you see this, someone introduced it. Audit recent diffs.

**Fix:** Use text content + CSS, or an explicit sanitization layer. Shouldn't exist in this codebase.

### Live edit-rate chip flickers between values on every keystroke

**Cause:** Expected behavior — `DiffIndicator` recomputes Levenshtein on each keystroke with a sampling fallback for long strings (`web/lib/diff.ts`). The sampled version can disagree with the exact version by ~1% for drafts >10k chars.

**Fix:** Not a bug. The save-to-server debounces 2s and uses the exact algorithm, which is what's recorded as the edit-rate metric.

## Bedrock errors

### `AccessDeniedException: You don't have access to the model with the specified model ID`

**Cause:** Bedrock model access isn't enabled in the deployment region.

**Fix:** AWS console → Bedrock → Model access → Request access for `anthropic.claude-sonnet-4-6` (or whatever `BEDROCK_MODEL_ID` resolves to).

### `Invocation of model ID anthropic.claude-sonnet-4-6 with on-demand throughput isn't supported`

**Cause:** You're invoking a bare foundation-model ID (no `us.`/`eu.`/`ap.` prefix). Claude 4.x bare IDs only work with provisioned-throughput commitments. On-demand invocation requires a cross-region inference profile.

**Fix (already in the stack defaults):** the stack defaults `BEDROCK_MODEL_ID` to `us.anthropic.claude-sonnet-4-6` and grants IAM on both the profile ARN and the underlying foundation-model ARNs (cross-region):

```typescript
// infra/lib/digest-pipeline-stack.ts
bedrockModelId = 'us.anthropic.claude-sonnet-4-6',
// ...
new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['bedrock:InvokeModel'],
  resources: [
    `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*.anthropic.claude-*`,
    `arn:aws:bedrock:*::foundation-model/anthropic.claude-*`,
  ],
}),
```

If you see this error after deploy, your task picked up an older revision with a bare model ID. Force a rollover: `aws ecs update-service --force-new-deployment`.

Outside the US, override the profile prefix at deploy time: `cdk deploy ... -c bedrockModelId=eu.anthropic.claude-sonnet-4-6` (or `ap.`). The IAM policy's `*.anthropic.claude-*` wildcard covers all three prefixes.

If you have a provisioned-throughput commitment and want to skip the profile, set `BEDROCK_MODEL_ID=anthropic.claude-sonnet-4-6` (no prefix) — the IAM still allows it via the foundation-model ARN.

### `ThrottlingException` during a weekly run

**Cause:** Bedrock has per-account per-region rate limits. For a single weekly run this is rare — more likely you have another workload competing for the same model in the same region.

**Fix:** The generator wraps the invocation in `withRetry(3, jitter)`, so transient throttles usually self-clear. If it's persistent, request a quota increase via AWS Support, or switch to an inference-profile model ID (profile-level quotas are higher and regionally distributed).

## SES errors

### `AccessDenied: User '...' is not authorized to perform 'ses:SendEmail' on resource 'arn:aws:ses:...:configuration-set/<name>'`

**Cause:** SES `SendEmail` requires `ses:SendEmail` permission on **both** the verified identity AND any configuration set attached to it. If your SES account has a default configuration set (or the identity has one), every `SendEmail` call implicitly references the config set — and the IAM policy needs to allow it. Granting permission only on `identity/*` is insufficient.

**Fix (in `infra/lib/digest-pipeline-stack.ts`):** the API task role's SES policy includes both resource ARN patterns:

```typescript
new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['ses:SendEmail', 'ses:SendRawEmail'],
  resources: [
    `arn:aws:ses:${this.region}:${this.account}:identity/*`,
    `arn:aws:ses:${this.region}:${this.account}:configuration-set/*`,
  ],
}),
```

Wildcard on `configuration-set/*` covers the default and any future named ones. The fix is IAM-only — no Docker rebuild required.

### `MessageRejected: Email address is not verified`

**Cause:** SES is in sandbox mode in the deployment region AND either `sesFromAddress` or one of the recipients isn't a verified identity.

**Fix:** Verify the sending identity (or its parent domain) in the SES console. Request production access (AWS Support → "Request production access for SES") so recipient addresses don't need per-address verification. During bring-up in sandbox, verify each recipient manually.

### `InvalidParameterValue: Illegal address`

**Cause:** A comma in `newsletterRecipients` has extra whitespace or a malformed address slipped through.

**Fix:** `runtime-config.newsletterRecipients` is parsed by the API; normalize via:

```bash
aws secretsmanager put-secret-value \
  --region us-west-2 --secret-id digest-pipeline/{env}/runtime-config \
  --secret-string '{
    "slackReviewChannelId": "C00...",
    "sesFromAddress":       "digest-pipeline@yourco.com",
    "newsletterRecipients": "exec-list@yourco.com,staff@yourco.com"
  }'
```

Comma-separated, no surrounding whitespace.

## WorkOS errors

### Directory Sync returns zero users

**Cause:** The WorkOS directory isn't connected to your IdP yet, or the `directoryId` in `digest-pipeline/{env}/workos-directory` is wrong.

**Fix:** In the WorkOS dashboard → Directory Sync → confirm the directory is in the `linked` state with >0 users. Re-seed `digest-pipeline/{env}/workos-directory` with the correct `directoryId` if needed.

### Web logs show `[AuthKit callback error] Error: OAuth state mismatch` or `Auth cookie missing — cannot verify OAuth state`

**Cause:** Two `Set-Cookie: wos-auth-verifier=...` headers in the same response (visible via `curl -i https://<host>/api/auth/sign-in`). Browsers collapse duplicate cookie names to a single value (usually the last one wins, sometimes the first), so the value AuthKit stored isn't the one sent back on `/callback`.

The duplicate happens when the session-refresh middleware (`authkitMiddleware()`) runs on the `/api/auth/sign-in` route and writes a session-refresh cookie alongside the PKCE/state cookie that `getSignInUrl()` is writing in the route handler. Same cookie name, different values, single response.

**Fix (in the digest-pipeline web):** the middleware matcher in `web/middleware.ts` excludes `/api/auth/*`. Auth route handlers own their cookie surface; the session-refresh middleware should never touch them.

```typescript
// web/middleware.ts
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|callback|api/health|api/auth).*)'],
};
```

After fix, `curl -i https://<host>/api/auth/sign-in` should show exactly one `Set-Cookie: wos-auth-verifier=...` header.

### After successful sign-in, browser shows `DNS_PROBE_FINISHED_NXDOMAIN` for `ip-10-0-X-Y.us-west-2.compute.internal`

**Cause:** AuthKit's `handleAuth()` (in `app/callback/route.ts`) constructs the post-sign-in redirect from `request.url` when no `baseURL` option is passed. Behind an ALB on Fargate, Next.js's `request.url` sometimes resolves the host to the container's internal VPC DNS name (`ip-10-0-X-Y.us-west-2.compute.internal`) instead of the public hostname the browser used. The 302 sends the browser to the internal name, which obviously isn't publicly resolvable.

**Fix (in the digest-pipeline web):** `app/callback/route.ts` derives `baseURL` from `WORKOS_REDIRECT_URI` (already set on the container as the public callback URL) and passes it to `handleAuth({ baseURL })`. Once set, AuthKit uses it as the redirect base instead of `request.url`.

```typescript
// app/callback/route.ts
const REDIRECT_URI = process.env.WORKOS_REDIRECT_URI;
const BASE_URL = REDIRECT_URI ? new URL(REDIRECT_URI).origin : undefined;
export const GET = handleAuth({ baseURL: BASE_URL });
```

The route handler is Node runtime (not Edge), so `process.env.WORKOS_REDIRECT_URI` reads at request time work fine — no build-arg needed for this one.

### `getSignInUrl()` returns a URL with `redirect_uri=` empty; AuthKit lands on its hosted page with no return target and the sign-in flow loops or 500s

**Cause:** AuthKit-nextjs reads the callback URI from `NEXT_PUBLIC_WORKOS_REDIRECT_URI`, **not** `WORKOS_REDIRECT_URI`. The package's source is unambiguous:

```js
// authkit-nextjs/dist/esm/env-variables.js
const WORKOS_REDIRECT_URI = process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI ?? '';
```

The `NEXT_PUBLIC_` prefix is required because Next.js inlines values with that prefix at build time (and exposes them to client-side code). Setting `WORKOS_REDIRECT_URI` (without the prefix) leaves AuthKit reading `''`, so:
- `getSignInUrl()` emits `redirect_uri=` empty
- `authkitMiddleware()` defaults to constructing one from `request.url`
- `handleAuth()` falls back to `request.url` for the post-sign-in redirect
- Cookie security flags are computed against an empty URL → defaults that may be wrong

**Fix (in the digest-pipeline stack):** every reference uses the `NEXT_PUBLIC_` name:

- `Dockerfile.web` — `ARG NEXT_PUBLIC_WORKOS_REDIRECT_URI` + `ENV NEXT_PUBLIC_WORKOS_REDIRECT_URI=...` before `npm run build`.
- `infra/lib/digest-pipeline-stack.ts` — `buildArgs: { NEXT_PUBLIC_WORKOS_REDIRECT_URI: ... }` on the web's `ContainerImage.fromAsset(...)`, and `NEXT_PUBLIC_WORKOS_REDIRECT_URI` as the runtime ECS secret env name (defense-in-depth, though the build-arg is the load-bearing source).
- `web/middleware.ts` and `web/app/callback/route.ts` read `process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI` directly.

Verify after deploy:

```bash
curl -sS -i https://<host>/api/auth/sign-in 2>&1 | grep -i '^location' | grep -oE 'redirect_uri=[^&]*'
# Expect: redirect_uri=https%3A%2F%2F<host>%2Fcallback
# NOT:    redirect_uri=  (empty)
```

### Web logs show `Error: Cookies can only be modified in a Server Action or Route Handler`; React shows `An error occurred in the Server Components render`

**Cause:** AuthKit's `withAuth()` and `getSignInUrl()` both want to mutate cookies — the first refreshes an expiring session token, the second sets a PKCE verifier. Next.js App Router only allows cookie mutations from Route Handlers (`app/.../route.ts`) and Server Actions, never from Server Components. Calling either from a server component (e.g. an `async function HomePage()`) throws.

**Fix (in the digest-pipeline web):** keep the page server component pure (no auth-mutating calls), and route auth through:
- `app/api/auth/sign-in/route.ts` — calls `getSignInUrl()` then `redirect()` (PKCE cookie set in the route handler).
- `app/api/auth/sign-out/route.ts` — calls AuthKit's `signOut()`.
- `app/api/auth/me/route.ts` — wraps `withAuth()` and returns `{ user: { email, id } | null }`. Try/catches the AuthKit refresh error so a logged-out visitor doesn't 500 the call.
- `components/AuthStatus.tsx` — client component that fetches `/api/auth/me` from a `useEffect` and renders the appropriate header link.

The page server component just imports `<AuthStatus />` and renders.

### `Internal Server Error` on every page; web logs show `Error: You must provide a redirect URI in the AuthKit middleware or in the environment variables`

**Cause:** AuthKit's `authkitMiddleware()` reads `process.env.WORKOS_REDIRECT_URI` at **module-load time**, not at request time. Next.js bundles the middleware for the Edge runtime via static analysis — `process.env.X` references are resolved at `next build` time, not at runtime in the running container. Setting `WORKOS_REDIRECT_URI` as a runtime ECS secret makes it visible to Node code at request time, but AuthKit has already thrown by then.

**Fix (in the digest-pipeline stack):** `Dockerfile.web` accepts `WORKOS_REDIRECT_URI` as a Docker build arg and exports it as `ENV` before `npm run build`, so the value is present when Next.js bundles the middleware. CDK passes it from the deploy-time `domainName`:

```typescript
// infra/lib/digest-pipeline-stack.ts
image: ecs.ContainerImage.fromAsset('../', {
  file: 'Dockerfile.web',
  buildArgs: { WORKOS_REDIRECT_URI: `https://${domainName}/callback` },
});
```

The redirect URI is a public OAuth callback (the WorkOS dashboard literally exposes it to anyone with read access on the application), so baking it into the image is fine. The other AuthKit values (`workosApiKey`, `workosClientId`, `cookiePassword`) stay as runtime secrets — those are read inside request handlers via `getEnvVariable`, not at module load, so runtime injection works for them.

If you fork digest-pipeline and the redirect URI ever needs to differ between environments, vary `domainName` per stack (already the case for staging vs production) and the build arg follows.

### AuthKit callback: `invalid_client`

**Cause:** `web-config.workosApiKey` doesn't match the Client ID. The WorkOS SDK derives the API key from the secret you provide, and AuthKit cross-checks it against the Client ID during the token exchange.

**Fix:** Re-seed `digest-pipeline/{env}/web-config` with the matching `{workosApiKey, workosClientId}` pair from the same WorkOS application.

## Slack errors

### `slack.notify-failed: channel_not_found`

**Cause:** `runtime-config.slackReviewChannelId` is wrong, or the bot isn't a member of the channel (Slack's `channel_not_found` response collapses both cases).

**Fix:** Copy the channel ID directly from the Slack UI (right-click → View channel details). Re-run `/invite @digest-pipeline-{env}` in the channel.

### `slack.notify-failed: not_in_channel`

**Cause:** The bot isn't a member.

**Fix:** `/invite @digest-pipeline-{env}` in the review channel.

### Aggregator reads every channel but returns zero items

**Cause:** Two possible roots — (a) the 7-day window genuinely has no messages ≥20 chars and ≤2000 chars, or (b) every message was written by a user ID in `hrBotUserIds`.

**Fix:** Inspect recent history directly via `curl`. If the channel truly has low activity, the filter is working as intended; raising `MIN_ANNOUNCEMENT_LENGTH` in `src/pipeline/aggregators/slack.ts:15` trades more noise for more items.

## Observability errors

### Traces missing from Grafana Cloud Tempo

**Cause:** ADOT collector authentication failing against `otlpEndpoint`.

**Fix:** Check the collector container log for each task:

```bash
aws logs tail /digest-pipeline/{env}/otel-collector-pipeline --follow
aws logs tail /digest-pipeline/{env}/otel-collector-api --follow
aws logs tail /digest-pipeline/{env}/otel-collector-web --follow
```

Common errors:
- `401 Unauthorized` — `authHeader` is malformed. Verify it's `Basic ` + base64 of `instanceId:apiToken` with no trailing newline.
- `404 Not Found` — wrong region in `otlpEndpoint` (e.g. `prod-us-west-0` when your stack is `prod-us-east-0`).
- `403 Forbidden` — the Cloud Access Policy doesn't include `metrics:write` + `traces:write`.

### Logs not in Grafana

**Cause:** DigestPipeline does NOT ship logs through OTel. Logs go directly from stdout → ECS awslogs driver → CloudWatch.

**Fix:** Add CloudWatch as a Grafana data source (one-time UI step: Grafana → Connections → Data sources → Add new → CloudWatch). Logs become queryable in Grafana; `trace_id` is present on every line, so the Tempo ↔ CloudWatch join is one click.

### Pino records missing `trace_id` / `span_id` fields

**Cause:** The Pino log call is happening outside an active OTel span.

**Fix:** Wrap the logging call in a span, or accept that records outside spans won't carry trace context. `@opentelemetry/instrumentation-pino` auto-injects these when a span is active; no trace context in the call means no fields.

### `OTEL_SDK_DISABLED=true` left set in production by accident → every metric + trace is dropped

**Cause:** The env var was set during local testing and slipped into a deployed task def.

**Fix:** Search the CDK stack and every `.env*` file for `OTEL_SDK_DISABLED`. It should be absent in production; only tests and local runs set it. Redeploy with it unset.

## Database / migration errors

### `npm run migrate:up` fails with `connect ECONNREFUSED 127.0.0.1:5432`

**Cause:** No local Postgres running, or the port is blocked.

**Fix:** See [`local-development.md`](local-development.md) § "Starting Postgres locally". Quick version:

```bash
docker run -d --name digest-pipeline-pg -p 5432:5432 \
  -e POSTGRES_USER=digest_pipeline_app \
  -e POSTGRES_PASSWORD=digest_pipeline_app \
  -e POSTGRES_DB=digest_pipeline postgres:16
```

### `npm run migrate:up` succeeds but `SELECT * FROM drafts` returns `relation "drafts" does not exist`

**Cause:** `DATABASE_URL` points at a different database than the migrations ran against.

**Fix:** Compare the `DATABASE_URL` you ran `migrate:up` with against the one the pipeline/api is using. A common mistake: running migrations against `postgres://localhost/postgres` (default DB) instead of the `digest-pipeline` database.

### Aurora connection throttled with `too many clients already`

**Cause:** Aurora Serverless v2 at 0.5 ACU caps active connections aggressively. If the pipeline task and API tasks open connections simultaneously during a scheduled run, you can transiently exceed the pool.

**Fix:** `src/data/pool.ts` creates a single `pg.Pool` per task with default sizing (10 connections). If you see persistent throttling, raise the pool's `max` or scale up Aurora's min ACU to 1.
