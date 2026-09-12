#!/bin/sh
set -eu

root=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
: "${PILOT_RELEASE_ID:?PILOT_RELEASE_ID is required}"
: "${PILOT_RELEASE_GIT_SHA:?PILOT_RELEASE_GIT_SHA is required}"
: "${PILOT_RELEASE_MANIFEST_SHA256:?PILOT_RELEASE_MANIFEST_SHA256 is required}"
: "${PILOT_RELEASE_IMAGE_SET_DIGEST:?PILOT_RELEASE_IMAGE_SET_DIGEST is required}"

printf '%s\n' "$PILOT_RELEASE_ID" | grep -Eq '^[A-Za-z0-9._-]+$' || {
  echo 'PILOT_RELEASE_ID contains unsafe characters' >&2
  exit 1
}
printf '%s\n' "$PILOT_RELEASE_GIT_SHA" | grep -Eq '^[0-9a-f]{40}$' || {
  echo 'PILOT_RELEASE_GIT_SHA must be a full lowercase Git SHA' >&2
  exit 1
}
printf '%s\n' "$PILOT_RELEASE_MANIFEST_SHA256" | grep -Eq '^[0-9a-f]{64}$' || {
  echo 'PILOT_RELEASE_MANIFEST_SHA256 must be lowercase SHA-256' >&2
  exit 1
}
printf '%s\n' "$PILOT_RELEASE_IMAGE_SET_DIGEST" | grep -Eq '^sha256:[0-9a-f]{64}$' || {
  echo 'PILOT_RELEASE_IMAGE_SET_DIGEST must be sha256 plus 64 lowercase hex characters' >&2
  exit 1
}

cd "$root"
docker compose \
  --env-file .env \
  -f infra/local/docker-compose.yml \
  -f infra/local/docker-compose.ecs-pilot.yml \
  -f infra/local/docker-compose.ecs-pilot-release.yml \
  config --quiet

printf '%s\n' 'pilot compose preflight passed: release identity and compose configuration are valid'
