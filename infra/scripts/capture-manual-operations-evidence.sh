#!/bin/sh
set -eu

# Capture release-bound manual-operations evidence from real, read-only API
# observations. The caller cannot supply check results: this script derives all
# three pass rows from HTTP responses and writes the evidence exactly once.
: "${RELEASE_ID:?RELEASE_ID is required}"
: "${PRODUCTION_CANARY_BEARER_TOKEN:?PRODUCTION_CANARY_BEARER_TOKEN is required}"
: "${PRODUCTION_CANARY_WORKSPACE_ID:?PRODUCTION_CANARY_WORKSPACE_ID is required}"
: "${PRODUCTION_CANARY_ISOLATION_WORKSPACE_ID:?PRODUCTION_CANARY_ISOLATION_WORKSPACE_ID is required}"
: "${PRODUCTION_MANUAL_REPORT_ID:?PRODUCTION_MANUAL_REPORT_ID is required}"
: "${MANUAL_OPERATIONS_EVIDENCE_OUTPUT:?MANUAL_OPERATIONS_EVIDENCE_OUTPUT is required}"
: "${MANUAL_OPERATIONS_VERIFIED_BY:?MANUAL_OPERATIONS_VERIFIED_BY is required}"
: "${MANUAL_OPERATIONS_EXPECTED_RELEASE_GIT_SHA:?expected release Git SHA is required}"
: "${MANUAL_OPERATIONS_EXPECTED_MANIFEST_SHA256:?expected manifest SHA-256 is required}"
: "${MANUAL_OPERATIONS_EXPECTED_IMAGE_SET_DIGEST:?expected image-set digest is required}"

case "$RELEASE_ID" in *[!A-Za-z0-9._-]*|'') echo 'RELEASE_ID contains unsafe characters' >&2; exit 1 ;; esac
case "$PRODUCTION_CANARY_WORKSPACE_ID:$PRODUCTION_CANARY_ISOLATION_WORKSPACE_ID" in *[!A-Za-z0-9._:-]*) echo 'workspace id contains unsafe characters' >&2; exit 1 ;; esac
[ "$PRODUCTION_CANARY_WORKSPACE_ID" != "$PRODUCTION_CANARY_ISOLATION_WORKSPACE_ID" ] || { echo 'isolation workspace must differ from the target workspace' >&2; exit 1; }
printf '%s' "$MANUAL_OPERATIONS_EXPECTED_RELEASE_GIT_SHA" | grep -Eq '^[a-f0-9]{40}$' || { echo 'expected release Git SHA is invalid' >&2; exit 1; }
printf '%s' "$MANUAL_OPERATIONS_EXPECTED_MANIFEST_SHA256" | grep -Eq '^[a-f0-9]{64}$' || { echo 'expected manifest SHA-256 is invalid' >&2; exit 1; }
printf '%s' "$MANUAL_OPERATIONS_EXPECTED_IMAGE_SET_DIGEST" | grep -Eq '^sha256:[a-f0-9]{64}$' || { echo 'expected image-set digest is invalid' >&2; exit 1; }
if [ -n "${MANUAL_OPERATIONS_CANDIDATE_API_BASE_URL:-}" ]; then
  echo 'candidate loopback URL mode is disabled; use the exact Docker container transport' >&2
  exit 1
fi
if [ -n "${MANUAL_OPERATIONS_CANDIDATE_CONTAINER_ID:-}" ]; then
  candidate_mode=true
  : "${MANUAL_OPERATIONS_CANDIDATE_API_IMAGE_REF:?candidate immutable API image reference is required}"
  printf '%s' "$MANUAL_OPERATIONS_CANDIDATE_CONTAINER_ID" | grep -Eq '^[0-9a-f]{64}$' || { echo 'candidate container ID must be a full Docker ID' >&2; exit 1; }
  : "${MANUAL_OPERATIONS_EXPECTED_RELEASE_GIT_SHA:?candidate Git SHA is required}"
  : "${MANUAL_OPERATIONS_EXPECTED_MANIFEST_SHA256:?candidate manifest SHA-256 is required}"
  : "${MANUAL_OPERATIONS_EXPECTED_IMAGE_SET_DIGEST:?candidate image-set digest is required}"
  printf '%s' "$MANUAL_OPERATIONS_EXPECTED_RELEASE_GIT_SHA" | grep -Eq '^[0-9a-f]{40}$' || { echo 'candidate Git SHA is invalid' >&2; exit 1; }
  printf '%s' "$MANUAL_OPERATIONS_EXPECTED_MANIFEST_SHA256" | grep -Eq '^[0-9a-f]{64}$' || { echo 'candidate manifest SHA-256 is invalid' >&2; exit 1; }
  printf '%s' "$MANUAL_OPERATIONS_EXPECTED_IMAGE_SET_DIGEST" | grep -Eq '^sha256:[0-9a-f]{64}$' || { echo 'candidate image-set digest is invalid' >&2; exit 1; }
  candidate_helper=$(CDPATH='' cd -- "$(dirname "$0")" && pwd -P)/candidate-api-docker-request.mjs
  [ -f "$candidate_helper" ] || { echo 'candidate Docker request helper is missing' >&2; exit 1; }
