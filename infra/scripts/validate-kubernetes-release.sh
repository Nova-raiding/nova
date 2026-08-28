#!/bin/sh
set -eu

manifest_path=${1:-}
expected_digest=${2:-}

[ -n "$manifest_path" ] || { echo "rendered Kubernetes manifest path is required" >&2; exit 2; }
[ -f "$manifest_path" ] || { echo "rendered Kubernetes manifest not found: $manifest_path" >&2; exit 1; }
[ -n "$expected_digest" ] || { echo "expected image digest is required" >&2; exit 2; }

command -v ruby >/dev/null 2>&1 || {
  echo "ruby with the standard Psych YAML parser is required for structured manifest validation" >&2
  exit 1
}

script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
ruby "$script_dir/validate-kubernetes-release.rb" "$manifest_path" "$expected_digest" || exit $?
