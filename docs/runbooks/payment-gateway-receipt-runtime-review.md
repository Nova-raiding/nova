# Payment gateway receipt sink review

Before collecting production payment evidence, run the read-only host check
against the exact gateway container and the host directory rendered into its
`/run/payment-receipts` bind mount:

```sh
node infra/scripts/inspect-payment-gateway-receipt-runtime.mjs \
  <exact-payment-gateway-container-name> \
  /var/lib/merchant-release-security/payment-receipts
```

The check inspects Docker metadata and host ownership without reading receipts
or Docker environment values. It requires a healthy UID `100:101` gateway,
read-only unprivileged root filesystem, exactly one writable bind mount, a
canonical protected parent chain, and a UID 100, mode 0700 sink. Gateway
`/healthz` alone does not test receipt writes.

This check is **review-only**. Its output explicitly keeps
`release_binding_verified=false`, `provider_and_ledger_reconciled=false`, and
`final_evidence=false`. It does not inspect the gateway image's deployment
identity, make a provider request, query the ledger, or authorize payment.

The 2026-09-27 read-only 101 inventory found the running demo gateway mounted
a root-owned 0700 receipt directory while the container ran as UID 100; the
local gateway had no receipt mount. These installations cannot provide a
passing protected receipt-sink check as observed. Correcting a candidate sink
requires a separately reviewed host ownership/mount change and a fresh
runtime check; do not alter a currently serving gateway just to make this
review pass. Historical successful orders remain historical facts and do not
replace current candidate evidence.

Synthetic regression checks: `node --test
infra/scripts/inspect-payment-gateway-receipt-runtime.test.mjs`.
