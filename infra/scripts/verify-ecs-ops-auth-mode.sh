#!/bin/sh
set -eu

[ "$#" -eq 3 ] || { echo 'usage: verify-ecs-ops-auth-mode.sh <OPS_AUTH_MODE> <OPS_UI_IMAGE_REF> <RENDERED_COMPOSE_PATH>' >&2; exit 2; }
api_auth_mode=$1
ops_ui_image_ref=$2
rendered_compose_path=$3

case "$api_auth_mode" in
  password|oidc) ;;
  *) echo 'OPS_AUTH_MODE must be password or oidc' >&2; exit 1 ;;
esac
printf '%s' "$ops_ui_image_ref" | grep -Eq '^.+@sha256:[0-9a-f]{64}$' || {
  echo 'OPS_UI_IMAGE_REF must be pinned by digest for auth mode verification' >&2; exit 1;
}
[ -f "$rendered_compose_path" ] && [ ! -L "$rendered_compose_path" ] || {
  echo 'rendered Compose must be a regular non-symlink file for auth mode verification' >&2; exit 1;
}
if ! compose_ops_ui_image=$(node - "$rendered_compose_path" <<'NODE'
const fs = require('node:fs')
try {
  const rendered = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
  const image = rendered.services?.['ops-ui']?.image
  if (typeof image !== 'string' || !image) process.exit(1)
  process.stdout.write(image)
} catch {
  process.exit(1)
}
NODE
); then
  echo 'rendered Compose is missing a valid ops-ui image' >&2
  exit 1
fi
[ "$compose_ops_ui_image" = "$ops_ui_image_ref" ] || {
  echo 'OPS_UI_IMAGE_REF does not match rendered Compose ops-ui image' >&2; exit 1;
}

if ! ui_auth_mode=$(docker image inspect --format '{{index .Config.Labels "com.storenova.ops-auth-mode"}}' "$ops_ui_image_ref" 2>/dev/null); then
  echo 'could not inspect the pinned Ops UI image auth mode label' >&2
  exit 1
fi
case "$ui_auth_mode" in
  password|oidc) ;;
  *) echo 'pinned Ops UI image is missing a valid build auth mode label' >&2; exit 1 ;;
esac
[ "$ui_auth_mode" = "$api_auth_mode" ] || {
  echo 'pinned Ops UI image auth mode does not match API OPS_AUTH_MODE' >&2; exit 1;
}
