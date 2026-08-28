#!/bin/sh
set -eu

repo_root=${1:-}
trust_dir=${2:-}

[ -n "$repo_root" ] && [ -d "$repo_root" ] || { echo "repository root is required for trust-boundary validation" >&2; exit 2; }
[ -n "$trust_dir" ] || { echo "production evidence trust anchor is not provisioned: PRODUCTION_EVIDENCE_TRUST_DIR is required" >&2; exit 1; }
[ -d "$trust_dir" ] || { echo "production evidence trust anchor directory not found: $trust_dir" >&2; exit 1; }

repo_root=$(CDPATH= cd -- "$repo_root" && pwd -P)
trust_dir=$(CDPATH= cd -- "$trust_dir" && pwd -P)
case "$trust_dir/" in "$repo_root/"*) echo "production evidence trust anchor must be provisioned outside the mutable repository" >&2; exit 1 ;; esac

public_key="$trust_dir/production-evidence-public.pem"
key_id_path="$trust_dir/production-evidence-key-id"
[ -f "$public_key" ] && [ ! -L "$public_key" ] || { echo "production evidence public key must be a regular non-symlink file" >&2; exit 1; }
[ -f "$key_id_path" ] && [ ! -L "$key_id_path" ] || { echo "production evidence key id must be a regular non-symlink file" >&2; exit 1; }
grep -q 'UNPROVISIONED' "$public_key" && { echo "production evidence trust anchor is not provisioned" >&2; exit 1; }
key_id=$(sed -n '1p' "$key_id_path")
printf '%s\n' "$key_id" | grep -Eq '^[A-Za-z0-9._:-]{8,128}$' || { echo "production evidence key id is invalid or unprovisioned" >&2; exit 1; }

echo "production evidence trust boundary passed: key_id=$key_id"
