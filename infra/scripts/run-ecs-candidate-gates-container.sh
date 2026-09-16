#!/bin/sh
set -eu

# This runs source gates in a reviewed release-toolchain image. It never runs
# the production evidence preflight, which needs a separate Docker/DB boundary.
image=${ECS_CANDIDATE_GATE_IMAGE:-}
revision=${ECS_CANDIDATE_GIT_SHA:-}
source_sha=${ECS_CANDIDATE_SOURCE_SHA256:-}
case "$image" in
  *@sha256:*) digest=${image##*@sha256:} ;;
  *) echo 'ECS_CANDIDATE_GATE_IMAGE must be pinned by sha256 digest' >&2; exit 2 ;;
esac
printf '%s' "$digest" | grep -Eq '^[0-9a-f]{64}$' || { echo 'invalid candidate gate image digest' >&2; exit 2; }
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
