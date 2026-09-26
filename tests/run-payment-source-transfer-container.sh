#!/bin/sh
set -eu
: "${PAYMENT_TRANSFER_TEST_IMAGE:?set PAYMENT_TRANSFER_TEST_IMAGE to an already present local Node image}"
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
docker run --rm --pull=never --network none --read-only --user 0:0 \
  --tmpfs /var/lib/merchant-release-security:rw,nosuid,nodev,noexec,mode=0700 \
  --mount "type=bind,source=$repo/infra/protected/transfer-payment-source-receipt.mjs,target=/test/transfer.mjs,readonly" \
  --mount "type=bind,source=$repo/tests/payment-source-transfer-container.mjs,target=/test/test.mjs,readonly" \
  "$PAYMENT_TRANSFER_TEST_IMAGE" node /test/test.mjs
