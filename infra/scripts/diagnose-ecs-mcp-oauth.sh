#!/bin/sh
# Run on the ECS host. Read-only; reports only key presence and safe mode flags.
set -eu

command -v docker >/dev/null 2>&1 || { echo 'OAuth ECS diagnosis blocked: docker_unavailable' >&2; exit 2; }
found=0
blocked=0
containers=$(docker ps --format '{{.Names}} {{.Image}}') || { echo 'OAuth ECS diagnosis blocked: docker_ps_failed' >&2; exit 2; }
while read -r container image; do
  case "$image" in
    local-api|local-api:*|store-nova-api|store-nova-api:*) ;;
    *) continue ;;
  esac
  found=1
  # Docker inspect emits full environment internally. awk prints only fixed labels,
  # never values for URLs, client IDs, callback URLs or credentials.
  status=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container" | awk -F= '
    $1 == "NODE_ENV" { production = ($2 == "production") }
    $1 == "MCP_OAUTH_REQUIRED" { required = ($2 == "true") }
    $1 == "MCP_OAUTH_CLIENTS" { clients = (length($2) > 2) }
    END { printf "production=%s required=%s clients=%s", production ? "yes" : "no", required ? "yes" : "no", clients ? "present" : "missing" }
  ') || { echo "OAuth ECS diagnosis blocked: inspect_failed ($container)" >&2; exit 2; }
  echo "$container $status"
  case "$status" in
    'production=yes required=yes clients=present') ;;
    *) blocked=1 ;;
  esac
done <<EOF
$containers
EOF
if [ "$found" -eq 0 ]; then echo 'OAuth ECS diagnosis blocked: api_container_missing' >&2; exit 1; fi
if [ "$blocked" -ne 0 ]; then echo 'OAuth ECS diagnosis blocked: api_oauth_config_missing_or_nonproduction' >&2; exit 1; fi
# The public negative probe remains the authoritative HTTP behavior check.
# This script intentionally does not claim that key presence means valid clients.
echo 'OAuth ECS diagnosis complete: key presence only; validate registry and real ChatGPT session separately.'
