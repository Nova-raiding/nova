#!/bin/sh
set -eu

: "${PRODUCTION_EVIDENCE_NONCE_CONSUMER:?PRODUCTION_EVIDENCE_NONCE_CONSUMER is required}"
: "${PRODUCTION_EVIDENCE_REPO_ROOT:?PRODUCTION_EVIDENCE_REPO_ROOT is required}"
: "${DEPLOYMENT_NONCE:?DEPLOYMENT_NONCE is required}"
: "${RELEASE_ID:?RELEASE_ID is required}"
: "${IMAGE_DIGEST:?IMAGE_DIGEST is required}"
: "${PRODUCTION_EVIDENCE_MANIFEST_SHA256:?PRODUCTION_EVIDENCE_MANIFEST_SHA256 is required}"
: "${RELEASE_GIT_SHA:?RELEASE_GIT_SHA is required}"

case "$PRODUCTION_EVIDENCE_NONCE_CONSUMER" in /*) ;; *) echo "PRODUCTION_EVIDENCE_NONCE_CONSUMER must be an absolute executable path" >&2; exit 1 ;; esac
[ -x "$PRODUCTION_EVIDENCE_NONCE_CONSUMER" ] || { echo "production evidence nonce consumer is not executable: $PRODUCTION_EVIDENCE_NONCE_CONSUMER" >&2; exit 1; }
[ ! -L "$PRODUCTION_EVIDENCE_NONCE_CONSUMER" ] || { echo "production evidence nonce consumer must not be a symbolic link" >&2; exit 1; }
repo_root=$(CDPATH= cd -- "$PRODUCTION_EVIDENCE_REPO_ROOT" && pwd -P)
consumer_dir=$(CDPATH= cd -- "$(dirname "$PRODUCTION_EVIDENCE_NONCE_CONSUMER")" && pwd -P)
case "$consumer_dir/" in "$repo_root/"*) echo "production evidence nonce consumer must be provisioned outside the mutable repository" >&2; exit 1 ;; esac
printf '%s\n' "$DEPLOYMENT_NONCE" | grep -Eq '^[A-Za-z0-9_-]{22,128}$' || { echo "DEPLOYMENT_NONCE must contain 22-128 URL-safe random characters" >&2; exit 1; }
printf '%s\n' "$IMAGE_DIGEST" | grep -Eq '^sha256:[0-9a-fA-F]{64}$' || { echo "IMAGE_DIGEST must be an immutable SHA-256 digest" >&2; exit 1; }
printf '%s\n' "$PRODUCTION_EVIDENCE_MANIFEST_SHA256" | grep -Eq '^[0-9a-f]{64}$' || { echo "PRODUCTION_EVIDENCE_MANIFEST_SHA256 must be a lowercase SHA-256 hash" >&2; exit 1; }
printf '%s\n' "$RELEASE_GIT_SHA" | grep -Eq '^([0-9a-f]{40}|[0-9a-f]{64})$' || { echo "RELEASE_GIT_SHA must be a full Git object id" >&2; exit 1; }

"$PRODUCTION_EVIDENCE_NONCE_CONSUMER" consume \
  --namespace merchant-production-deploy \
  --nonce "$DEPLOYMENT_NONCE" \
  --release-id "$RELEASE_ID" \
  --image-digest "$IMAGE_DIGEST" \
  --manifest-sha256 "$PRODUCTION_EVIDENCE_MANIFEST_SHA256" \
  --release-git-sha "$RELEASE_GIT_SHA" || {
    echo 'deployment nonce was already consumed or could not be consumed atomically; deployment refused' >&2
    exit 1
  }

echo "production evidence nonce consumed: release_id=$RELEASE_ID manifest_sha256=$PRODUCTION_EVIDENCE_MANIFEST_SHA256"
