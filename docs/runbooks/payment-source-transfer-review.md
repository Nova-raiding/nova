# Payment source transfer review

`infra/protected/verify-payment-source-transfer.mjs` is an independent,
read-only check of one copied gateway receipt and its transfer record. Run it
as the independent evidence-reader UID after the protected host-root transfer:

```sh
node infra/protected/verify-payment-source-transfer.mjs \
  /var/lib/merchant-release-security/payment-evidence/<attempt>/<uuid>.transfer.json
```

It requires a canonical 0700 reader-owned directory, private 0600 regular
files, the exact transfer-record contract, an exact gateway receipt contract,
and matching SHA-256 for the copied bytes. Its output deliberately says
`review_only=true`, `source_origin_verified=false`,
`release_binding_verified=false`, `provider_and_ledger_reconciled=false`, and
`final_evidence=false`. It never reads the UID 100 source file, queries the
provider or database, signs evidence, or moves money. A passing result proves
only that the reader's copy still matches its transfer metadata. The transfer
record and copy live under the same reader-owned directory, so this check
cannot independently authenticate the gateway's origin or current release.

Run the synthetic rejection cases with
`node --test infra/protected/verify-payment-source-transfer.test.mjs`. The
production payment gate remains NO-GO until the protected deployment identity,
provider and ledger observations, authorized six-stage flow and independent
final attestation are all in place.