else
  candidate_mode=false
  : "${PRODUCTION_API_BASE_URL:?PRODUCTION_API_BASE_URL is required}"
  printf '%s' "$PRODUCTION_API_BASE_URL" | grep -Eq '^https://[^/?#]+/?$' || { echo 'PRODUCTION_API_BASE_URL must be an HTTPS origin' >&2; exit 1; }
  origin=${PRODUCTION_API_BASE_URL%/}
fi
[ "${MANUAL_OPERATIONS_EVIDENCE_OUTPUT#/}" != "$MANUAL_OPERATIONS_EVIDENCE_OUTPUT" ] || { echo 'evidence output must be absolute' >&2; exit 1; }
output_dir=$(dirname "$MANUAL_OPERATIONS_EVIDENCE_OUTPUT")
[ -d "$output_dir" ] && [ "$(CDPATH= cd -- "$output_dir" && pwd -P)" = "$output_dir" ] || { echo 'evidence output directory must be an existing canonical directory' >&2; exit 1; }
[ ! -e "$MANUAL_OPERATIONS_EVIDENCE_OUTPUT" ] && [ ! -L "$MANUAL_OPERATIONS_EVIDENCE_OUTPUT" ] || { echo 'evidence output already exists' >&2; exit 1; }

workdir=$(mktemp -d "${TMPDIR:-/tmp}/manual-operations-evidence.XXXXXX")
chmod 700 "$workdir"
trap 'rm -rf "$workdir"' EXIT HUP INT TERM
capture_http() {
  curl -q --proto '=https' --silent --show-error --max-time 20 "$@"
}
capture_candidate() {
  name=$1; workspace=$2; body=$3
  if [ "$name" = release ]; then
    printf '{}' | NODE_OPTIONS= node "$candidate_helper" "$MANUAL_OPERATIONS_CANDIDATE_CONTAINER_ID" "$MANUAL_OPERATIONS_CANDIDATE_API_IMAGE_REF" /releasez "$name" "$workdir"
  else
    CANDIDATE_WORKSPACE="$workspace" CANDIDATE_BODY="$body" NODE_OPTIONS= node -e \
      'process.stdout.write(JSON.stringify({token:process.env.PRODUCTION_CANARY_BEARER_TOKEN,workspace:process.env.CANDIDATE_WORKSPACE,body:process.env.CANDIDATE_BODY}))' \
      | NODE_OPTIONS= node "$candidate_helper" "$MANUAL_OPERATIONS_CANDIDATE_CONTAINER_ID" "$MANUAL_OPERATIONS_CANDIDATE_API_IMAGE_REF" /mcp "$name" "$workdir"
  fi
}

if [ "$candidate_mode" = true ]; then
  capture_candidate release '' ''
else
  capture_http --output "$workdir/release.json" --write-out '%{http_code}' \
    "$origin/releasez" >"$workdir/release.status"
fi

# Authenticate the running candidate's immutable identity before the first
# Bearer-bearing request. A wrong listener must never receive the canary token.
RELEASE_ID="$RELEASE_ID" WORKDIR="$workdir" CANDIDATE_MODE="$candidate_mode" \
EXPECTED_GIT_SHA="$MANUAL_OPERATIONS_EXPECTED_RELEASE_GIT_SHA" \
EXPECTED_MANIFEST_SHA256="$MANUAL_OPERATIONS_EXPECTED_MANIFEST_SHA256" \
EXPECTED_IMAGE_SET_DIGEST="$MANUAL_OPERATIONS_EXPECTED_IMAGE_SET_DIGEST" \
node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const fail = message => { throw new Error(message); };
const workdir = process.env.WORKDIR;
if (fs.readFileSync(path.join(workdir, 'release.status'), 'utf8') !== '200') fail('release identity endpoint did not return HTTP 200');
let body;
try { body = JSON.parse(fs.readFileSync(path.join(workdir, 'release.json'), 'utf8')); }
catch { fail('release identity endpoint returned invalid JSON'); }
const identity = body?.data?.release ?? body?.release;
if (identity?.release_id !== process.env.RELEASE_ID) fail('API release identity does not match RELEASE_ID');
if (identity?.release_git_sha !== process.env.EXPECTED_GIT_SHA
  || identity?.manifest_sha256 !== process.env.EXPECTED_MANIFEST_SHA256
  || identity?.image_set_digest !== process.env.EXPECTED_IMAGE_SET_DIGEST
  || body?.data?.ready !== true) fail('API release identity or readiness does not match the expected image set');
