#!/bin/sh
set -eu

# Browser suites may target a separately deployed URL. Only auto-start the
# repository's local stack when the caller kept the documented defaults.
merchant_url=${MERCHANT_STUDIO_URL:-http://127.0.0.1:18081/}
ops_url=${OPS_BASE_URL:-${OPS_CONSOLE_URL:-http://127.0.0.1:18082/}}
if [ "$merchant_url" != 'http://127.0.0.1:18081/' ] || [ "$ops_url" != 'http://127.0.0.1:18082/' ]; then
  exit 0
fi

merchant_ok=0
ops_ok=0
curl -fsS --max-time 2 "$merchant_url" >/dev/null 2>&1 && merchant_ok=1 || true
curl -fsS --max-time 2 "$ops_url" >/dev/null 2>&1 && ops_ok=1 || true
if [ "$merchant_ok" -eq 1 ] && [ "$ops_ok" -eq 1 ]; then
  exit 0
fi

docker compose --env-file .env -f infra/local/docker-compose.yml up -d api ui ops-ui >/dev/null
for url in "$merchant_url" "$ops_url"; do
  ready=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then ready=1; break; fi
    sleep 1
  done
  [ "$ready" -eq 1 ] || { echo "local browser service is not ready: $url" >&2; exit 1; }
done
