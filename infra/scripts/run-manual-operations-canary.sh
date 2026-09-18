#!/bin/sh
set -eu

: "${PRODUCTION_API_BASE_URL:?PRODUCTION_API_BASE_URL is required}"
: "${PRODUCTION_CANARY_BEARER_TOKEN:?PRODUCTION_CANARY_BEARER_TOKEN is required}"
: "${PRODUCTION_CANARY_WORKSPACE_ID:?PRODUCTION_CANARY_WORKSPACE_ID is required}"

response=$(curl --fail --silent --show-error --max-time 20 \
  -H "authorization: Bearer $PRODUCTION_CANARY_BEARER_TOKEN" \
  -H "x-workspace-id: $PRODUCTION_CANARY_WORKSPACE_ID" \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":"manual-operations-canary","method":"publish.manual.list","params":{"limit":"1","offset":"0"}}' \
  "${PRODUCTION_API_BASE_URL%/}/mcp")

node -e '
const body = JSON.parse(require("fs").readFileSync(0, "utf8"));
const result = body?.data?.result ?? body?.result;
if (!result || !Array.isArray(result.items) || !Number.isInteger(result.total)) {
  throw new Error("manual operations canary did not return the tenant-scoped publish.manual.list contract");
}
if (result.items.some(item => item?.state === "platform_verified" || item?.evidenceBoundary === "official_api")) {
  throw new Error("manual operations canary observed a manual report presented as official platform evidence");
}
' <<EOF
$response
EOF

echo "manual operations canary passed: workspace=$PRODUCTION_CANARY_WORKSPACE_ID"