NODE

if [ "$candidate_mode" = false ]; then
  auth_header="$workdir/authorization.header"
  (umask 077; printf 'authorization: Bearer %s\n' "$PRODUCTION_CANARY_BEARER_TOKEN" >"$auth_header")
  chmod 600 "$auth_header"
fi

rpc() {
  workspace=$1; body=$2; name=$3
  if [ "$candidate_mode" = true ]; then
    capture_candidate "$name" "$workspace" "$body"
  else
    capture_http --output "$workdir/$name.json" --write-out '%{http_code}' \
      -H "@$auth_header" \
      -H "x-workspace-id: $workspace" -H 'content-type: application/json' \
      --data "$body" "$origin/mcp" >"$workdir/$name.status"
  fi
}

page_offset=0
while :; do
  rpc "$PRODUCTION_CANARY_WORKSPACE_ID" \
    "{\"jsonrpc\":\"2.0\",\"id\":\"manual-evidence-list\",\"method\":\"publish.manual.list\",\"params\":{\"limit\":\"20\",\"offset\":\"$page_offset\"}}" target-list
  page_result=$(WORKDIR="$workdir" REPORT_ID="$PRODUCTION_MANUAL_REPORT_ID" PAGE_OFFSET="$page_offset" node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.WORKDIR;
const fail = message => { throw new Error(message); };
if (fs.readFileSync(path.join(dir, 'target-list.status'), 'utf8') !== '200') fail('manual report list did not return HTTP 200');
const response = JSON.parse(fs.readFileSync(path.join(dir, 'target-list.json'), 'utf8'));
const list = response?.data?.result ?? response?.result;
const offset = Number(process.env.PAGE_OFFSET);
if (!list || !Array.isArray(list.items) || !Number.isSafeInteger(list.total) || list.total < 0
  || Number(list.offset) !== offset || list.items.length < 1 || list.items.length > 20
  || offset + list.items.length > list.total
  || (offset + list.items.length < list.total && list.items.length !== 20)) fail('manual report pagination contract is invalid');
process.stdout.write(list.items.some(item => item?.id === process.env.REPORT_ID) ? 'found' : offset + list.items.length >= list.total ? 'absent' : 'next');
NODE
  )
  case "$page_result" in
    found) break ;;
    absent) echo 'expected manual report is absent from the tenant-scoped list' >&2; exit 1 ;;
    next) page_offset=$((page_offset + 20)) ;;
    *) echo 'manual report pagination returned an invalid result' >&2; exit 1 ;;
  esac
done
rpc "$PRODUCTION_CANARY_WORKSPACE_ID" \
  "{\"jsonrpc\":\"2.0\",\"id\":\"manual-evidence-get\",\"method\":\"publish.manual.get\",\"params\":{\"manual_publish_report_id\":$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$PRODUCTION_MANUAL_REPORT_ID")}}" target-get
rpc "$PRODUCTION_CANARY_ISOLATION_WORKSPACE_ID" \
  '{"jsonrpc":"2.0","id":"manual-evidence-isolation","method":"publish.manual.list","params":{"limit":"1","offset":"0"}}' isolation

RELEASE_ID="$RELEASE_ID" TARGET_WORKSPACE="$PRODUCTION_CANARY_WORKSPACE_ID" \
ISOLATION_WORKSPACE="$PRODUCTION_CANARY_ISOLATION_WORKSPACE_ID" REPORT_ID="$PRODUCTION_MANUAL_REPORT_ID" \
VERIFIED_BY="$MANUAL_OPERATIONS_VERIFIED_BY" OUTPUT="$MANUAL_OPERATIONS_EVIDENCE_OUTPUT" WORKDIR="$workdir" \
CANDIDATE_MODE="$candidate_mode" \
EXPECTED_GIT_SHA="${MANUAL_OPERATIONS_EXPECTED_RELEASE_GIT_SHA:-}" \
EXPECTED_MANIFEST_SHA256="${MANUAL_OPERATIONS_EXPECTED_MANIFEST_SHA256:-}" \
EXPECTED_IMAGE_SET_DIGEST="${MANUAL_OPERATIONS_EXPECTED_IMAGE_SET_DIGEST:-}" \
node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const fail = message => { throw new Error(message); };
const read = name => JSON.parse(fs.readFileSync(path.join(process.env.WORKDIR, `${name}.json`), 'utf8'));
const status = name => Number(fs.readFileSync(path.join(process.env.WORKDIR, `${name}.status`), 'utf8'));
if (status('release') !== 200) fail('release identity endpoint did not return HTTP 200');
const release = read('release');
const releaseId = release.release_id ?? release.data?.release_id ?? release.data?.release?.release_id;
if (releaseId !== process.env.RELEASE_ID) fail('deployed release identity does not match RELEASE_ID');
const identity = release.data?.release ?? release.release;
if (!identity || identity.release_git_sha !== process.env.EXPECTED_GIT_SHA
  || identity.manifest_sha256 !== process.env.EXPECTED_MANIFEST_SHA256
  || identity.image_set_digest !== process.env.EXPECTED_IMAGE_SET_DIGEST
  || release.data?.ready !== true) fail('API release identity or readiness does not match the expected image set');
