#!/bin/sh
set -eu

# Explicit local-only demo profile. Never use this profile for staging or
# production: it enables the fixture bridge and a demo workspace so the full
# ChatGPT/MCP conversation can be exercised without a merchant subscription.
export MERCHANT_MCP_BASE_URL=${MERCHANT_MCP_BASE_URL:-http://127.0.0.1:8787}
export MERCHANT_MCP_TOKEN=${MERCHANT_MCP_TOKEN:-workspace-local-token}
export MERCHANT_WORKSPACE_ID=${MERCHANT_WORKSPACE_ID:-ws_demo}
export MERCHANT_ALLOW_FIXTURE_FALLBACK=true
export MERCHANT_STRICT_AUTH=false
export MERCHANT_MCP_WRITE_ENABLED=false

exec sh scripts/start-local-with-relay.sh "$@"
