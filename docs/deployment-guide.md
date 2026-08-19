# Deployment guide

End-to-end walkthrough for bringing DigestPipeline up in a fresh environment. DigestPipeline ships as a **Platform tenant** on the `eks-agent-platform` operator: per-tenant AWS substrate lives in the landing-zone `tenant-substrate` component, the app deploys as a Helm chart reconciled by ArgoCD, and staging + production are separate, env-scoped instances of the same trio. Stand staging up first, run a manual end-to-end, then repeat for production.

If you're rotating credentials on an already-running tenant, jump to [`secrets.md`](secrets.md) instead. If a specific error has bitten you, [`troubleshooting.md`](troubleshooting.md) has concrete fixes keyed on the error text.

## 0. Prerequisites

### AWS side

The slow-moving, per-tenant AWS substrate is declared in `spec.datastores` and provisioned by the generic `tenant-substrate` component: the `main` Aurora Serverless v2 store and the two S3 buckets. The operator generates the IAM (datastore-access + the SES `ses` capability grant) and the Pod Identity association from the Platform CR; SES's verified sending identity is account-level mail infrastructure. You apply the env's `tenant-substrate` leaf with terragrunt before deploying the chart — see [`landing-zone`](https://github.com/nanohype/landing-zone). Set the region that has Bedrock access enabled:

```bash
export AWS_REGION=us-east-1
```

> **us-east-1 is not a default you can override.** Every venture account sits in
> an Organizations OU carrying an SCP that denies any regional call outside
> us-east-1, with a `NotAction` allowlist for global services. A command aimed
> anywhere else fails with an explicit deny naming the policy — not a
> missing-permission error, so it does not look like an IAM problem you can fix
> by widening a role. Global services (IAM, Route 53, CloudFront, the S3
> `ListAllMyBuckets` call) still answer, which is why an occasional cross-region
> resource is *visible* while being unreadable.

- **Bedrock model access** must be enabled in the deployment region for the Claude model the inference profile fans out to. Default is `us.anthropic.claude-sonnet-5` (US cross-region inference profile); request access for `anthropic.claude-sonnet-5` in **all three** US regions the profile spans (us-east-1, us-east-2, us-west-2) so AWS can route to whichever has spare capacity. Outside the US, set the route's `crossRegionProfile` to `eu.anthropic.claude-sonnet-5` (or `global.` in Asia Pacific) on the `ModelGateway` CR, add the same ID to `spec.identity.allowedModels` in `platform.yaml`, and request access in the matching regions. The app is unaffected — it names a route, not a model.

  Enable via AWS console → Bedrock → Model access → Request access. The pipeline fails at run-time with `AccessDeniedException` during `phase.generate` if access is missing, falls back to a raw skeleton draft, and audits `PIPELINE_FAILURE`.

  **Why an inference profile by default.** Bedrock reports `inferenceTypesSupported: [INFERENCE_PROFILE]` for the whole current Claude family — no `ON_DEMAND`, and no `PROVISIONED` either. A cross-region inference profile is the only way to invoke these models at all, so the geo prefix is not a routing preference. Available prefixes vary by region: `us.` in us-east-1 / us-west-2, `eu.` in eu-central-1, `au.` in ap-southeast-2, and `global.` everywhere. The `apac.` prefix exists but carries only Claude 3.x, so it is not an option for this model. Confirm with `aws bedrock list-inference-profiles --region <region>`. `platform.yaml` lists the bare ID in `spec.identity.allowedModels`, and the operator expands a bare entry into both the foundation-model ARN and the matching `us.` inference-profile ARN — so either form works without a policy edit. See [`troubleshooting.md`](troubleshooting.md) § "Bedrock errors".

- **SES verified identity.** The `sesFromAddress` you will seed into `digest-pipeline/{env}/runtime-config` must be a verified SES identity (either the email or the sending domain) in the deployment region. The verified sending identity + DKIM is account-level mail infrastructure in landing-zone (not per-app); the `ses` capability grants the tenant role send. If SES is still in sandbox mode, every recipient address in `newsletterRecipients` must also be verified — request production access before you promote to production.

- **Cluster + addons.** A reachable EKS cluster with the eks-gitops addon catalog installed: cert-manager, external-secrets, external-dns, the AWS Load Balancer Controller, the OpenTelemetry Collector (the OTLP receiver and log shipper), Tempo, Loki, and grafana-operator. The chart assumes these exist; it does not install them. The `Ingress` requests the `alb` class the load balancer controller serves, and needs an ACM certificate for its host — see `chart/README.md`.

### Third-party accounts (staging + production)

Provision these **separately** per environment — staging and production each want their own Slack workspace (or at minimum a distinct bot user + review channel) / Linear workspace / Notion database / WorkOS directory. Credentials land in env-scoped Secrets Manager paths (`digest-pipeline/staging/*` vs `digest-pipeline/production/*`); sharing them defeats the isolation.

| System | What you need | Where to get it |
|---|---|---|
| **WorkOS** | API key (`sk_live_…`), Client ID (`client_01…`), Directory ID, approver User Management ID (`user_01…`) | [dashboard.workos.com](https://dashboard.workos.com). The Client ID drives the API's JWT `aud` claim and is also seeded into `web-config` for AuthKit; set it in the per-env chart values under `web.workosClientId` (and the API's `WORKOS_CLIENT_ID`). The Directory ID comes from WorkOS → Directory Sync after you connect the IdP. The approver User Management ID (the `user_01…` that goes into `approvers.cosUserId`) only exists after first AuthKit sign-in — bootstrap yourself via the Hosted UI URL: [`secrets.md`](secrets.md) § "Getting a WorkOS User Management ID". |
| **Slack app** | Bot token (`xoxb-…`), announcements channel ID, team channel ID, review channel ID, HR bot user IDs (optional) | Full walkthrough in [`slack-app-setup.md`](slack-app-setup.md). The bot has to be a member of every channel it reads (announcements + team) and the channel it posts to (review). |
| **Linear** | Personal API key, optional `askLabel` override | Linear → Settings → API → Personal API keys. The aggregator reads closed epics, upcoming milestones, and issues tagged with `askLabel` (default `ask`) from the past week. |
| **Notion** | Internal-integration token (`secret_…`), database ID of the all-hands page | Notion → Settings → Connections → Develop or manage integrations. Share the all-hands database with the integration explicitly. |
| **GitHub** | PAT with `repo:read` over the repos you want aggregated | GitHub → Settings → Developer settings → Personal access tokens. Read-only; used for merged-PR fetch. |

Nothing to provision for telemetry. Traces, metrics and logs land in the observability stack `eks-gitops` already runs on the cluster — the OpenTelemetry Collector agent on every node, a gateway plus Tempo and Loki in-cluster, Amazon Managed Prometheus for metrics. The app exports OTLP to the collector gateway Service and holds no credential for any of it.

### Local tooling

- Node 24 (Active LTS)
- `aws` CLI ≥ 2.15 with creds for the target account
- `kubectl` + `helm` pointed at the target cluster
- `psql` (for a local migration sanity check; optional)

## Deploy staging first

The rest of this walkthrough brings up the `staging` tenant. Once staging is live + a manual end-to-end has passed, re-run the same steps with `production`.

### 1. Provision the AWS substrate

The tenant's substrate is declared in `platform.yaml` (`spec.datastores`): the `main` Aurora Serverless v2 store (and its RDS-managed `digest-pipeline/<env>/db-credentials` secret) and the two S3 buckets. The generic `tenant-substrate` component provisions them from that declaration. Apply the env's `tenant-substrate` leaf via terragrunt:

```bash
cd landing-zone
terragrunt apply --terragrunt-working-dir live/aws/workload-staging/us-west-2/staging/tenant-substrate
```

Nothing about IAM goes into the chart or a per-app component: once the Platform CR is `Ready` (step 4), the operator generates the datastore-access policy (from `spec.datastores`) and the capability-access policy (the SES send grant, from `spec.identity.capabilities`) on the `<env>-digest-pipeline-tenant` role, and creates the EKS Pod Identity association binding the operator-owned `tenant-runtime` ServiceAccount to it. There is no `app_access_policy_arn` to record and no `extraPolicyArns` to set. See [`../chart/README.md`](../chart/README.md) § "Pod identity".

### 2. Seed every secret

Every non-DB secret is operator-provisioned — the chart's ExternalSecret references them by name; the External Secrets Operator only syncs them into the in-cluster Secret once they exist. Seed before the first sync.

The seeder (`npm run seed:{env}`) handles both first-seed (create) and rotation (put) transparently:

```bash
cp secrets.template.json digest-pipeline-secrets.staging.json
# Edit the file — replace every REPLACE_ME with the real value.
# web-config.cookiePassword auto-derives if left
# empty. `digest-pipeline-secrets.*.json` is gitignored.

npm run seed:staging:dry     # validates shape, no AWS calls
npm run seed:staging         # creates every required secret in Secrets Manager
```

This seeds eight secrets for `digest-pipeline/staging/`: `approvers`, `workos-directory`, `github`, `linear`, `slack`, `notion`, `web-config`, `runtime-config`. `db-credentials` is the exception — the `tenant-substrate` rds-aurora module creates and owns it.

Per-key provenance (what comes from which third-party account), JSON schema per payload, and rotation guidance are all in [`secrets.md`](secrets.md). The raw `aws secretsmanager create-secret` commands are there too if you need to seed from a machine without the repo checked out.

### 3. Build the images

`release.yml` builds and pushes the three images (`api`/`pipeline`/`web`) to `ghcr.io/nanohype/digest-pipeline` on tag. The chart references them by `image.tag` in the per-env values. For a first deploy, push a tag (or run the release workflow) so an image exists, then set `image.tag` in `chart/values-staging.yaml` to match.

```bash
npm run lint && npm run typecheck && npm test && npm run build
cd web && npm ci && npx tsc --noEmit && npm run build
```

(`task ci` runs the whole gate, including the chart render — see [`local-development.md`](local-development.md).)

### 4. Apply the Platform CR

The Platform CR declares digest-pipeline as a tenant of the `growth` team. Both it and the BudgetPolicy live in the team's management namespace, so create that first, then apply once:

```bash
kubectl create namespace tenants-growth --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f platform.yaml
```

The operator reconciles the workload namespace `tenants-digest-pipeline`, ResourceQuota, LimitRange, default-deny NetworkPolicy, the ArgoCD AppProject `digest-pipeline`, and the `<env>-digest-pipeline-tenant` IAM role. Wait for the Platform to reach `Ready`:

```bash
kubectl get platform digest-pipeline -n tenants-growth -o jsonpath='{.status.phase}'
```

### 5. Register the ApplicationSet entry

`gitops/applicationset-entry.yaml` is the entry that registers into `nanohype/eks-gitops` (`applicationsets/apps-tenants.yaml`). Add it there, commit, and push. ArgoCD's ApplicationSet controller renders one Application per cluster (matrix generator over `clusters × [digest-pipeline]`), Helm multi-source `$values` resolving `values.yaml` + `values-staging.yaml` from this repo.

### 6. Let ArgoCD sync

ArgoCD rolls out the chart at sync wave 100: the pipeline `CronJob`, the api + web `Deployment`s + `Service`s, the `ingress` (ALB, ACM TLS, everything → web), the shared `serviceaccount` (bound by Pod Identity), the `networkpolicy`, the `externalsecret`, the `prometheusrule` + `grafana-dashboard`, and the `rbac` (namespaced Role for the api admin Job trigger). The `migrate-job` runs as a Helm pre-install/pre-upgrade hook, applying schema migrations against Aurora before the new pods roll.

Watch the rollout:

```bash
kubectl -n tenants-digest-pipeline get pods -w
argocd app get digest-pipeline    # if you have the ArgoCD CLI
```

The ExternalSecret materializes the in-cluster Secret from the seeded `digest-pipeline/staging/*` entries; if a key is missing the pods stay in `CreateContainerConfigError` until it's seeded and the ExternalSecret resyncs.

### 7. Verify migrations landed

The `migrate-job` hook runs `npm run migrate:up` against Aurora. Confirm it succeeded:

```bash
kubectl -n tenants-digest-pipeline get jobs
kubectl -n tenants-digest-pipeline logs job/digest-pipeline-migrate
```

If you need to run migrations by hand (e.g. from a bastion inside the VPC):

```bash
DB_SECRET=$(aws secretsmanager get-secret-value \
  --region us-east-1 \
  --secret-id digest-pipeline/staging/db-credentials \
  --query SecretString --output text)

export DATABASE_URL="postgres://$(echo "$DB_SECRET" | jq -r '.username'):$(echo "$DB_SECRET" | jq -r '.password' | jq -sRr @uri)@$(echo "$DB_SECRET" | jq -r '.host'):$(echo "$DB_SECRET" | jq -r '.port')/$(echo "$DB_SECRET" | jq -r '.dbname')"

npm run migrate:up
```

### 8. Wire the WorkOS AuthKit redirect URI

In the WorkOS dashboard for the Client ID in your per-env values, add the redirect URI:

- Staging: `https://<staging-host>/callback` — `<staging-host>` is `ingress.host` from `chart/values-staging.yaml`, the name external-dns publishes for the ALB
- Production: `https://<production-host>/callback`

AuthKit will only redirect to an HTTPS URI, and HTTPS here is terminated by the load balancer, not in the cluster: set `ingress.tls.certificateArn` in the same per-env values file to an ACM certificate ARN covering that host — from the landing-zone `dns` component (`terragrunt output -json acm_certificate_arns`) — or leave it empty and let the AWS Load Balancer Controller match a certificate in ACM by domain. Nothing issues a certificate in-cluster, so a host with no ACM match fails the TLS handshake and sign-in dead-ends at the browser rather than at WorkOS.

Until this is registered, `/callback?code=…` returns a WorkOS `invalid_redirect_uri` error and users can't complete sign-in.

### 9. Upload the voice-baseline corpus

The newsletter generator loads few-shot examples from `s3://digest-pipeline-voice-baseline-<account>-staging/`. Bootstrap it with at least one example newsletter the Chief of Staff has signed off on (the more, the better — ~5 examples is a good starting point):

```bash
aws s3 cp ./voice-baseline/2026-01-12.md \
  s3://digest-pipeline-voice-baseline-<account>-staging/baseline/2026-01-12.md
```

Each file is a plain markdown newsletter. The generator concatenates them into the Bedrock system prompt as few-shot examples (cached via a `cachePoint` marker so the corpus is paid for once per run). If the bucket is empty, the generator falls back to zero-shot — legible but not voice-matched.

### 10. Make sure the Slack bot is in every channel it needs

The bot has to be a member of:

- `announcementsChannelId` — read-only ingestion source
- `teamChannelId` — read-only ingestion source
- `slackReviewChannelId` — write target (`postMessage` for "Draft ready" + alerts)

```
/invite @digest-pipeline-bot
```

The Slack aggregator uses `withTimeout(15s)` + `withRetry(3)` per channel — a missing bot membership surfaces as a per-source error, and the pipeline run lands as `PARTIAL` with a warning log (`slack.history-failed`).

### 11. Fire a manual end-to-end run

The weekly `CronJob` is the scheduled runner. To kick off a one-off run before Friday, create a Job from the CronJob template:

```bash
kubectl -n tenants-digest-pipeline create job digest-pipeline-pipeline-manual-$(date +%s) \
  --from=cronjob/digest-pipeline-pipeline
```

Watch the run (stdout also reaches Loki — filter `service="digest-pipeline-pipeline"`):

```bash
kubectl -n tenants-digest-pipeline logs -f job/digest-pipeline-pipeline-manual-<ts>
```

Expected sequence: `pipeline.start` → `phase.aggregate` (per-source item counts) → `phase.dedupe` → `phase.rank` → `phase.generate` (Bedrock span + token usage, incl. cache-read/cache-write tokens) → `phase.audit_and_notify` → `slack.notify-draft` → `pipeline.exit` with `status: "OK"` or `"PARTIAL"`.

In Slack you should see a "Weekly newsletter draft ready" message in the review channel with a link that leads the approver to `https://<staging-host>/review/<draftId>`. Sign in with WorkOS, edit the draft, click **Approve & Send**, and verify:

- Edit event in `audit_events` (check the api logs / Loki: `service="digest-pipeline-api"`)
- SES message ID in the `approved` → `sent` audit chain
- Email lands in your verified-identity inbox

## Promote to production

Repeat the staging steps with `production` in place of `staging`:

```bash
# 1. Provision the prod substrate.
cd landing-zone
terragrunt apply --terragrunt-working-dir live/aws/workload-production/us-west-2/production/tenant-substrate

# 2. Seed production secrets (see secrets.md).
cd ../digest-pipeline
npm run seed:production

# 3. Set image.tag in chart/values-production.yaml, commit,
#    push — the ApplicationSet renders the production Application and ArgoCD syncs it.
```

Production uses completely separate resources:

| | Staging | Production |
|---|---|---|
| Secret path | `digest-pipeline/staging/*` | `digest-pipeline/production/*` |
| Aurora scaling | 0.5 → 2 ACU, no reader | 0.5 → 8 ACU, one reader |
| Aurora retention | 3-day backup, deletion protection OFF | 14-day backup, deletion protection ON |
| S3 `voice-baseline` retention | destroy on teardown | retained on teardown |
| api / web replicas | 1 / 1 | 2 / 2 |
| App-access policy scope | `digest-pipeline/staging/*` only | `digest-pipeline/production/*` only |

The staging tenant role **cannot** read production secrets (and vice versa) — the operator scopes each tenant role's generated policy to its own `digest-pipeline/<env>/*` secret-ARN prefix.

The weekly `CronJob` runs in both environments. If you want staging to skip the auto-run while you iterate, set `pipeline.suspend: true` in `chart/values-staging.yaml` (`spec.suspend` on the CronJob) and trigger manual runs via step 11.

## Teardown

Removing a tenant is the reverse of bring-up:

```bash
ENV=staging

# 1. Remove the ApplicationSet entry from eks-gitops, commit, push — ArgoCD prunes
#    the chart's workloads.

# 2. Tear down the AWS substrate. Do this before deleting the Platform CR: the
#    component reads the operator-minted tenant role to build its Pod Identity
#    association, and that role disappears with the CR.
cd landing-zone
terragrunt destroy --terragrunt-working-dir live/aws/workload-staging/us-west-2/${ENV}/tenant-substrate

# 3. Delete the Platform CR. Its finalizer removes the workload namespace and
#    everything in it, the AppProject, and the tenant IAM role:
kubectl delete -f platform.yaml

# 4. Delete the operator-seeded secrets (the substrate owns db-credentials):
for s in approvers workos-directory github linear slack notion \
         web-config runtime-config; do
  aws secretsmanager delete-secret --region us-east-1 \
    --secret-id digest-pipeline/${ENV}/${s} --force-delete-without-recovery
done
```

> **Do not delete** `digest-pipeline/production` voice-baseline contents lightly. The `voice-baseline` bucket carries the curated few-shot corpus the Chief of Staff built by hand; rebuilding it is weeks of work, not minutes. In production the substrate retains the bucket on teardown for exactly this reason — drain it deliberately, not by accident.

## Common first-deploy failures

| Symptom | Likely cause | Fix |
|---|---|---|
| Pods stuck in `CreateContainerConfigError` | The ExternalSecret can't resolve one of the `digest-pipeline/{env}/*` entries | Re-run the seeder for the missing secret; the ExternalSecret resyncs and the pods start |
| Pod crash-loops on startup with a `ZodError` | One of the JSON secrets has a missing or mistyped field | `kubectl logs` the pod (or filter Loki); `put-secret-value` the fix, let the ExternalSecret resync, then `kubectl rollout restart` the Deployment |
| Pipeline Job runs once, exits, status `Failed` with `AccessDeniedException` on Bedrock | Model access not enabled across all regions the inference profile spans | Default profile is `us.anthropic.claude-sonnet-5` — request model access for `anthropic.claude-sonnet-5` in us-east-1, us-east-2, AND us-west-2. See [`troubleshooting.md`](troubleshooting.md) § "Bedrock errors" |
| API 5xx on `/drafts/:id/approve` with `SES.MessageRejected` | `sesFromAddress` not a verified SES identity, or SES still in sandbox and the recipient isn't verified | Verify the identity in SES; request production-access or verify each recipient during bring-up |
| WorkOS sign-in bounces with `invalid_redirect_uri` | The web's redirect URI isn't registered for the Client ID | Add `https://<host>/callback` in the WorkOS dashboard → Redirects |
| Traces missing from Tempo | The pods can't reach the collector gateway Service, or the gateway can't reach Tempo | Check the collector's logs in the `monitoring` namespace, then confirm the chart's NetworkPolicy allows egress to `telemetry.monitoring.svc.cluster.local:4318` |

For every concrete error observed during bring-up with root cause + fix, see [`troubleshooting.md`](troubleshooting.md).
