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
  - `web-deployment.yaml` + `web-service.yaml` — Next.js web; wires `API_BASE_URL` to the api Service DNS
  - `ingress.yaml` — routes everything under the host to the web Service on the `alb` class; TLS terminates on the ALB against an ACM certificate. The api Service is deliberately absent: web's Next.js route handlers under `/api/*` hold the AuthKit session and call it over cluster DNS
  - `serviceaccount.yaml` — shared SA across all three workloads, name pinned to the app; bound to the tenant IAM role by a Pod Identity association (no role-arn annotation)
  - `networkpolicy.yaml` — ingress: the VPC range the ALB's interfaces sit in → web, plus intra-pod web → api; egress: DNS + HTTPS + Postgres on cluster VPC CIDR
  - `externalsecret.yaml` — aggregates three AWS Secrets Manager entries into one Secret consumed via envFrom; composes `DATABASE_URL` via the External Secrets template engine
  - `migrate-job.yaml` — Helm pre-install/pre-upgrade hook running `npm run migrate:up`
  - `prometheusrule.yaml` — alerts on the digest-pipeline metrics (`digest-pipeline.run.duration_ms`, `digest-pipeline.source.failure`, `digest-pipeline.bedrock.fallback`, `digest-pipeline.email.sent`)
  - `grafana-dashboard.yaml` — GrafanaDashboard CR (instanceSelector `dashboards: external`) loading the dashboard from `dashboards/digest-pipeline.json`, reconciled by the grafana-operator onto Amazon Managed Grafana

## Per-tenant infra (declared)

Everything digest-pipeline's pods need is declared in `platform.yaml`, not a per-app component:

- The `main` `relational` datastore — Aurora Serverless v2 Postgres (drafts + audit_events; per-env ACU range) + the RDS-managed `digest-pipeline/<env>/db-credentials` Secret.
- Two `objectStore` datastores — `voice-baseline` (immutable corpus, versioned, 365d noncurrent retention) + `raw-aggregations` (debug snapshots, 90d expiration).
- The `ses` capability — the operator generates the SES send grant (`ses:SendEmail`, FromAddress-scoped). The verified sending identity + DKIM is account-level mail infrastructure in landing-zone, not per-app.

All three datastores are provisioned by the generic `tenant-substrate` component from `spec.datastores`; the operator generates the scoped datastore-access + capability-access policies. Secrets Manager entries (`digest-pipeline/<env>/approvers`, `digest-pipeline/<env>/workos-directory`) are seeded via this repo's `scripts/seed-secrets.sh`; the ExternalSecret then syncs them into the in-cluster Secret. `db-credentials` is the exception — the `main` datastore's RDS-managed master secret owns it.

## Pod identity

One IAM role serves the whole Platform: `<env>-digest-pipeline-tenant`, minted by the eks-agent-platform operator from the Platform CR. Its trust policy is the EKS Pod Identity service principal (`pods.eks.amazonaws.com`), so the trust policy itself names no ServiceAccount — the `(namespace, service-account)` binding lives in a Pod Identity association the operator creates:

| Association                                 | Created by                  | Used by                                                       |
| ------------------------------------------- | --------------------------- | ------------------------------------------------------------- |
| `(tenants-digest-pipeline, tenant-runtime)` | eks-agent-platform operator | All three app workloads + any AgentFleet pods in this Platform |

The role's permissions are all operator-owned, generated from the Platform CR: the agent-iam baseline grant clamped by the `bedrock-model-scoping` inline policy to exactly `spec.identity.allowedModels`, the datastore-access policy generated from `spec.datastores`, and the capability-access policy (SES send) generated from `spec.identity.capabilities`.

The chart's `serviceaccount.yaml` references the operator-owned `tenant-runtime` ServiceAccount (`serviceAccount.create: false`) with no role-arn annotation — EKS injects credentials through the standard AWS credential chain via the association. The operator creates and owns that ServiceAccount.

## Render locally

```sh
helm template digest-pipeline chart -f chart/values-staging.yaml > rendered-staging.yaml
helm lint chart
```

## Where the rest sits

- **AWS substrate** — the `main` Aurora Serverless v2 store and the two S3 buckets (voice-baseline immutable corpus + raw-aggregations debug snapshots) are declared in `spec.datastores` and provisioned by the generic `tenant-substrate` component. SES send rides the `ses` capability (operator-generated grant); the pipeline pod calls SES via the SDK on the tenant role.
- **Cluster addons** — cert-manager, external-secrets, external-dns, the AWS Load Balancer Controller, and the observability stack are reconciled by `eks-gitops`. The load balancer controller serves the `alb` class this chart's `Ingress` requests; the ACM certificate TLS terminates against is yours to issue. That stack is the OpenTelemetry Collector (OTLP on `:4317`/`:4318`, fanning metrics out to Amazon Managed Prometheus over SigV4, traces to Tempo, logs to Loki) plus grafana-operator, which is what picks up this chart's `grafana-dashboard.yaml` and imports it into the external Amazon Managed Grafana. Nothing in that catalog evaluates `PrometheusRule` — alerting on EKS is Grafana-managed against AMP — which is why `prometheusRule.enabled` defaults to `false` and is opt-in for a cluster running its own ruler.
- **Images** — `release.yml` builds and pushes the three images (`api`/`pipeline`/`web`) to `ghcr.io/nanohype/digest-pipeline`; the chart references them by tag and resolution happens at pull time, so multi-arch falls out of the build matrix rather than a pinned platform.
