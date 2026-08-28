#!/bin/sh
set -eu

manifest_path=${1:-}
expected_digest=${2:-}

[ -n "$manifest_path" ] || { echo "rendered Kubernetes manifest path is required" >&2; exit 2; }
[ -f "$manifest_path" ] || { echo "rendered Kubernetes manifest not found: $manifest_path" >&2; exit 1; }
[ -n "$expected_digest" ] || { echo "expected image digest is required" >&2; exit 2; }

filtered_manifest_path=$(mktemp "${TMPDIR:-/tmp}/merchant-release-manifest.XXXXXX")
trap 'rm -f -- "$filtered_manifest_path"' EXIT
sed -E '/^[[:space:]]*#/d; s/[[:space:]]+#.*$//' "$manifest_path" > "$filtered_manifest_path"

printf '%s\n' "$expected_digest" | grep -Eq '^sha256:[0-9a-fA-F]{64}$' || {
  echo "expected image digest must be sha256 plus exactly 64 hexadecimal characters" >&2
  exit 1
}

# Dependency-free extraction covers ordinary YAML fields and the compact inline
# worker manifests. This runs before kubectl and therefore cannot rely on a
# cluster or a kustomize plugin being installed. Comments were removed above so
# examples cannot satisfy the immutable-image gate.
images=$(awk ' {
  for (i = 1; i <= NF; i++) {
    if ($i == "image:") {
      value = $(i + 1)
      gsub(/[,}\047\"\]]/, "", value)
      if (value != "") print value
    }
  }
}' "$filtered_manifest_path")

[ -n "$images" ] || { echo "rendered Kubernetes manifest contains no container image" >&2; exit 1; }

image_count=0
for image in $images; do
  image_count=$((image_count + 1))
  case "$image" in
    *REPLACE_ME*|*:latest|*latest@*)
      echo "unresolved or mutable image reference: $image" >&2
      exit 1
      ;;
  esac
  printf '%s\n' "$image" | grep -Eq '@sha256:[0-9a-fA-F]{64}$' || {
    echo "image must use an immutable sha256 digest: $image" >&2
    exit 1
  }
  image_digest=${image##*@}
  [ "$image_digest" = "$expected_digest" ] || {
    echo "image digest does not match IMAGE_DIGEST: $image" >&2
    exit 1
  }
done

echo "Kubernetes release manifest gate passed: images=$image_count digest=$expected_digest manifest=$manifest_path"
