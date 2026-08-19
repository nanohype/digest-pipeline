#!/usr/bin/env bash
#
# One-shot seeder for a DigestPipeline environment's Secrets Manager payload.
#
# Reads a single JSON file (see secrets.template.json for the shape), then for
# each top-level key writes the value as a JSON string to Secrets Manager at
# `digest-pipeline/${env}/${key}`. Robust against both states a secret can be in:
#   - already exists  → put-secret-value
#   - not yet created → create-secret
#
# Safety rails:
#   - Any value containing the sentinel `REPLACE_ME` aborts the run before
#     a single API call goes out — guards against a half-filled template.
#   - `--dry-run` lists what would be written without calling AWS.
#   - Never logs secret values. Only key names + AWS action.
#   - One convenience field auto-derives when left empty:
#       * web-config.cookiePassword  → openssl rand -base64 48 (≥32 chars)
#
# Usage:
#   scripts/seed-secrets.sh --env staging     --file digest-pipeline-secrets.staging.json
#   scripts/seed-secrets.sh --env production  --file digest-pipeline-secrets.production.json
#   scripts/seed-secrets.sh --env staging     --file ... --dry-run
#
# Defaults: --region us-east-1, --file digest-pipeline-secrets.${env}.json
#
# us-east-1 is not a preference. Every venture account sits under an SCP that
# denies any regional call outside it, so a seeding run against another region
# fails with an explicit deny rather than a missing-permission error — and it
# fails while an operator is already mid-incident trying to fix something.
#
# Requires: aws CLI (with creds that can put/create secrets), jq, base64, openssl.
#
# Note: digest-pipeline/${env}/db-credentials is managed by the landing-zone
# tenant-substrate rds-aurora module — this seeder does not touch it.

set -euo pipefail

ENVIRONMENT=""
FILE=""
REGION="${AWS_REGION:-us-east-1}"
DRY_RUN=0

usage() {
  cat <<EOF
Usage: $0 --env {staging|production} [--file PATH] [--region REGION] [--dry-run]

Seeds all 9 operator-provisioned DigestPipeline secrets for the named environment
from a JSON file. See secrets.template.json for the file shape.
EOF
  exit "${1:-1}"
}

while (( $# > 0 )); do
  case "$1" in
    --env)     ENVIRONMENT="${2:?missing value for --env}"; shift 2 ;;
    --file)    FILE="${2:?missing value for --file}"; shift 2 ;;
    --region)  REGION="${2:?missing value for --region}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage 0 ;;
    *)         printf 'unknown flag: %s\n' "$1" >&2; usage 1 ;;
  esac
done

[[ "$ENVIRONMENT" == "staging" || "$ENVIRONMENT" == "production" ]] \
  || { printf '[seed] --env must be "staging" or "production" (got "%s")\n' "$ENVIRONMENT" >&2; exit 1; }
[[ -z "$FILE" ]] && FILE="digest-pipeline-secrets.${ENVIRONMENT}.json"
[[ -f "$FILE" ]] || { printf '[seed] file not found: %s\n' "$FILE" >&2; exit 1; }
command -v jq      >/dev/null || { printf '[seed] jq required\n'      >&2; exit 1; }
command -v base64  >/dev/null || { printf '[seed] base64 required\n'  >&2; exit 1; }
command -v openssl >/dev/null || { printf '[seed] openssl required\n' >&2; exit 1; }

log()  { printf '[seed] %s\n' "$*"; }
die()  { printf '[seed] FAIL: %s\n' "$*" >&2; exit 1; }
ok()   { printf '[seed] OK  : %s\n' "$*"; }

# The canonical list of secret paths DigestPipeline expects. Must stay in lockstep
# with `secrets.template.json` keys, the `remoteRef` keys in the chart's
# `externalsecret.yaml`, and the inventory in `docs/secrets.md`.
# db-credentials is excluded — the landing-zone tenant-substrate rds-aurora
# module creates and owns it alongside the Aurora cluster.
REQUIRED_KEYS=(
  "approvers"
  "workos-directory"
  "github"
  "linear"
  "slack"
  "notion"
  "web-config"
  "runtime-config"
)

