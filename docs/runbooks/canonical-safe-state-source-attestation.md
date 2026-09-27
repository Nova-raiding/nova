# Canonical ordinary-release source attestation

The ordinary-release producer is `infra/protected/attest-canonical-safe-state.mjs`.
It executes the dedicated reader's `CAPTURE_SQL` in one PostgreSQL
`REPEATABLE READ READ ONLY` transaction, checks the live cluster system
identifier, database OID and name against an independently reviewed source
policy, requires every workspace to resolve to `legacy_shadow`, and signs the
result with the protected Ed25519 source key. Its output is accepted only by
the existing canonical release verifier with the same candidate and trust
binding. This is **ordinary safe-state evidence**, not two shadow-cycle
cutover evidence.

## Protected installation

The generic release-control installer has two fixed targets:

| Control | Installed path | Installed digest path |
| --- | --- | --- |
| `canonicalSnapshot` | `/usr/local/libexec/merchant/canonical-safe-state-snapshot.mjs` | `/run/release-security/evidence-trust/canonical-safe-state-library-sha256` |
| `canonicalAttester` | `/usr/local/libexec/merchant/attest-canonical-safe-state` | `/run/release-security/evidence-trust/canonical-safe-state-collector-sha256` |

Independently review the committed source bytes, copy them to a root-owned,
non-writable staging directory outside the checkout, and record their SHA-256.
Run `install-ecs-release-controls.mjs` as root with the exact `--control`,
`--source`, `--source-sha256`, `--node`, and `--node-sha256` arguments for each
target, installing `canonicalSnapshot` first. The installer rewrites only the
shebang to the reviewed Node binary, archives old bytes, writes both installed
digest files, and emits root-protected installation receipts. The producer
checks both installed digests before importing the snapshot library or
accessing a signing key. No repository source is loaded at runtime.

The following independent protected inputs are required before execution:

- A dedicated `canonical_safe_state_reader` login bootstrapped and verified
  under `canonical-safe-state-reader-bootstrap.md`.
- Root-owned `0600` `PGSERVICEFILE`, with a fixed
  `CANONICAL_SAFE_STATE_PGSERVICE` entry authenticated as that reader. TLS and
  credential provisioning remain an operator-controlled secret-management
  step; the producer never creates credentials.
- Root-protected
  `/run/release-security/evidence-trust/canonical-safe-state-source-policy.json`
  with exactly `schema_version`, `collector_sha256`, and `database_identity`.
  `database_identity` contains the reviewed cluster system-identifier SHA-256,
  database OID, database-name SHA-256, and endpoint SHA-256. The endpoint
  digest is SHA-256 of the UTF-8 bytes
  `canonical-safe-state-endpoint/1\0`, then the exact service-file bytes,
  then `\0` and the selected service name. The policy's collector digest is
  the **installed** attester digest, not the repository source digest.
- Root-owned `0600`
  `/var/lib/merchant-release-security/canonical-safe-state-private.pem`,
  matching the public key and key ID at
  `/run/release-security/evidence-trust/canonical-safe-state-public.pem` and
  `/run/release-security/evidence-trust/canonical-safe-state-key-id`.

The caller supplies `RELEASE_ID`, `CANONICAL_EXPECTED_RELEASE_GIT_SHA`,
`CANONICAL_EXPECTED_CANDIDATE_MANIFEST_SHA256`,
`CANONICAL_EXPECTED_RELEASE_MANIFEST_SHA256`,
`CANONICAL_EXPECTED_IMAGE_SET_DIGEST`, and `DEPLOYMENT_NONCE` from the reviewed
candidate preflight. Run the installed executable with
`--output /var/lib/merchant-release-security/canonical-safe-state/<release-id>.json`.
It creates that file once, mode `0600`, and syncs file and directory. The
separate preflight then checks the signature and the same candidate fields
against its own release binding. Never pass the output as cutover evidence
without running that verifier.

## Current deployment boundary

As of the repository implementation, host `101` has not installed the
dedicated reader, source policy, signing key, service file, or these two
controls. The repository tests prove contract, installation and failure
behavior in isolation; they do not claim a production capture. Do not copy
test keys, fixture service files or synthetic JSON to `101`.