if (status('target-list') !== 200 || status('target-get') !== 200) fail('target workspace manual evidence reads did not return HTTP 200');
const unwrap = value => value?.data?.result ?? value?.result;
const list = unwrap(read('target-list'));
const report = unwrap(read('target-get'));
if (!list || !Array.isArray(list.items) || !Number.isInteger(list.total)) fail('manual report list contract is invalid');
if (!report || report.id !== process.env.REPORT_ID) fail('expected manual report is not visible to the merchant');
if (!list.items.some(item => item?.id === process.env.REPORT_ID)) fail('expected manual report is absent from the tenant-scoped list');
if (report.evidenceBoundary !== 'manual_unverified') fail('manual report is not explicitly in the manual_unverified evidence boundary');
if (!['manual_publish_in_progress', 'manual_publish_reported', 'manual_review_required'].includes(report.state)) fail('manual report state is not a recognized manual workflow state');
if (report.official_api_receipt === true) fail('manual report claims an official platform receipt');
if (![401, 403].includes(status('isolation'))) fail('foreign workspace isolation probe was not rejected');
const isolation = read('isolation');
const isolationError = isolation?.error;
if (!isolationError || typeof isolationError !== 'object' || Array.isArray(isolationError)
  || Object.getPrototypeOf(isolationError) !== Object.prototype || typeof isolationError.code !== 'string' || !isolationError.code.trim()) {
  fail('foreign workspace isolation response lacks a structured non-empty error code');
}
const generated = new Date();
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const observed = (name, probeName, material) => {
  const probe = { name, status: status(probeName), material };
  return { ...probe, observation_sha256: sha256(Buffer.from(canonical(probe))) };
};
const journal = {
  schema_version: 'manual-operations-capture-journal/1',
  captured_at: generated.toISOString(),
  candidate_identity: {
    release_id: process.env.RELEASE_ID,
    release_git_sha: process.env.EXPECTED_GIT_SHA,
    manifest_sha256: process.env.EXPECTED_MANIFEST_SHA256,
    image_set_digest: process.env.EXPECTED_IMAGE_SET_DIGEST,
  },
  observations: [
    observed('release', 'release', {
      release_id: identity.release_id, release_git_sha: identity.release_git_sha, manifest_sha256: identity.manifest_sha256,
      image_set_digest: identity.image_set_digest, ready: release.data?.ready === true,
    }),
    observed('target_list', 'target-list', { expected_report_visible: true, visible_report_id: process.env.REPORT_ID, total: list.total, returned_count: list.items.length }),
    observed('target_get', 'target-get', { manual_publish_report_id: report.id, state: report.state, evidence_boundary: report.evidenceBoundary }),
    observed('isolation', 'isolation', { error_envelope: true, code_present: true }),
  ],
};
const evidence = {
  schema_version: 'manual-operations-evidence/1', release_id: process.env.RELEASE_ID,
  environment: 'production', workflow: 'public_import_manual_publish',
  workspace_id: process.env.TARGET_WORKSPACE, isolation_probe_workspace_id: process.env.ISOLATION_WORKSPACE,
  manual_publish_report_id: process.env.REPORT_ID, official_api_receipt: false,
  manual_evidence_boundary: report.evidenceBoundary, manual_publish_state: report.state,
  tenant_isolation_verified: true, simulated: false, generated_at: generated.toISOString(),
  expires_at: new Date(generated.getTime() + 24 * 60 * 60_000).toISOString(),
  verified_by: process.env.VERIFIED_BY,
  capture_journal: journal, capture_journal_sha256: sha256(Buffer.from(canonical(journal))),
  checks: [
    { name: 'tenant_scope', status: 'pass', observation: 'foreign_workspace_rejected' },
    { name: 'manual_report', status: 'pass', observation: 'human_evidence_boundary_preserved' },
    { name: 'merchant_visibility', status: 'pass', observation: 'expected_report_visible' },
  ],
};
const fd = fs.openSync(process.env.OUTPUT, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
try { fs.writeFileSync(fd, `${JSON.stringify(evidence, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
NODE

echo "manual operations evidence captured: release_id=$RELEASE_ID workspace_id=$PRODUCTION_CANARY_WORKSPACE_ID output=$MANUAL_OPERATIONS_EVIDENCE_OUTPUT"
