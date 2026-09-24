#!/usr/bin/env bash
set -euo pipefail

# This legacy helper used a mutable two-file Compose stack and `--build` to
# replace the live payment-gateway outside the verified ECS release boundary.
# Keep the entrypoint as an explicit fail-closed tombstone so old operator
# notes fail safely instead of silently changing production services.
echo 'standalone Alipay key rotation is retired: it bypassed verified ECS release identity, nonce, and rollback gates; use the approved secret-management and full release procedure in docs/qa/payment-provider-production-runbook.md' >&2
exit 2
