#!/bin/sh
set -eu

# This runs source gates in a reviewed release-toolchain image. It never runs
# the production evidence preflight, which needs a separate Docker/DB boundary.
image=${ECS_CANDIDATE_GATE_IMAGE:-}
expected_image_id=${ECS_CANDIDATE_GATE_IMAGE_ID:-}
revision=${ECS_CANDIDATE_GIT_SHA:-}
source_sha=${ECS_CANDIDATE_SOURCE_SHA256:-}
[ -n "$image" ] || { echo 'ECS_CANDIDATE_GATE_IMAGE is required' >&2; exit 2; }
case "$image" in
  *:latest) echo 'latest image tag is forbidden' >&2; exit 2 ;;
esac
printf '%s' "$revision" | grep -Eq '^[0-9a-f]{40}$' || { echo 'ECS_CANDIDATE_GIT_SHA must be a full commit SHA' >&2; exit 2; }
printf '%s' "$source_sha" | grep -Eq '^sha256:[0-9a-f]{64}$' || { echo 'ECS_CANDIDATE_SOURCE_SHA256 must be a source archive digest' >&2; exit 2; }
command -v docker >/dev/null 2>&1 || { echo 'Docker is required' >&2; exit 2; }

# Never pass host credentials or candidate-specific overrides into the container.
for variable in DATABASE_URL OPS_DATABASE_URL REDIS_URL PRODUCTION_CONFIG_PATH \
  PRODUCTION_EVIDENCE_TEST_HOOK PRODUCTION_EVIDENCE_TEST_TRUST_DIR \
  PRODUCTION_EVIDENCE_TEST_NONCE_CONSUMER DOCKER_HOST DOCKER_CONTEXT; do
  eval "present=\${$variable+x}"
  [ "$present" != x ] || { echo "candidate gate runner forbids $variable in its environment" >&2; exit 2; }
done

image_revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image") || {
  echo 'pinned candidate gate image is unavailable locally' >&2; exit 1;
}
[ -n "$expected_image_id" ] && {
  printf '%s' "$expected_image_id" | grep -Eq '^sha256:[0-9a-f]{64}$' || { echo 'invalid local candidate image id' >&2; exit 2; }
  actual_image_id=$(docker image inspect --format '{{.Id}}' "$image")
  [ "$actual_image_id" = "$expected_image_id" ] || { echo 'local candidate image id does not match expected image id' >&2; exit 1; }
}
[ "$image_revision" = "$revision" ] || { echo 'candidate gate image revision does not match expected commit' >&2; exit 1; }
image_source=$(docker image inspect --format '{{index .Config.Labels "com.storenova.candidate.source_sha256"}}' "$image") || {
  echo 'candidate gate image source digest label is unavailable' >&2; exit 1;
}
[ "$image_source" = "$source_sha" ] || { echo 'candidate gate image source digest does not match expected archive' >&2; exit 1; }

docker run --rm --pull=never --network=none --cap-drop=ALL \
  --security-opt=no-new-privileges --user=65534:65534 \
  --tmpfs /tmp:rw,nosuid,nodev,size=128m \
  --workdir /workspace "$image" \
  sh -c 'npm run typecheck && npm run test:release-gates'
