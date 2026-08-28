#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
: "${RENDERED_MANIFEST_PATH:?RENDERED_MANIFEST_PATH is required}"
: "${DEPLOYMENT_NONCE:?DEPLOYMENT_NONCE is required}"
[ -f "$RENDERED_MANIFEST_PATH" ] || { echo "rendered manifest not found: $RENDERED_MANIFEST_PATH" >&2; exit 1; }

source_manifest=$RENDERED_MANIFEST_PATH
verified_manifest=$(mktemp "${TMPDIR:-/tmp}/merchant-verified-manifest.XXXXXX")
trap 'rm -f -- "$verified_manifest"' EXIT
source_before=$(shasum -a 256 "$source_manifest" | awk '{print $1}')
cp "$source_manifest" "$verified_manifest"
source_after=$(shasum -a 256 "$source_manifest" | awk '{print $1}')
before=$(shasum -a 256 "$verified_manifest" | awk '{print $1}')
[ "$source_before" = "$source_after" ] && [ "$source_before" = "$before" ] || { echo 'rendered manifest changed while creating the verified deployment copy' >&2; exit 1; }
RENDERED_MANIFEST_PATH=$verified_manifest
export RENDERED_MANIFEST_PATH
sh "$root/infra/scripts/deploy-preflight.sh" "${PRODUCTION_CONFIG_PATH:?PRODUCTION_CONFIG_PATH is required}"
after=$(shasum -a 256 "$RENDERED_MANIFEST_PATH" | awk '{print $1}')
[ "$before" = "$after" ] || { echo 'rendered manifest changed after verification; deployment refused' >&2; exit 1; }

release_git_sha=$(git -C "$root" rev-parse HEAD)
PRODUCTION_EVIDENCE_MANIFEST_SHA256="$after" RELEASE_GIT_SHA="$release_git_sha" PRODUCTION_EVIDENCE_REPO_ROOT="$root" \
  sh "$root/infra/scripts/consume-production-evidence-nonce.sh"
after_nonce=$(shasum -a 256 "$RENDERED_MANIFEST_PATH" | awk '{print $1}')
[ "$after" = "$after_nonce" ] || { echo 'verified manifest changed while consuming deployment nonce; deployment refused' >&2; exit 1; }

# Apply the exact verified bytes. Re-rendering the overlay here would break the
# evidence binding and is intentionally forbidden.
kubectl apply -f "$RENDERED_MANIFEST_PATH"
echo "verified manifest deployed: sha256=$after release_id=$RELEASE_ID"