log "env=$ENVIRONMENT region=$REGION file=$FILE dry_run=$DRY_RUN"

# ── 1. Validate shape ───────────────────────────────────────────────────────
jq empty "$FILE" 2>/dev/null || die "$FILE is not valid JSON"

missing=()
for k in "${REQUIRED_KEYS[@]}"; do
  if [[ "$(jq --arg k "$k" 'has($k)' "$FILE")" != "true" ]]; then
    missing+=("$k")
  fi
done
if (( ${#missing[@]} > 0 )); then
  printf '[seed] FAIL: %s is missing required keys:\n' "$FILE" >&2
  printf '         - %s\n' "${missing[@]}" >&2
  exit 1
fi

# Reject any REPLACE_ME sentinel anywhere in the file (every leaf, every
# nested object). `jq .. | select(type=="string")` walks the whole tree.
if jq -r '.. | select(type == "string")' "$FILE" | grep -q 'REPLACE_ME'; then
  die "$FILE still contains 'REPLACE_ME' placeholder(s) — fill them in before seeding"
fi

# ── 2. Auto-derive convenience fields ───────────────────────────────────────
# Build a working copy so we can mutate the payload without touching the
# operator's source file. Everything downstream reads from $working.
working="$(mktemp -t digest-pipeline-seed-working.XXXXXX)"
trap 'rm -f "$working" "${PAYLOAD_FILE:-}"' EXIT
cp "$FILE" "$working"

# web-config.cookiePassword — AuthKit requires ≥32 chars. Auto-generate if
# left empty by the operator.
cookie_password="$(jq -r '."web-config".cookiePassword // ""' "$working")"
if [[ -z "$cookie_password" ]]; then
  # 48 base64 chars = 36 bytes of entropy → well above the 32-char floor.
  cookie_password="$(openssl rand -base64 48 | tr -d '\n/+=' | cut -c1-48)"
  jq --arg v "$cookie_password" '."web-config".cookiePassword = $v' "$working" > "${working}.new" \
    && mv "${working}.new" "$working"
  log "web-config.cookiePassword: auto-generated (${#cookie_password} chars)"
fi

# ── 3. Seed loop ────────────────────────────────────────────────────────────
PAYLOAD_FILE="$(mktemp -t digest-pipeline-seed-payload.XXXXXX)"

put_or_create() {
  local id="$1" value_file="$2"
  if aws secretsmanager describe-secret --region "$REGION" --secret-id "$id" \
       --query 'ARN' --output text >/dev/null 2>&1; then
    aws secretsmanager put-secret-value \
      --region "$REGION" \
      --secret-id "$id" \
      --secret-string "file://$value_file" \
      --query 'VersionId' --output text >/dev/null
    ok "put:    $id"
  else
    aws secretsmanager create-secret \
      --region "$REGION" \
      --name "$id" \
      --secret-string "file://$value_file" \
      --description "DigestPipeline ${ENVIRONMENT} — seeded by scripts/seed-secrets.sh" \
      --query 'ARN' --output text >/dev/null
    ok "create: $id"
  fi
}

for k in "${REQUIRED_KEYS[@]}"; do
  id="digest-pipeline/${ENVIRONMENT}/${k}"
  # Every value is a JSON object/array — serialize compactly for the secret string.
  payload="$(jq -c --arg k "$k" '.[$k]' "$working")"
  [[ -n "$payload" && "$payload" != "null" ]] || die "$k has empty value in $FILE"
  if (( DRY_RUN == 1 )); then
    fields="$(jq -r 'if type == "object" then (keys | join(", ")) else "<" + type + ">" end' <<<"$payload")"
    log "DRY : $id (fields: $fields)"
    continue
  fi
  printf '%s' "$payload" > "$PAYLOAD_FILE"
  put_or_create "$id" "$PAYLOAD_FILE"
done

log "seeded ${#REQUIRED_KEYS[@]} secrets for ${ENVIRONMENT}"
if (( DRY_RUN == 0 )); then
  log "next: the ExternalSecret syncs these into the in-cluster Secret — apply platform.yaml, then let ArgoCD reconcile the chart (helm template/lint locally to preview)"
fi
