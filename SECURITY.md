# Security Policy

## Reporting a vulnerability

Email rackctl@gmail.com with subject `[security][digest-pipeline]`. Do not open public issues for security reports.

Acknowledgement target: within 72 hours. Triage target: within 5 business days.

## Security posture

digest-pipeline aggregates cross-team activity, drafts a weekly newsletter with Claude via
Bedrock, and sends it through SES. It touches people's names, work items, and messages, so its
defining controls are **PII never reaches the model unfiltered** and **nothing sends without a
human approving it**.

### PII redaction (type-enforced, two checkpoints)

- Every aggregated item is passed through `sanitizeSourceItem` (`src/pipeline/filters/pii.ts`)
  before it leaves its aggregator. Sanitization is enforced by a **type brand**: the LLM prompt
  builder only accepts `SanitizedSourceItem[]` (`src/pipeline/types.ts`), so unredacted
  `SourceItem`s can't reach the generator — the compiler rejects it.
- The regex scrubber covers compensation, performance/HR, contact info, health, HR case IDs,
  SSN, credit card, and DOB classes.
- `assertNoPii` (`src/pipeline/filters/pii.ts`) runs at **two checkpoints**: post-aggregation
  (after the pre-LLM PII filter) and **post-LLM** (on generated draft text), so a leak in the
  model output is caught before the draft is persisted or sent.

### Human approval gate

- No draft is ever sent to SES without an explicit human approval. The approver allow-list is
  read from AWS Secrets Manager (the `APPROVERS_SECRET_ID` secret: `{cosUserId,
backupApproverIds[]}`) — it is not hardcoded and not editable from the UI.
- The approve action is the only path to `POST /drafts/:id/approve → SES send`. An unapproved
  draft expires; expiry, edit deltas, approval timestamps, and send receipts all land as
  immutable `audit_events` rows keyed on `run_id`.

### Identity & auth

- Every API route except `/health` is gated by WorkOS JWT auth — `jose` validates the bearer
  token against the WorkOS JWKS (`src/api/`). The web review UI authenticates with WorkOS
  AuthKit; its proxy routes carry the JWT through to the API.
- Identities in aggregated content are resolved through WorkOS Directory Sync
  (`src/pipeline/identity/workos.ts`) — the pipeline acts on directory-known users.

### Identity & secrets

- No long-lived credentials in the app. Pods get AWS access via IRSA (Workload Identity); there
  are no static keys anywhere in the repo or image. Bedrock, S3, SES, and Secrets Manager calls
  AssumeRoleWithWebIdentity into the landing-zone `digest-pipeline-platform` IRSA role.
- App-level secrets are projected at deploy time by External Secrets Operator from AWS Secrets
  Manager (`digest-pipeline/<env>/*`) into a Kubernetes Secret consumed `envFrom` — never committed.
- Inference runs on-account via Amazon Bedrock — source content is not sent to third parties.

### Network

- Default-deny `NetworkPolicy` with an explicit egress allow-list: DNS, HTTPS to AWS APIs and
  the GitHub / Linear / Notion / Slack / WorkOS endpoints, and Postgres on the cluster VPC CIDR.
  Ingress is limited to ingress-nginx and intra-pod traffic. IMDS is blocked.
- Public surface is limited to `/health` and the review UI behind ingress-nginx + cert-manager
  TLS (`/api/*` → API with rewrite, `/` → web).

## Known limitations

- PII redaction is regex-class-based. A novel sensitive-data shape not covered by an existing
  class can pass the pre-LLM filter; the post-LLM `assertNoPii` checkpoint is the backstop, and
  new classes land in `src/pipeline/filters/pii.ts` with a test (see CONTRIBUTING.md).
- The approval gate trusts the allow-list in Secrets Manager. Rotating an approver out of the
  org is enforced on the next run's secret read, not retroactively on an in-flight draft.
- Approval freshness is bounded by WorkOS Directory Sync propagation — an identity change
  upstream is reflected on the next pipeline run, not mid-draft.

## Compliance

digest-pipeline exposes the controls needed for **SOC 2 Type II** — IRSA-only access with no
static credentials, secrets sourced from AWS Secrets Manager (never committed), PII scrubbing
enforced at the type boundary before inference, a complete per-run audit trail in the
immutable `audit_events` ledger, and a human approval gate before any external send. Substrate-
level controls (CIS EKS baseline, Pod Security Standards, image signing) are enforced upstream
by `landing-zone` and `eks-gitops`.
