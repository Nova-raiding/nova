#!/bin/sh
set -eu

manifest_path=${1:-}
digest_specification=${2:-}
output_mode=${3:-}

[ -n "$manifest_path" ] || { echo "rendered Kubernetes manifest path is required" >&2; exit 2; }
[ -f "$manifest_path" ] || { echo "rendered Kubernetes manifest not found: $manifest_path" >&2; exit 1; }
[ -n "$digest_specification" ] || { echo "IMAGE_DIGESTS_JSON or a legacy image digest is required" >&2; exit 2; }

command -v ruby >/dev/null 2>&1 || {
  echo "ruby with the standard Psych YAML parser is required for structured manifest validation" >&2
  exit 1
}

script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
if [ -n "$output_mode" ]; then
  ruby "$script_dir/validate-kubernetes-release.rb" "$manifest_path" "$digest_specification" "$output_mode" || exit $?
else
  ruby "$script_dir/validate-kubernetes-release.rb" "$manifest_path" "$digest_specification" || exit $?
fi
