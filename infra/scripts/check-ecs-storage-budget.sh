#!/bin/sh
set -eu

# Read-only deployment disk gate and rollback image protection inventory.
: "${ECS_STORAGE_PATH:=/}"
: "${ECS_STORAGE_HIGH_WATERMARK_PERCENT:=80}"
: "${ECS_STORAGE_MIN_FREE_GB:=15}"
: "${ECS_STORAGE_PROJECTED_GB:=8}"
: "${ECS_REGISTRY_URL:=http://127.0.0.1:5000}"

for value in "$ECS_STORAGE_HIGH_WATERMARK_PERCENT" "$ECS_STORAGE_MIN_FREE_GB" "$ECS_STORAGE_PROJECTED_GB"; do
  printf '%s' "$value" | grep -Eq '^[0-9]+$' || { echo 'storage thresholds must be non-negative integers' >&2; exit 2; }
done
[ "$ECS_STORAGE_HIGH_WATERMARK_PERCENT" -ge 50 ] && [ "$ECS_STORAGE_HIGH_WATERMARK_PERCENT" -le 95 ] || { echo 'high watermark must be between 50 and 95 percent' >&2; exit 2; }

line=$(df -Pk "$ECS_STORAGE_PATH" | awk 'NR==2 {print $2, $3, $4}')
set -- $line
[ "$#" = 3 ] || { echo 'unable to read filesystem capacity' >&2; exit 2; }
total_kb=$1 used_kb=$2 free_kb=$3
projected_kb=$((ECS_STORAGE_PROJECTED_GB * 1024 * 1024))
reserve_kb=$((ECS_STORAGE_MIN_FREE_GB * 1024 * 1024))
projected_percent=$(((used_kb + projected_kb) * 100 / total_kb))

scratch=$(mktemp -d "${TMPDIR:-/tmp}/ecs-storage-gate.XXXXXXXX")
trap 'rm -rf -- "$scratch"' EXIT HUP INT TERM
: > "$scratch/protected-digests"
: > "$scratch/registry-repositories"

add_json_digests() {
  path=$1
  [ -n "$path" ] && [ -f "$path" ] && [ ! -L "$path" ] || return 0
  node -e 'const fs=require("fs"); const walk=x=>{if(typeof x==="string"&&/^sha256:[0-9a-f]{64}$/.test(x))console.log(x); else if(x&&typeof x==="object")Object.values(x).forEach(walk)}; walk(JSON.parse(fs.readFileSync(process.argv[1],"utf8")))' "$path" >> "$scratch/protected-digests"
}
add_json_digests "${IMAGE_DIGESTS_JSON:-}"
add_json_digests "${ECS_ROLLBACK_IMAGE_DIGESTS_JSON:-}"

if command -v docker >/dev/null 2>&1; then
  for container in $(docker ps -aq 2>/dev/null || true); do
    docker inspect --format '{{.Image}} {{.Config.Image}}' "$container" 2>/dev/null | grep -Eo 'sha256:[0-9a-f]{64}' >> "$scratch/protected-digests" || true
    image=$(docker inspect --format '{{.Config.Image}}' "$container" 2>/dev/null || true)
    [ -n "$image" ] || continue
    docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image" 2>/dev/null | grep -Eo 'sha256:[0-9a-f]{64}' >> "$scratch/protected-digests" || true
  done
fi
sort -u "$scratch/protected-digests" -o "$scratch/protected-digests"

# Registry inventory is intentionally report-only. Manifest deletion and GC
# require a maintenance window and a separately reviewed protected digest set.
if command -v curl >/dev/null 2>&1; then
  curl -fsS --max-time 5 "${ECS_REGISTRY_URL%/}/v2/_catalog" 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{try{for(const x of JSON.parse(s).repositories||[])if(typeof x==="string")console.log(x)}catch{}})' \
    > "$scratch/registry-repositories" || true
fi

status=passed
reason=within_budget
if [ "$projected_percent" -ge "$ECS_STORAGE_HIGH_WATERMARK_PERCENT" ]; then status=blocked; reason=projected_high_watermark; fi
if [ "$free_kb" -lt $((projected_kb + reserve_kb)) ]; then status=blocked; reason=insufficient_free_space; fi

TOTAL_KB=$total_kb USED_KB=$used_kb FREE_KB=$free_kb PROJECTED_PERCENT=$projected_percent STATUS=$status REASON=$reason \
HIGH=$ECS_STORAGE_HIGH_WATERMARK_PERCENT RESERVE_GB=$ECS_STORAGE_MIN_FREE_GB PROJECTED_GB=$ECS_STORAGE_PROJECTED_GB \
DIGESTS="$scratch/protected-digests" REPOSITORIES="$scratch/registry-repositories" node <<'NODE'
const fs = require('fs')
const lines = path => fs.readFileSync(path, 'utf8').split(/\n/).filter(Boolean)
const report = {
  schema_version: 1,
  status: process.env.STATUS,
  reason: process.env.REASON,
  filesystem: { path: process.env.ECS_STORAGE_PATH || '/', total_kb: +process.env.TOTAL_KB, used_kb: +process.env.USED_KB, free_kb: +process.env.FREE_KB },
  policy: { high_watermark_percent: +process.env.HIGH, minimum_free_gb: +process.env.RESERVE_GB, projected_deploy_gb: +process.env.PROJECTED_GB, projected_used_percent: +process.env.PROJECTED_PERCENT },
  protected_image_digests: lines(process.env.DIGESTS),
  registry: { url: process.env.ECS_REGISTRY_URL || 'http://127.0.0.1:5000', repositories: lines(process.env.REPOSITORIES), deletion_performed: false, gc_performed: false },
}
const value = JSON.stringify(report, null, 2) + '\n'
if (process.env.ECS_STORAGE_REPORT_PATH) fs.writeFileSync(process.env.ECS_STORAGE_REPORT_PATH, value, { flag: 'wx', mode: 0o600 })
process.stdout.write(value)
NODE

[ "$status" = passed ] || exit 1
