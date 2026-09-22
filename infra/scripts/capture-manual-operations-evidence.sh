#!/bin/sh
set -eu

# Capture release-bound manual-operations evidence from real, read-only API
# observations. The caller cannot supply check results: this script derives all
# three pass rows from HTTP responses and writes the evidence exactly once.
: "${RELEASE_ID:?RELEASE_ID is required}"
: "${PRODUCTION_API_BASE_URL:?PRODUCTION_API_BASE_URL is required}"
: "${PRODUCTION_CANARY_BEARER_TOKEN:?PRODUCTION_CANARY_BEARER_TOKEN is required}"
: "${PRODUCTION_CANARY_WORKSPACE_ID:?PRODUCTION_CANARY_WORKSPACE_ID is required}"
: "${PRODUCTION_CANARY_ISOLATION_WORKSPACE_ID:?PRODUCTION_CANARY_ISOLATION_WORKSPACE_ID is required}"
: "${PRODUCTION_MANUAL_REPORT_ID:?PRODUCTION_MANUAL_REPORT_ID is required}"
: "${MANUAL_OPERATIONS_EVIDENCE_OUTPUT:?MANUAL_OPERATIONS_EVIDENCE_OUTPUT is required}"
: "${MANUAL_OPERATIONS_VERIFIED_BY:?MANUAL_OPERATIONS_VERIFIED_BY is required}"

case "$RELEASE_ID" in *[!A-Za-z0-9._-]*|'') echo 'RELEASE_ID contains unsafe characters' >&2; exit 1 ;; esac
case "$PRODUCTION_CANARY_WORKSPACE_ID:$PRODUCTION_CANARY_ISOLATION_WORKSPACE_ID" in *[!A-Za-z0-9._:-]*) echo 'workspace id contains unsafe characters' >&2; exit 1 ;; esac
[ "$PRODUCTION_CANARY_WORKSPACE_ID" != "$PRODUCTION_CANARY_ISOLATION_WORKSPACE_ID" ] || { echo 'isolation workspace must differ from the target workspace' >&2; exit 1; }
printf '%s' "$PRODUCTION_API_BASE_URL" | grep -Eq '^https://[^/?#]+/?$' || { echo 'PRODUCTION_API_BASE_URL must be an HTTPS origin' >&2; exit 1; }
[ "${MANUAL_OPERATIONS_EVIDENCE_OUTPUT#/}" != "$MANUAL_OPERATIONS_EVIDENCE_OUTPUT" ] || { echo 'evidence output must be absolute' >&2; exit 1; }
output_dir=$(dirname "$MANUAL_OPERATIONS_EVIDENCE_OUTPUT")
[ -d "$output_dir" ] && [ "$(CDPATH= cd -- "$output_dir" && pwd -P)" = "$output_dir" ] || { echo 'evidence output directory must be an existing canonical directory' >&2; exit 1; }
[ ! -e "$MANUAL_OPERATIONS_EVIDENCE_OUTPUT" ] && [ ! -L "$MANUAL_OPERATIONS_EVIDENCE_OUTPUT" ] || { echo 'evidence output already exists' >&2; exit 1; }

workdir=$(mktemp -d "${TMPDIR:-/tmp}/manual-operations-evidence.XXXXXX")
trap 'rm -rf "$workdir"' EXIT HUP INT TERM
origin=${PRODUCTION_API_BASE_URL%/}

curl --silent --show-error --max-time 20 --output "$workdir/release.json" --write-out '%{http_code}' \
  "$origin/releasez" >"$workdir/release.status"

rpc() {
  workspace=$1; body=$2; name=$3
  curl --silent --show-error --max-time 20 --output "$workdir/$name.json" --write-out '%{http_code}' \
    -H "authorization: Bearer $PRODUCTION_CANARY_BEARER_TOKEN" \
    -H "x-workspace-id: $workspace" -H 'content-type: application/json' \
    --data "$body" "$origin/mcp" >"$workdir/$name.status"
}

rpc "$PRODUCTION_CANARY_WORKSPACE_ID" \
  '{"jsonrpc":"2.0","id":"manual-evidence-list","method":"publish.manual.list","params":{"limit":"20","offset":"0"}}' target-list
rpc "$PRODUCTION_CANARY_WORKSPACE_ID" \
  "{\"jsonrpc\":\"2.0\",\"id\":\"manual-evidence-get\",\"method\":\"publish.manual.get\",\"params\":{\"manual_publish_report_id\":$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$PRODUCTION_MANUAL_REPORT_ID")}}" target-get
rpc "$PRODUCTION_CANARY_ISOLATION_WORKSPACE_ID" \
  '{"jsonrpc":"2.0","id":"manual-evidence-isolation","method":"publish.manual.list","params":{"limit":"1","offset":"0"}}' isolation

RELEASE_ID="$RELEASE_ID" TARGET_WORKSPACE="$PRODUCTION_CANARY_WORKSPACE_ID" \
ISOLATION_WORKSPACE="$PRODUCTION_CANARY_ISOLATION_WORKSPACE_ID" REPORT_ID="$PRODUCTION_MANUAL_REPORT_ID" \
VERIFIED_BY="$MANUAL_OPERATIONS_VERIFIED_BY" OUTPUT="$MANUAL_OPERATIONS_EVIDENCE_OUTPUT" WORKDIR="$workdir" \
node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const fail = message => { throw new Error(message); };
const read = name => JSON.parse(fs.readFileSync(path.join(process.env.WORKDIR, `${name}.json`), 'utf8'));
const status = name => Number(fs.readFileSync(path.join(process.env.WORKDIR, `${name}.status`), 'utf8'));
if (status('release') !== 200) fail('release identity endpoint did not return HTTP 200');
const release = read('release');
const releaseId = release.release_id ?? release.data?.release_id ?? release.data?.release?.release_id;
if (releaseId !== process.env.RELEASE_ID) fail('deployed release identity does not match RELEASE_ID');
if (status('target-list') !== 200 || status('target-get') !== 200) fail('target workspace manual evidence reads did not return HTTP 200');
const unwrap = value => value?.data?.result ?? value?.result;
const list = unwrap(read('target-list'));
const report = unwrap(read('target-get'));
if (!list || !Array.isArray(list.items) || !Number.isInteger(list.total)) fail('manual report list contract is invalid');
if (!report || report.id !== process.env.REPORT_ID) fail('expected manual report is not visible to the merchant');
if (!list.items.some(item => item?.id === process.env.REPORT_ID)) fail('expected manual report is absent from the tenant-scoped list');
const forbiddenStates = new Set(['platform_verified', 'published', 'remote_published']);
if (forbiddenStates.has(report.state) || report.evidenceBoundary === 'official_api' || report.official_api_receipt === true) fail('manual report claims official platform verification');
if (![401, 403].includes(status('isolation'))) fail('foreign workspace isolation probe was not rejected');
const isolation = read('isolation');
if (!isolation?.error) fail('foreign workspace isolation response lacks an error envelope');
const generated = new Date();
const evidence = {
  schema_version: 'manual-operations-evidence/1', release_id: process.env.RELEASE_ID,
  environment: 'production', workflow: 'public_import_manual_publish',
  workspace_id: process.env.TARGET_WORKSPACE, isolation_probe_workspace_id: process.env.ISOLATION_WORKSPACE,
  manual_publish_report_id: process.env.REPORT_ID, official_api_receipt: false,
  tenant_isolation_verified: true, simulated: false, generated_at: generated.toISOString(),
  expires_at: new Date(generated.getTime() + 24 * 60 * 60_000).toISOString(),
  verified_by: process.env.VERIFIED_BY,
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
