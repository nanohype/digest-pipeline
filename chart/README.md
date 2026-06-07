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
  - `serviceaccount.yaml` — shared SA across all three workloads; IRSA annotation fed by `aws.platformRoleArn` (per-env), pointing at the landing-zone-owned digest-pipeline-platform IRSA role
  - `networkpolicy.yaml` — ingress: ingress-nginx → api/web + intra-pod web → api; egress: DNS + HTTPS + Postgres on cluster VPC CIDR
  - `externalsecret.yaml` — aggregates four AWS Secrets Manager entries into one Secret consumed via envFrom; composes `DATABASE_URL` via the External Secrets template engine
  - `migrate-job.yaml` — Helm pre-install/pre-upgrade hook running `npm run migrate:up`
  - `prometheusrule.yaml` — alerts on the digest-pipeline metrics (`digest-pipeline.run.duration_ms`, `digest-pipeline.source.failure`, `digest-pipeline.bedrock.fallback`, `digest-pipeline.email.sent`)
  - `grafana-dashboard.yaml` — ConfigMap labeled `grafana_dashboard: "1"` loading the dashboard from `dashboards/digest-pipeline.json`

## Per-tenant infra (from landing-zone)

Single-tenant component `components/aws/digest-pipeline-platform/` provisions everything digest-pipeline's pods need:

- Aurora Serverless v2 Postgres (drafts + audit_events; per-env ACU range) + `digest-pipeline/<env>/db-credentials` Secret managed by the rds-aurora module
- S3 ×2 — `digest-pipeline-voice-baseline-<env>` (immutable corpus, versioned, 365d noncurrent retention) + `digest-pipeline-raw-aggregations-<env>` (debug snapshots, 90d expiration)
- SES v2 verified email identity + configuration set; DKIM tokens emitted as outputs for the operator to publish as CNAME records on the apex DNS zone
- IRSA role with the consolidated inline policy (Aurora RDS connect, S3 PutObject + GetObject on both buckets, SES SendEmail on the verified identity, Bedrock invoke for Claude Sonnet 4.6 + Titan embed, Secrets Manager read on `digest-pipeline/<env>/*`, CloudWatch PutMetricData)

Secrets Manager entries (`digest-pipeline/<env>/approvers`, `digest-pipeline/<env>/workos-directory`, `digest-pipeline/<env>/grafana-cloud`) are seeded via this repo's `scripts/seed-secrets.sh`; the ExternalSecret then syncs them into the in-cluster Secret. `db-credentials` is the exception — the landing-zone `digest-pipeline-platform` rds-aurora module creates and owns it alongside the cluster.

## IRSA wiring

Two IRSA roles exist for any digest-pipeline Platform tenant — different SAs, different policies, different owners:

| Role                             | Owner                                             | Trust                                                     | Used by                                                         |
| -------------------------------- | ------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------- |
| `<env>-digest-pipeline-platform` | landing-zone `digest-pipeline-platform` component | `system:serviceaccount:tenants-protohype:digest-pipeline` | This chart's pipeline CronJob + api Deployment + web Deployment |
| `<env>-digest-pipeline-tenant`   | eks-agent-platform operator                       | `system:serviceaccount:tenants-protohype:tenant-runtime`  | AgentFleet pods (if/when any land in this Platform)             |

The chart's `serviceaccount.yaml` annotates `eks.amazonaws.com/role-arn` with `.Values.aws.platformRoleArn`. Per-env values plumb in the landing-zone output:

```sh
# Staging
tofu -chdir=live/aws/workload-staging/us-west-2/staging/digest-pipeline-platform output -raw irsa_role_arn

# Production
tofu -chdir=live/aws/workload-prod/us-west-2/production/digest-pipeline-platform output -raw irsa_role_arn
```

Drop those into `chart/values-staging.yaml` / `chart/values-production.yaml` under `aws.platformRoleArn`. ArgoCD reads the per-env values at render time; pod restart picks up the SA annotation; pods AssumeRoleWithWebIdentity into the right role on next AWS call.

The operator-managed role is unused by this chart today and is harmless. It only matters once an AgentFleet CR lands in the `digest-pipeline` Platform.

## Render locally

```sh
helm template digest-pipeline chart -f chart/values-staging.yaml > rendered-staging.yaml
helm lint chart
```

## Where the rest sits

- **AWS substrate** — Aurora Serverless v2, the two S3 buckets (voice-baseline immutable corpus + raw-aggregations debug snapshots), the SES verified identity + configuration set, and the IRSA role live in the landing-zone `digest-pipeline-platform` component. SES is `ses.tf` in that component; the pipeline pod calls SES via the SDK on its IRSA role.
- **Cluster addons** — ingress-nginx, cert-manager, external-secrets, the OTel collector + log forwarder, and kube-prometheus-stack (which consumes this chart's `prometheusrule.yaml` + `grafana-dashboard.yaml`) are reconciled by `eks-gitops`.
- **Images** — `release.yml` builds and pushes the three images (`api`/`pipeline`/`web`) to `ghcr.io/nanohype/digest-pipeline`; the chart references them by tag and resolution happens at pull time, so multi-arch falls out of the build matrix rather than a pinned platform.
