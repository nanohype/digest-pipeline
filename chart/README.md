# digest-pipeline chart

Helm chart for the digest-pipeline newsletter pipeline. Renders three workloads into a Platform tenant on the `eks-agent-platform` operator:

- **pipeline** — `CronJob` (weekly Friday 09:00 UTC) running aggregators → ranker → Bedrock generator → audit writer → Slack review notification
- **api** — `Deployment` running the Fastify review API on port 3001 (JWT-gated against WorkOS)
- **web** — `Deployment` running the Next.js review app on port 3000 (WorkOS AuthKit)

Plus a `migrate-job` Helm pre-install/pre-upgrade hook that runs the SQL migrations against Aurora before any pod from the new version rolls out.

## Files

- `Chart.yaml`, `values.yaml` (base), `values-{staging,production}.yaml` (delta only)
- `templates/`
  - `_helpers.tpl` — name/label helpers; `digest-pipeline.env` partial shared by all three workloads
  - `pipeline-cronjob.yaml` — CronJob (forbid concurrent, 30-min activeDeadline, 1-attempt backoff)
  - `api-deployment.yaml` + `api-service.yaml` — Fastify API
  - `web-deployment.yaml` + `web-service.yaml` — Next.js web; wires `DIGEST_PIPELINE_API_URL` to the api Service DNS
  - `ingress.yaml` — ingress-nginx routing `/api/*` → api Service (with rewrite-target to strip `/api`), `/` → web Service; cert-manager TLS
  - `serviceaccount.yaml` — shared SA across all three workloads, name pinned to the app; bound to the tenant IAM role by a Pod Identity association (no role-arn annotation)
  - `networkpolicy.yaml` — ingress: ingress-nginx → api/web + intra-pod web → api; egress: DNS + HTTPS + Postgres on cluster VPC CIDR
  - `externalsecret.yaml` — aggregates four AWS Secrets Manager entries into one Secret consumed via envFrom; composes `DATABASE_URL` via the External Secrets template engine
  - `migrate-job.yaml` — Helm pre-install/pre-upgrade hook running `npm run migrate:up`
  - `prometheusrule.yaml` — alerts on the digest-pipeline metrics (`digest-pipeline.run.duration_ms`, `digest-pipeline.source.failure`, `digest-pipeline.bedrock.fallback`, `digest-pipeline.email.sent`)
  - `grafana-dashboard.yaml` — GrafanaDashboard CR (instanceSelector `dashboards: external`) loading the dashboard from `dashboards/digest-pipeline.json`, reconciled by the grafana-operator onto Amazon Managed Grafana

## Per-tenant infra (from landing-zone)

Single-tenant component `components/aws/digest-pipeline-platform/` provisions everything digest-pipeline's pods need:

- Aurora Serverless v2 Postgres (drafts + audit_events; per-env ACU range) + `digest-pipeline/<env>/db-credentials` Secret managed by the rds-aurora module
- S3 ×2 — `digest-pipeline-voice-baseline-<env>` (immutable corpus, versioned, 365d noncurrent retention) + `digest-pipeline-raw-aggregations-<env>` (debug snapshots, 90d expiration)
- SES v2 verified email identity + configuration set; DKIM tokens emitted as outputs for the operator to publish as CNAME records on the apex DNS zone
- The `<env>-digest-pipeline-app-access` managed policy (`app_access_policy_arn`): S3 GetObject/PutObject/ListBucket on both buckets, SES SendEmail on the verified identity + configuration set, Secrets Manager read on `digest-pipeline/<env>/*` plus the Aurora master-credentials ARN, CloudWatch PutMetricData
- The EKS Pod Identity association binding the chart's ServiceAccount to the tenant IAM role

Secrets Manager entries (`digest-pipeline/<env>/approvers`, `digest-pipeline/<env>/workos-directory`, `digest-pipeline/<env>/grafana-cloud`) are seeded via this repo's `scripts/seed-secrets.sh`; the ExternalSecret then syncs them into the in-cluster Secret. `db-credentials` is the exception — the landing-zone `digest-pipeline-platform` rds-aurora module creates and owns it alongside the cluster.

## Pod identity

One IAM role serves the whole Platform: `<env>-digest-pipeline-tenant`, minted by the eks-agent-platform operator from the Platform CR. Its trust policy is the EKS Pod Identity service principal (`pods.eks.amazonaws.com`), so the trust policy itself names no ServiceAccount — the `(namespace, service-account)` binding lives in a Pod Identity association:

| Association                                  | Created by                                        | Used by                                                        |
| -------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------- |
| `(tenants-digest-pipeline, digest-pipeline)` | landing-zone `digest-pipeline-platform` component | This chart's pipeline CronJob + api Deployment + web Deployment |
| `(tenants-digest-pipeline, tenant-runtime)`  | eks-agent-platform operator                       | AgentFleet pods (if/when any land in this Platform)            |

The role's permissions come from two owners, joined on the Platform CR. Bedrock invoke is operator-owned: the agent-iam baseline grant, clamped by the operator's `bedrock-model-scoping` inline policy to exactly `spec.identity.allowedModels`. The app's substrate grants are tofu-owned: the landing-zone `app_access_policy_arn` managed policy, attached by the operator because `spec.identity.extraPolicyArns` references it.

The chart's `serviceaccount.yaml` creates a ServiceAccount named `digest-pipeline` (pinned via `serviceAccount.name`) with no role-arn annotation — EKS injects credentials through the standard AWS credential chain via the association. The ServiceAccount name must match the association's `service_account`, which is why it is pinned to the app name.

Ordering matters: the Platform CR must reach `Ready` (tenant role minted) before the landing-zone component can look the role up and create its association.

## Render locally

```sh
helm template digest-pipeline chart -f chart/values-staging.yaml > rendered-staging.yaml
helm lint chart
```

## Where the rest sits

- **AWS substrate** — Aurora Serverless v2, the two S3 buckets (voice-baseline immutable corpus + raw-aggregations debug snapshots), the SES verified identity + configuration set, and the app-access managed policy live in the landing-zone `digest-pipeline-platform` component. SES is `ses.tf` in that component; the pipeline pod calls SES via the SDK on the tenant role.
- **Cluster addons** — ingress-nginx, cert-manager, external-secrets, the OTel collector + log forwarder, and kube-prometheus-stack (which consumes this chart's `prometheusrule.yaml` + `grafana-dashboard.yaml`) are reconciled by `eks-gitops`.
- **Images** — `release.yml` builds and pushes the three images (`api`/`pipeline`/`web`) to `ghcr.io/nanohype/digest-pipeline`; the chart references them by tag and resolution happens at pull time, so multi-arch falls out of the build matrix rather than a pinned platform.
