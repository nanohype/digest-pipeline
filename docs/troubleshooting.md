# Troubleshooting catalogue

Every concrete error DigestPipeline has surfaced during bring-up and operation, with root cause and fix. Keyed on the exact error text where possible so you (or the next operator) can grep-find the answer instead of re-diagnosing.

Sections:
- [ArgoCD sync / Platform-CR reconcile errors](#argocd-sync--platform-cr-reconcile-errors)
- [Build / TypeScript errors](#build--typescript-errors)
- [Pod startup errors](#pod-startup-errors)
- [Pipeline runtime errors](#pipeline-runtime-errors)
- [API runtime errors](#api-runtime-errors)
- [Web / Next.js errors](#web--nextjs-errors)
- [Bedrock errors](#bedrock-errors)
- [SES errors](#ses-errors)
- [WorkOS errors](#workos-errors)
- [Slack errors](#slack-errors)
- [Observability errors](#observability-errors)
- [Database / migration errors](#database--migration-errors)

## ArgoCD sync / Platform-CR reconcile errors

All commands below assume the workload namespace `tenants-digest-pipeline` (the Platform reconciler owns it; the chart renders the three workloads into it). The `Platform` and `BudgetPolicy` CRs themselves live in the growth team's management namespace `tenants-growth`.

### ArgoCD shows the Application `OutOfSync` / `SyncFailed` with `secret "digest-pipeline" not found` on a pod

**Cause:** The `ExternalSecret` hasn't materialised the in-cluster Secret yet, so the pods that consume it via `envFrom` can't start. The secret referenced in `chart/templates/externalsecret.yaml` points at `digest-pipeline/{env}/*` entries that don't exist in AWS Secrets Manager, or the external-secrets operator can't read them (its own cluster-level AWS identity is misconfigured).

**Fix:** Create the missing AWS secrets first — see [`secrets.md`](secrets.md) § "Seed all secrets in one shot" for the full per-secret commands (`digest-pipeline/{env}/db-credentials` is the exception — the landing-zone `tenant-substrate` rds-aurora module owns it; don't create by hand). Then force a resync of the ExternalSecret and confirm the Secret lands:

```bash
kubectl -n tenants-digest-pipeline annotate externalsecret digest-pipeline \
  force-sync="$(date +%s)" --overwrite
kubectl -n tenants-digest-pipeline get externalsecret digest-pipeline \
  -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}'
# Expect: True
kubectl -n tenants-digest-pipeline get secret digest-pipeline
```

### Pods crash-loop on a config field; ArgoCD stays `Progressing` and never reaches `Healthy`

**Cause:** A pod starts but Zod-validates its config and exits non-zero because a JSON secret has a missing or mistyped field. The Deployment never reaches its ready replica count; the CronJob's Job fails and backs off.

**Fix:** Read the pod logs in the tenant namespace (Loki carries the same stream — `{service="digest-pipeline-pipeline"}` / `digest-pipeline-api` / `digest-pipeline-web`):

```bash
kubectl -n tenants-digest-pipeline logs deploy/digest-pipeline-api --tail=100
# or: deploy/digest-pipeline-web, job/<the failed pipeline job>
```

Look for `ZodError: … required` or `ZodError: expected string`. `put-secret-value` the fix, re-sync the ExternalSecret (above), then `kubectl -n tenants-digest-pipeline rollout restart deploy/digest-pipeline-api` (and `deploy/digest-pipeline-web`) so the pods re-read the refreshed Secret at container start.

### `DatabaseName <name> cannot be used. It is a reserved word for this engine` from the landing-zone Aurora apply

**Cause:** Aurora PostgreSQL reserves a fixed list of identifiers that cannot be used as the default database name (the list is engine-specific and grows over major versions). On Aurora PostgreSQL 16, `digest-pipeline` is reserved.

**Fix:** The landing-zone `tenant-substrate` component provisions the database as `digest_pipeline` (underscore, not reserved). The cluster Aurora is owned there, not in this repo. If you fork and pick a new project name, rename the database in:
- landing-zone `components/aws/tenant-substrate/` → the rds-aurora module's `database_name`
- `.env.example`, `docs/local-development.md`, `README.md` → the local `DATABASE_URL` and `POSTGRES_DB` examples
- The pipeline + API resolve the database name from `DATABASE_URL` (composed by the chart's ExternalSecret from the `db-credentials` secret), so no source code change is needed when you rename the default.

### Platform CR stuck — Namespace `tenants-digest-pipeline` / ResourceQuota / AppProject never appears

**Cause:** The `eks-agent-platform` operator hasn't reconciled the Platform CR (`platform.yaml`), so none of the tenant-boundary objects the chart depends on exist yet. The ApplicationSet entry has `CreateNamespace=false` on purpose — the Platform reconciler owns the Namespace — so the chart sync blocks until the operator gets there first.

**Fix:** Confirm the Platform (and its required BudgetPolicy) reconciled cleanly, then re-sync the Application:

```bash
kubectl -n tenants-growth get platform digest-pipeline \
  -o jsonpath='{.status.phase}'        # Expect: Ready
kubectl -n tenants-growth get budgetpolicy digest-pipeline
kubectl get ns tenants-digest-pipeline resourcequota -n tenants-digest-pipeline
kubectl -n tenants-growth describe platform digest-pipeline  # for reconcile errors
```

If the operator reports an error reconciling the IAM role or AppProject, fix it at the operator/landing-zone layer first — the chart's pods can't schedule into a quota-less namespace.

### ApplicationSet didn't generate an Application for this cluster

**Cause:** The matrix generator in `gitops/applicationset-entry.yaml` (clusters × `[digest-pipeline]`) only emits an Application for clusters the cluster generator selects. If the target cluster isn't labelled into the generator's selector, no Application is produced.

**Fix:** Confirm the generated Application exists and check the ApplicationSet controller's view:

```bash
kubectl -n argocd get applications.argoproj.io | grep digest-pipeline
kubectl -n argocd describe applicationset apps-tenants | tail -40
```

If the Application is missing, the cluster label/selector mismatch is the first suspect; the entry syncs at wave 100, so it also won't appear until earlier waves on that cluster settle.

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

### Image build fails with `npm error EUSAGE … Missing: @img/sharp-linux-x64@… from lock file` (or `@emnapi/*`)

**Cause:** Same lockfile-vs-platform mismatch that bites CI, now in the `docker build` that `release.yml` runs to push the `pipeline` / `api` / `web` images to `ghcr.io/nanohype/digest-pipeline`. The lockfile is generated on macOS; sharp (Next.js image processing) and its `@emnapi/*` (Emscripten napi runtime) transitives are platform-conditional and only get recorded for the host you ran `npm install` on. `npm ci` inside the Linux Alpine image then refuses because the lockfile has no Linux entries.

**Fix:** All three `Dockerfile.{pipeline,api,web}` use `npm install --prefer-offline --no-audit --no-fund` instead of `npm ci`. Version pinning still comes from the lockfile; the install resolves the missing platform deps on the build platform. If you regenerated `package-lock.json` and saw this error, the Dockerfile already handles it — make sure you didn't manually swap back to `npm ci`.

If you want to keep `npm ci` for stricter reproducibility, regenerate the lockfile inside a Linux container so all platforms are recorded:

```bash
docker run --rm -v "$PWD:/app" -w /app node:24-alpine \
  sh -c 'rm -rf node_modules package-lock.json && npm install --no-audit --no-fund'
```

Commit the regenerated `package-lock.json`. Reverse: same trick on macOS to repopulate the local node_modules.

### Web image build fails at the runtime stage with `failed to compute cache key … "/app/public": not found`

**Cause:** Next.js's standalone output treats `public/` as optional, but `Dockerfile.web`'s runtime stage `COPY --from=build /app/public ./public` requires the directory. DigestPipeline ships without static assets, so a fresh checkout has no `web/public/`.

**Fix:** `Dockerfile.web` pre-creates the directory in the build stage (`RUN mkdir -p public`), so the runtime COPY always finds an empty dir. If you add static assets to `web/public/`, the existing `COPY web/ ./` in the build stage pulls them in and the runtime layer carries them through — no Dockerfile change needed.

## Pod startup errors

### Pod `CrashLoopBackOff` with `AccessDeniedException … is not authorized to perform: secretsmanager:GetSecretValue`

**Cause:** The app code (`src/common/secrets.ts` → `GetSecretValue`) ran but the pod's IAM role lacks `secretsmanager:GetSecretValue` on the requested ARN, or the ARN prefix doesn't match. The pods run as the operator-owned `tenant-runtime` ServiceAccount bound to `<env>-digest-pipeline-tenant`; the Secrets Manager grant reaches that role through the operator-generated tenant policy, scoped to `arn:aws:secretsmanager:…:secret:digest-pipeline/{env}/*`.

**Fix:** Start at the Pod Identity association — the ServiceAccount carries no role annotation by design, so the binding is only visible on the AWS side:

```bash
aws eks list-pod-identity-associations --cluster-name <cluster> \
  --namespace tenants-digest-pipeline --service-account digest-pipeline
```

No association means the operator hasn't reconciled the Platform to `Ready` yet — check `Platform.status.phase` and the operator logs; the operator creates the `(namespace, tenant-runtime)` association once the tenant role is minted. If the association is present but a grant is missing, confirm the store is declared in `spec.datastores` (the operator generates datastore-access from it) and, for SES, that `spec.identity.capabilities` includes `ses`.

### Pod stuck `ContainerCreating` / `CreateContainerConfigError`: `secret "digest-pipeline" not found`

**Cause:** The pods consume the in-cluster Secret via `envFrom`, but the `ExternalSecret` hasn't synced it yet (the AWS secret is missing, or external-secrets can't read it). The kubelet can't create the container without the referenced Secret.

**Fix:** Force the ExternalSecret to resync and confirm the Secret materialises (see [ArgoCD sync / Platform-CR reconcile errors](#argocd-sync--platform-cr-reconcile-errors) above for the full sequence):

```bash
kubectl -n tenants-digest-pipeline annotate externalsecret digest-pipeline \
  force-sync="$(date +%s)" --overwrite
kubectl -n tenants-digest-pipeline get secret digest-pipeline
```

If the Secret still doesn't appear, the underlying AWS secret really doesn't exist — re-run `npm run seed:{env}` and re-check via `docs/secrets.md` § "Verification".

### Pod `ImagePullBackOff` / `ErrImagePull` on a pipeline / api / web pod

**Cause:** The image tag the chart references doesn't exist in `ghcr.io/nanohype/digest-pipeline`, or the node can't pull it. `release.yml` builds and pushes all three images by tag; the chart resolves them at pull time.

**Fix:** Describe the pod to see the exact pull error, then confirm the tag exists:

```bash
kubectl -n tenants-digest-pipeline describe pod <pod> | sed -n '/Events:/,$p'
```

If the tag is missing, the image build/push hasn't completed for this revision — check the `release.yml` run. Image resolution is by tag, so multi-arch falls out of the build matrix; there's no per-platform pin to mismatch.

### API / web pod fails its readiness probe and never becomes `Ready`

**Cause:** The probe path isn't returning `200`. The API's `/health` is unauthenticated and should return immediately; the web's `/api/health` is likewise unauthenticated. If either returns 5xx, the pod is starting but the app is crashing inside, so the Deployment never reaches its ready replica count and the ALB target group keeps the pod out of rotation.

**Fix:** `kubectl -n tenants-digest-pipeline logs deploy/digest-pipeline-api --tail=100` (or `deploy/digest-pipeline-web`) — or query Loki for `{service="digest-pipeline-api"}` — and look for the stack trace. Most common causes:

- API: Zod validation failure on `loadApiConfig()` at startup — a missing env or malformed `WORKOS_ISSUER` URL. The `EnvSchema` in `src/api/config.ts:10-21` throws before the server even binds, so the pod dies within the first second.
- Web: WorkOS `cookiePassword` shorter than 32 chars. AuthKit hard-fails at middleware init.

## Pipeline runtime errors

### `PIPELINE_FAILURE` audit event with `Bedrock generation failed — raw skeleton draft posted`

**Cause:** `phase.generate` threw — Bedrock returned a non-JSON response, an access-denied, or a throttle. The orchestrator catches it in `src/pipeline/index.ts:104-127`, audits `PIPELINE_FAILURE`, falls back to a skeleton draft built from the ranked items, and still notifies Slack.

**Fix:** The skeleton is legible and approvable — the CoS can edit + send. Diagnose the underlying Bedrock error from the pipeline Job's logs (`kubectl -n tenants-digest-pipeline logs job/<the pipeline job>`, or query Loki for `{service="digest-pipeline-pipeline"}`) — look for the `phase.generate` span error message. If it's `AccessDeniedException`, enable model access (console) or switch to an inference-profile model ID (see [Bedrock errors](#bedrock-errors) below).

### Pipeline status `PARTIAL` with `slack.history-failed: not_in_channel`

**Cause:** The Slack bot is not a member of `announcementsChannelId` or `teamChannelId`.

**Fix:** `/invite @digest-pipeline-{env}` in the missing channel. See [`slack-app-setup.md`](slack-app-setup.md) § 4.

### Pipeline status `PARTIAL` — every source returns items but identity resolution logs `resolver.miss` for every author

**Cause:** WorkOS Directory users don't have the GitHub / Linear / Slack external-ID custom attributes populated. The resolver falls back to raw author strings; the newsletter attribution is unparsed usernames rather than display names.

**Fix:** In the WorkOS dashboard → Directory → pick each user → set the custom attributes `githubLogin`, `slackUserId`, `linearUserId`. These are standard WorkOS Directory custom-attribute fields; if your IdP doesn't push them, you can mirror them via the WorkOS API or by editing each user manually. The resolver's 4-hour cache is per-process — the next weekly CronJob run starts a fresh pod and picks up the new attributes; to force an immediate refresh, trigger an ad-hoc run (`kubectl -n tenants-digest-pipeline create job --from=cronjob/digest-pipeline digest-pipeline-manual`).

### `TimeoutError` wrapping every external call in one phase

**Cause:** A specific provider is saturated or unreachable from the cluster's egress path. `withTimeout(8_000)` (15_000 for Slack history) fires the `TimeoutError` branch, `withRetry(3, jitter)` exhausts all three attempts, and the aggregator returns an error-marked `AggregationResult`.

**Fix:** Most often a transient provider issue — the next weekly run clears it. If persistent:
- Confirm the pod's egress isn't being dropped — the chart's `networkpolicy.yaml` allows DNS + HTTPS egress; an over-tight cluster default-deny or a NAT/egress-gateway outage on the node's path is the first suspect (`kubectl -n tenants-digest-pipeline describe networkpolicy`).
- Confirm the provider's status page (GitHub, Linear, Notion, Slack).
- If only one provider is affected, temporarily remove it from the registry (`src/pipeline/entrypoint.ts`), rebuild the image, and let the next sync roll it out; the pipeline keeps running with the remaining sources and status `PARTIAL`.

### Pipeline Job stays `Active` after the app exits

**Cause:** The pipeline runs as a single-container Job — no sidecars — so when the orchestrator process exits, the container exits and the Job should complete (`concurrencyPolicy: Forbid`, 30-min `activeDeadlineSeconds`). If the Job still shows as `Active`, the container is in its terminationGracePeriod while the OTel SDK flushes its last batch to the cluster collector on shutdown.

**Fix:** Wait a few seconds. If it persists, inspect the Job's pod:

```bash
kubectl -n tenants-digest-pipeline get jobs -l app.kubernetes.io/component=pipeline
kubectl -n tenants-digest-pipeline describe pod <the job's pod>   # check container State + exit code
```

A pod past its `activeDeadlineSeconds` is reaped by the Job controller automatically; you can `kubectl delete pod` it manually if needed.

## API runtime errors

### `digest-pipeline API failed to start: FastifyError: logger options only accepts a configuration object` (`FST_ERR_LOG_INVALID_LOGGER_CONFIG`)

**Cause:** Fastify v5 split the logger setup into two distinct options:
- `logger: true` or `logger: { … }` — Fastify creates its own Pino instance from the supplied config object (or defaults).
- `loggerInstance: <pinoInstance>` — Fastify uses a pre-built Pino instance directly.

Pre-v5 accepted a Pino instance via `logger`. v5 rejects that with `FST_ERR_LOG_INVALID_LOGGER_CONFIG` at boot.

**Fix (in `src/api/server.ts`):** the server uses `loggerInstance: getLogger()` so Fastify reuses the shared Pino instance from `src/common/logger.ts` (carrying the `service` field, OTel trace-context injection, and stdout transport). The return statement casts to `FastifyInstance` because `loggerInstance` types the instance with Pino's `Logger` (which has `msgPrefix`) while `FastifyInstance`'s default generic uses `FastifyBaseLogger` (which doesn't) — the two are call-compatible at runtime.

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

The preHandler also logs the failure with the token's `iss`/`aud`/`exp`/`sub` (no secrets) so future verification failures are diagnosable from the logs directly. To inspect a failure, query Loki for `{service="digest-pipeline-api"} |= "auth.verify-failed"` (or `kubectl -n tenants-digest-pipeline logs deploy/digest-pipeline-api | grep auth.verify-failed`).

Authorization (who can do what) lives in `isApprover()` against the explicit allow-list in the `approvers` secret, not in JWT claims.

### `401 Unauthorized` on every request except `/health`

**Cause:** WorkOS JWT verification is failing. Possible roots: wrong issuer, wrong `aud` claim, expired token, JWKS endpoint unreachable.

**Fix:** Hit the WorkOS JWKS endpoint directly from inside the api pod to confirm cluster egress can reach it:

```bash
# From an exec session on the api pod:
kubectl -n tenants-digest-pipeline exec deploy/digest-pipeline-api -- \
  sh -c 'curl -sS https://api.workos.com/.well-known/jwks.json' | jq '.keys | length'
```

Expected: `>0`. If zero or unreachable, the pod's HTTPS egress is the first suspect — check the chart's `networkpolicy.yaml` and the node's egress path.

Verify the `aud` claim on a real token: decode it at jwt.io, check that `aud === WORKOS_CLIENT_ID`. A mismatch means the web is signing tokens with a different Client ID than the API is validating against. Both should resolve the same `workosClientId` from the `web-config` / `runtime-config` secret synced into the cluster.

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

**Fix:** AWS console → Bedrock → Model access → Request access for `anthropic.claude-sonnet-5` (or whatever the `ModelGateway` route resolves to). The gateway makes the call, so the grant it needs is on the tenant role the gateway runs as.

### `Invocation of model ID anthropic.claude-sonnet-5 with on-demand throughput isn't supported`

**Cause:** You're invoking a bare foundation-model ID (no geo prefix). Bedrock reports `inferenceTypesSupported: [INFERENCE_PROFILE]` for the whole current Claude family, so there is no on-demand path and no provisioned-throughput path — a cross-region inference profile is the only way to invoke these models.

**Fix (already in the defaults):** the `ModelGateway` route resolves to `us.anthropic.claude-sonnet-5`, and `platform.yaml` lists the bare ID in `spec.identity.allowedModels`. The operator expands a bare entry into both the foundation-model ARN and the `us.` inference-profile ARN, and writes them into the tenant role's `bedrock-model-scoping` inline policy:

```jsonc
// <env>-digest-pipeline-tenant, bedrock-model-scoping (resources for bedrock:InvokeModel)
[
  "arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-5*",
  "arn:aws:bedrock:<region>:<account>:inference-profile/us.anthropic.claude-sonnet-5*"
]
```

If you see this error after a sync, the pods picked up an older revision with a bare model ID. Force a fresh roll: `kubectl -n tenants-digest-pipeline rollout restart deploy/digest-pipeline-api` (and re-run the pipeline CronJob).

Outside the US, override the profile prefix on the `ModelGateway` route: `crossRegionProfile: eu.anthropic.claude-sonnet-5` (or `global.` in Asia Pacific). The scoping policy is generated from `spec.identity.allowedModels`, so add the same geo-prefixed ID there too — a bare entry only implies the `us.` profile.

There is no way to skip the profile for this model: the bare foundation-model ARN stays in the IAM grant (the operator emits both), but `InvokeModel` on the bare ID is refused regardless of the policy, because the model has no non-profile inference type.

### `ThrottlingException` during a weekly run

**Cause:** Bedrock has per-account per-region rate limits. For a single weekly run this is rare — more likely you have another workload competing for the same model in the same region.

**Fix:** The generator wraps the invocation in `withRetry(3, jitter)`, so transient throttles usually self-clear. If it's persistent, request a quota increase via AWS Support, or switch to an inference-profile model ID (profile-level quotas are higher and regionally distributed).

## SES errors

### `AccessDenied: User '...' is not authorized to perform 'ses:SendEmail' on resource 'arn:aws:ses:...:configuration-set/<name>'`

**Cause:** SES send is granted by the operator-generated capability-access policy from the `ses` capability. It allows `ses:SendEmail` / `ses:SendRawEmail` on Resource `*`, scoped by a `ses:FromAddress` condition to the tenant's sending domain — so the grant covers both the identity and any configuration set. An `AccessDenied` here means either the `ses` capability isn't declared, or the from-address doesn't match the tenant's domain pattern.

**Fix:** confirm `spec.identity.capabilities` includes `ses`, and that `sesFromAddress` sends from the tenant's own sending domain. The generated statement is:

```jsonc
// capability-access (ses:SendEmail / ses:SendRawEmail), Resource "*"
// Condition: StringLike { "ses:FromAddress": "*@digest-pipeline.*" }
[
  "arn:aws:ses:<region>:<account>:identity/*",
  "arn:aws:ses:<region>:<account>:configuration-set/*"
]
```

Wildcard on `configuration-set/*` covers the default and any future named ones. The fix is IAM-only (landing-zone) — no image rebuild required.

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

### After successful sign-in, browser shows `DNS_PROBE_FINISHED_NXDOMAIN` for an internal pod hostname

**Cause:** AuthKit's `handleAuth()` (in `app/callback/route.ts`) constructs the post-sign-in redirect from `request.url` when no `baseURL` option is passed. Behind a reverse-proxy ingress controller, Next.js's `request.url` sometimes resolves the host to the pod's in-cluster identity (the pod IP or the Service's `.svc.cluster.local` name) instead of the public hostname the browser used. The 302 sends the browser to the internal name, which obviously isn't publicly resolvable.

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

**Fix (in the digest-pipeline web):** every reference uses the `NEXT_PUBLIC_` name:

- `Dockerfile.web` — `ARG NEXT_PUBLIC_WORKOS_REDIRECT_URI` + `ENV NEXT_PUBLIC_WORKOS_REDIRECT_URI=...` before `npm run build`.
- `release.yml` passes `NEXT_PUBLIC_WORKOS_REDIRECT_URI` as a build arg to the web image build (the load-bearing source, since the value is baked at build time), and the chart also sets `NEXT_PUBLIC_WORKOS_REDIRECT_URI` as a runtime env on the web Deployment for defense-in-depth.
- `web/middleware.ts` and `web/app/callback/route.ts` read `process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI` directly.

Verify against a running web pod:

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

**Cause:** AuthKit's `authkitMiddleware()` reads `process.env.WORKOS_REDIRECT_URI` at **module-load time**, not at request time. Next.js bundles the middleware for the Edge runtime via static analysis — `process.env.X` references are resolved at `next build` time, not at runtime in the running container. Setting `WORKOS_REDIRECT_URI` as a runtime env on the web Deployment makes it visible to Node code at request time, but AuthKit has already thrown by then.

**Fix (in the digest-pipeline web image build):** `Dockerfile.web` accepts `WORKOS_REDIRECT_URI` as a Docker build arg and exports it as `ENV` before `npm run build`, so the value is present when Next.js bundles the middleware. `release.yml` passes it as a build arg from the per-env public hostname:

```yaml
# release.yml (web image build)
build-args: |
  WORKOS_REDIRECT_URI=https://<env public hostname>/callback
```

The redirect URI is a public OAuth callback (the WorkOS dashboard literally exposes it to anyone with read access on the application), so baking it into the image is fine. The other AuthKit values (`workosApiKey`, `workosClientId`, `cookiePassword`) stay as runtime secrets synced via the ExternalSecret — those are read inside request handlers via `getEnvVariable`, not at module load, so runtime injection works for them.

If you fork digest-pipeline and the redirect URI ever needs to differ between environments, vary the per-env public hostname (already the case for staging vs production) and the build arg follows.

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

### Traces missing from Tempo

**Cause:** The pods export OTLP to the shared cluster OpenTelemetry Collector (`telemetry.monitoring.svc.cluster.local:4318`), which forwards traces to in-cluster Tempo. The receiver takes no authentication, so the break is almost always reachability — the app can't get to the collector gateway Service — or the gateway itself failing to reach Tempo.

**Fix:** the OpenTelemetry Collector gateway is a cluster addon owned by `eks-gitops`, in the `monitoring` namespace. Check its logs (it's shared across all tenants, so filter for the digest-pipeline resource attrs `agents.tenant=growth` / `agents.platform=digest-pipeline`):

```bash
kubectl -n monitoring logs deployment/otel-gateway --tail=200 | grep -Ei 'digest-pipeline|growth|error'
```

Common errors:
- `403 Forbidden` / connection refused from the gateway toward Tempo — check the `tempo` Service in the `monitoring` namespace is up and that eks-gitops has reconciled the Tempo addon.
- `404 Not Found` — wrong region in `otlpEndpoint` (e.g. `prod-us-west-0` when your stack is `prod-us-east-0`).
- `403 Forbidden` — the Cloud Access Policy doesn't include `metrics:write` + `traces:write`.

If the gateway logs show no digest-pipeline spans arriving at all, the app-side export is failing — confirm `OTEL_EXPORTER_OTLP_ENDPOINT` resolves to the `telemetry.monitoring` Service from inside the pod and that the chart's `networkpolicy.yaml` allows egress to it.

### Logs not in Grafana

**Cause:** DigestPipeline does NOT ship logs through OTel. Logs go directly from pod stdout → the eks-gitops cluster OpenTelemetry Collector → in-cluster Loki. If logs are missing, either the collector agent isn't tailing the namespace or the pods aren't emitting to stdout.

**Fix:** Query Loki in Grafana with the service label — e.g. `{service="digest-pipeline-pipeline"}` (or `digest-pipeline-api` / `digest-pipeline-web`); `trace_id` is present on every line, so the Tempo ↔ Loki join is one click. If nothing returns, confirm the pods are logging (`kubectl -n tenants-digest-pipeline logs deploy/digest-pipeline-api` shows JSON lines) and that the cluster log forwarder (an `eks-gitops` addon) is healthy and watching `tenants-digest-pipeline`.

### Pino records missing `trace_id` / `span_id` fields

**Cause:** The Pino log call is happening outside an active OTel span.

**Fix:** Wrap the logging call in a span, or accept that records outside spans won't carry trace context. `@opentelemetry/instrumentation-pino` auto-injects these when a span is active; no trace context in the call means no fields.

### `OTEL_SDK_DISABLED=true` left set in production by accident → every metric + trace is dropped

**Cause:** The env var was set during local testing and slipped into the chart's rendered env.

**Fix:** Search the chart values (`chart/values*.yaml`, the `digest-pipeline.env` helper) and every `.env*` file for `OTEL_SDK_DISABLED`. It should be absent in production; only tests and local runs set it. Re-sync with it unset.

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

**Cause:** Aurora Serverless v2 at 0.5 ACU caps active connections aggressively. If the pipeline CronJob pod and the api pods open connections simultaneously during a scheduled run, you can transiently exceed the pool.

**Fix:** `src/data/pool.ts` creates a single `pg.Pool` per pod with default sizing (10 connections). If you see persistent throttling, raise the pool's `max`, or scale up Aurora's min ACU to 1 in the landing-zone `tenant-substrate` component.
