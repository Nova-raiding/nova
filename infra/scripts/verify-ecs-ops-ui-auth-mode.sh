#!/bin/sh
set -eu

[ "$#" -eq 2 ] || { echo 'usage: verify-ecs-ops-ui-auth-mode.sh <immutable-ops-ui-image> <password|oidc>' >&2; exit 2; }
image_ref=$1
expected_mode=$2
case "$expected_mode" in password|oidc) ;; *) echo 'OPS_AUTH_MODE must be password or oidc' >&2; exit 2 ;; esac
case "$image_ref" in
  *@sha256:*)
    printf '%s\n' "${image_ref##*@}" | grep -Eq '^sha256:[0-9a-f]{64}$' || { echo 'ops UI image reference has an invalid digest' >&2; exit 1; }
    ;;
  *) echo 'ops UI image must be an immutable repository@sha256 reference' >&2; exit 1 ;;
esac
command -v docker >/dev/null 2>&1 || { echo 'Docker CLI is required to verify ops UI image auth mode' >&2; exit 1; }
actual_mode=$(docker image inspect --format '{{index .Config.Labels "com.storenova.ops.auth_mode"}}' "$image_ref") || {
  echo 'cannot inspect the pinned ops UI image; pull it before preflight' >&2; exit 1;
}
[ "$actual_mode" = "$expected_mode" ] || {
  echo "ops UI image auth mode does not match OPS_AUTH_MODE (image=$actual_mode runtime=$expected_mode)" >&2; exit 1;
}
