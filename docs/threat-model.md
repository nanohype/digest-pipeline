# Threat model

What can go wrong with digest-pipeline, what stops it, and what is left over.

The framing is STRIDE over the system's trust boundaries. `SECURITY.md` states the
posture — the controls that exist; this states the reasoning — what each control is
holding back, and where it does not reach. The two are meant to be read together, and
the residual risks below are deliberately not softened: a threat model whose every row
ends "fully mitigated" is a marketing document.

**The asset that dominates this model is the send.** Almost nothing here is about
confidentiality of a newsletter; it is about the fact that approving one mails ~500
internal recipients, and that action cannot be recalled. Rank every control by whether
it stands between an attacker and that button.

## Trust boundaries

Eight, numbered for reference below.

| # | Boundary | Crossing | Enforced by |
|---|---|---|---|
| 1 | Browser → web | Human session | WorkOS AuthKit, `web/middleware.ts` |
| 2 | web → api | Bearer JWT | `jose` against WorkOS JWKS, `src/api/auth.ts:69` |
| 3 | api → Postgres | Draft state transitions | Parameterised queries + the SQL status machine, `src/data/drafts.ts` |
| 4 | api → SES | The send | Approver allow-list + status machine, `src/api/server.ts:165` |
| 5 | Source SDKs → pipeline | **Untrusted content** | PII filter + `SanitizedSourceItem` brand, `src/pipeline/filters/pii.ts` |
| 6 | pipeline → ModelGateway → Bedrock | Prompt and completion | Instruction/data fencing + output validation, `src/pipeline/ai/generator.ts` |
| 7 | Workloads → AWS | Credentials | EKS Pod Identity; no static keys anywhere in the app |
| 8 | Pod ↔ pod / egress | Network reachability | Default-deny from the Platform CR + the chart's `networkpolicy.yaml` |

Boundary 5 is the one people miss. Every PR title, Linear issue, Notion page and Slack
message the pipeline reads was written by someone outside this system — including,
potentially, someone who knows the newsletter exists.

## The threats that matter

Ranked by expected damage, not by likelihood alone.

### 1. An unauthorised send — Elevation of privilege (boundary 2, 4)

Someone who is not an approver gets the newsletter mailed. Worst case in the system: the
send reaches every employee, cannot be recalled, and carries the organisation's voice.

**Mitigations.** Authentication is a real JWKS verification, not a decode — signature and
issuer are checked (`auth.ts:69`), and the issuer is fully qualified with the client id so
a token minted for another WorkOS Application fails. Authorisation is a separate,
explicit allow-list (`isApprover`, `auth.ts:101`) rather than a claim the token carries,
so a forged or over-scoped claim does not become approval rights. The transition is
enforced in SQL: `approve` only fires `WHERE status = 'PENDING'` and throws on
`rowCount === 0`, so two racing approvals cannot both send. `markSent` accepts only
`APPROVED`, so a draft that never passed the gate cannot be recorded as sent. The route
is rate-limited to 5/minute.

**Residual.** The allow-list lives in Secrets Manager; whoever can write that secret can
grant themselves approval. That is a deliberate trade — the alternative is an in-repo
list requiring a deploy to change an approver — but it means the secret is as sensitive
as the send itself. Removing someone from the org takes effect on the next secret read,
not retroactively on an in-flight draft.

### 2. Prompt injection through aggregated content — Tampering (boundary 5, 6)

A PR title, Linear issue or Slack message containing instructions rather than content.
The model reads it in the same context as the prompt's own directions, and the output is
prose a human is about to mail company-wide.

**Mitigations.** Instruction/data separation: the entire assembled item block is fenced
with `fenceUntrusted` before it reaches the prompt (`generator.ts:172`), and the
structural requirements — the five sections, their order, the hard rules — live in the
system prompt, which is ours. The `SanitizedSourceItem` brand guarantees the content
carries no PII, but explicitly says nothing about whether it carries instructions; the
fence is what addresses that. Five adversarial cases in the eval golden set exercise it
directly (`injection-direct-override`, `-fabricate-announcement`, `-structure-hijack`,
`-tag-smuggling`, `-contact-details`).

**Residual, and this is the honest one.** The real backstop is the human approval gate,
not the fence. An injection that produces *plausible* text — a fabricated but
unremarkable-sounding announcement — can survive both the fence and a reviewer skimming
a draft that looks normal. The eval measures a rate, not a guarantee. Anyone with commit
access to an aggregated repo, or posting rights in an aggregated Slack channel, is
inside this boundary.

