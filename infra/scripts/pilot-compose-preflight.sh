#!/bin/sh
set -eu

root=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
: "${PILOT_RELEASE_GIT_SHA:?PILOT_RELEASE_GIT_SHA is required}"
: "${PILOT_RELEASE_MANIFEST_SHA256:?PILOT_RELEASE_MANIFEST_SHA256 is required}"
: "${PILOT_RELEASE_IMAGE_SET_DIGEST:?PILOT_RELEASE_IMAGE_SET_DIGEST is required}"

cd "$root"
docker compose \
  --env-file .env \
  -f infra/local/docker-compose.yml \
  -f infra/local/docker-compose.ecs-pilot.yml \
  -f infra/local/docker-compose.ecs-pilot-release.yml \
  config --quiet

printf '%s\n' 'pilot compose preflight passed: release identity and compose configuration are valid'