### 3. Sensitive data reaching the model or the newsletter — Information disclosure (boundary 5, 6)

Source content contains compensation figures, HR case references, health information,
customer identifiers or credentials, and flows toward both a third-party model and a
company-wide email.

**Mitigations.** Redaction is type-enforced rather than remembered: a raw `SourceItem`
becomes a `SanitizedSourceItem` only by passing through `sanitizeSourceItem`, which
stamps a brand the type system cannot fabricate — so an aggregator that forgets to
sanitise fails to compile. `assertNoPii` runs again at two runtime checkpoints, on the
assembled prompt before the call and on the model's output. The catalogue is the vendored
org-wide one, so a class added upstream reaches every consumer.

**Residual.** The catalogue is pattern-based. A sensitive shape nobody has written a
class for passes both checkpoints, because both use the same catalogue — the second
checkpoint catches a *regression in the pipeline*, not a *gap in the patterns*. Two
checkpoints over one catalogue is defence in depth against wiring mistakes, not against
unknown formats.

### 4. Provider token compromise — Elevation of privilege (boundary 5, 7)

Four long-lived third-party credentials: a GitHub PAT, a Linear API key, a Notion
integration token, a Slack bot token. Each reads real internal data.

**Mitigations.** No static AWS credentials exist in the app — Pod Identity supplies them,
and secret reads are scoped by the operator to the tenant's own `digest-pipeline/<env>/`
prefix via `spec.identity.directSecretReads`, so a compromised pod cannot read another
tenant's secrets. Provider scopes are documented and minimal (`docs/slack-app-setup.md`
lists exactly four Slack scopes; the GitHub PAT is read-only). The Notion service verifies
every returned page's parent database against the configured one, so an over-scoped Notion
token cannot widen the aggregation surface.

**Residual.** The provider tokens themselves are long-lived and rotated manually; there
is no automatic expiry and no detection of a token being used from elsewhere. Rotation is
documented but human-triggered.

### 5. Audit ledger integrity — Repudiation (boundary 3)

The SOC 2 posture rests on `audit_events` answering "who approved what, and when". If the
ledger can be altered or silently fail, the control it evidences is gone.

**Mitigations.** Every write is awaited — there is no fire-and-forget path — and the
tests assert the awaiting, not only the content. The table is append-only in use, keyed
on `run_id`, with `event_type` constrained by a database CHECK that the data-layer tier
now exercises against a real engine. Derived facts are stamped once at the event rather
than recomputed from live text, so an edited draft cannot retroactively change its own
edit-rate history.

**Residual.** Integrity is enforced by convention and permission, not cryptography.
There is no hash chain, so an actor with direct database write access can alter or delete
rows without leaving evidence in the ledger itself. Detection would depend on
infrastructure-level audit rather than anything in this application.

## Threats deliberately accepted

Named so a reviewer can see they were considered rather than missed.

- **Runaway model spend.** Bounded by the `BudgetPolicy` CR (kill switch at 120% of USD
  2000), a gateway rate limit, one model call per weekly run, and `maxRetries: 0` on the
  SDK so the retry wrapper cannot multiply. Residual exposure is one week's runaway, not
  an unbounded bill.
- **Denial of service on the review UI.** The api is not routed publicly — the Ingress
  sends everything to web — and the audience is a handful of internal approvers. Rate
  limits exist on the mutating routes; there is no broader DoS engineering, deliberately.
- **A malicious operator.** Anyone who can deploy the chart or write the tenant's secrets
  can send. This is not defended against; it is the definition of the trust boundary.
- **Newsletter confidentiality in transit.** Recipients are internal and delivery is
  SES over TLS. There is no end-to-end encryption and none is intended.

## Keeping this honest

A threat model rots faster than code, so as much of this as possible is anchored to
something that fails. The adversarial eval cases fail loudly if the injection defence
regresses. The status-machine guards are asserted by the data-layer tests, including
against a real Postgres, so widening one is caught rather than reviewed. The per-file
100% coverage pins on `auth.ts`, both audit ledgers and `drafts.ts` mean an uncovered
branch on any of those paths fails the build.

Where a claim here is only prose, it is worth saying so plainly: the residual risks
above — particularly the PII catalogue's coverage against unknown formats, and ledger
integrity against an actor with direct database access — are assertions someone should
re-check, not controls anything enforces.

Revisit when a new aggregation source is added (it extends boundary 5), when the approval
flow changes shape, or when the model call stops being a single weekly invocation.
