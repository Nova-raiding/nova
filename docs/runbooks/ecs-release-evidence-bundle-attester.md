# ECS release evidence bundle attester

`infra/protected/attest-release-evidence-bundle.mjs` is source for an independently installed, root-owned executable at `/usr/local/libexec/merchant/attest-release-evidence-bundle`. The deploy runner must not execute it from the mutable repository and must never receive `/var/lib/merchant-release-security/production-evidence-bundle-private.pem`.

The attester accepts exactly eight evidence files: capability, capacity, model relay, payment, restore, object storage, Codex app host, and canonical cutover. Every file must be a fresh JSON artifact below the canonical protected artifact root, must not be a symlink, and must bind the requested release ID. It emits one Ed25519-signed document containing the exact SHA-256 reference for each file and one common release ID, image-set digest, release-manifest SHA-256, Git SHA, deployment nonce, key ID, generation time, and 24-hour expiry. Duplicate references are rejected and output is created atomically without replacement.

The release manifest declares `productionEvidenceBundle.required=true` and schema `release-evidence-bundle/1`. During ECS preflight, the bundle gate reads the exact release-manifest bytes, verifies their SHA-256 against the bundle binding, and requires all eight `productionEvidence` references to equal the signed bundle artifact references. This avoids a circular bundle hash inside the manifest while still providing two-way verification: the manifest requires the bundle and names its evidence; the signed bundle binds the exact manifest bytes and the same evidence. Object-storage evidence also retains its independent Ed25519 signature, while the bundle supplies the common signature boundary for capacity, model relay, and canonical cutover evidence.

Provision the final executable bytes outside the repository, root-owned and not group/other writable. Store their reviewed SHA-256 as `/run/release-security/evidence-trust/production-evidence-bundle-attester-sha256`; the trust directory is rebuilt independently after reboot. The executable, every parent directory, public key, private key, and digest file must be regular non-symlink paths with protected ownership and modes.

Install the reviewed bytes from the exact release commit before loading any private key. The production runtime is fixed at `/usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node`; do not substitute `/usr/bin/node`. Verify and record that runtime's SHA-256 before installing controls. The backup attester likewise invokes only `/usr/pgsql-16/bin/psql` and `/usr/pgsql-16/bin/pg_dump`. PostgreSQL 13 may remain installed for existing server duties, but it must not replace or be placed in front of these fixed PostgreSQL 16 paths.

The protected live-backup producer requires `RELEASE_ID`, `BACKUP_ATTEMPT_ID`, `EXPECTED_MIGRATION_VERSION`, and `PRODUCTION_POSTGRES_CONTAINER` on every invocation. It only accepts the reviewed `merchant-production-postgres-N` container naming contract, compares the explicit operator-reviewed version with the migration version observed from that source before creating any dump, and writes both the immutable source policy and every attempt beneath release-scoped protected paths. Failed attempts remain available for diagnosis; retries use a new immutable attempt ID instead of deleting or overwriting evidence. The producer accepts success only after independently verifying a signed schema-v2 artifact against the protected public key, exact dump bytes, reviewed database source and migration, and signed snapshot chronology. The attester, producer and strict verifier hash dump files in fixed 1 MiB chunks; a large dump is never loaded whole into Node memory. The outer timeout allows the installed attester's six-hour dump limit plus one minute; expiry is still at most 24 hours from dump completion. Never reuse a prior release's attestation or attempt ID.

Use this installation order from the root-owned reviewed release checkout:

1. Provision and independently verify the fixed Node runtime and the PostgreSQL 16 client binaries.
2. Pre-create `/usr/local/libexec/merchant`, `/run/release-security/evidence-trust`, and `/var/lib/merchant-release-security` as canonical root-owned paths with no group/other write access.
3. Inspect the actual production source using the reviewed live-backup producer. Record its `policy_sha256`, migration version, and server version for owner review. The `create` invocation writes the exact policy bytes to `/run/release-security/evidence-trust/production-backup-source-${RELEASE_ID}.json` exclusively; its only fields are `system_identifier_sha256`, `database_oid`, and `database_name`. Do not reuse an old release-scoped policy or accept a caller-selected path.
4. Install the capability control for `official_api`, or the manual control for `manual`, then backup, preidentity, and bundle controls with the same reviewed runtime digest. Installation does not authorize executing any control.
5. Provision each control's keys and operational inputs separately, then run its dedicated validation before use.

Run the exact installer interface once per control, substituting only the reviewed release ID and independently recorded SHA-256 values:

```sh
env -i /usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node /srv/merchant-releases/RELEASE_ID/infra/scripts/install-ecs-release-controls.mjs \
  --control capability \
  --source /srv/merchant-releases/RELEASE_ID/infra/protected/attest-capability-evidence.mjs \
  --source-sha256 REVIEWED_CAPABILITY_SOURCE_SHA256 \
  --node /usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node \
  --node-sha256 REVIEWED_NODE_SHA256

# For the current manual profile, install this control instead of capability:
env -i /usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node /srv/merchant-releases/RELEASE_ID/infra/scripts/install-ecs-release-controls.mjs \
  --control manual \
  --source /srv/merchant-releases/RELEASE_ID/infra/protected/attest-manual-operations-evidence.mjs \
  --source-sha256 REVIEWED_MANUAL_SOURCE_SHA256 \
  --node /usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node \
  --node-sha256 REVIEWED_NODE_SHA256

env -i /usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node /srv/merchant-releases/RELEASE_ID/infra/scripts/install-ecs-release-controls.mjs \
  --control backup \
  --source /srv/merchant-releases/RELEASE_ID/infra/protected/attest-postgres-backup.mjs \
  --source-sha256 REVIEWED_BACKUP_SOURCE_SHA256 \
  --node /usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node \
  --node-sha256 REVIEWED_NODE_SHA256

env -i /usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node /srv/merchant-releases/RELEASE_ID/infra/scripts/install-ecs-release-controls.mjs \
  --control preidentity \
  --source /srv/merchant-releases/RELEASE_ID/infra/protected/ecs-preidentity-recovery.mjs \
  --source-sha256 REVIEWED_PREIDENTITY_SOURCE_SHA256 \
  --node /usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node \
  --node-sha256 REVIEWED_NODE_SHA256

env -i /usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node /srv/merchant-releases/RELEASE_ID/infra/scripts/install-ecs-release-controls.mjs \
  --control bundle \
  --source /srv/merchant-releases/RELEASE_ID/infra/protected/attest-release-evidence-bundle.mjs \
  --source-sha256 REVIEWED_BUNDLE_SOURCE_SHA256 \
  --node /usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node \
  --node-sha256 REVIEWED_NODE_SHA256
```

After installation, verify the installed backup executable digest equals the protected `production-backup-attester-sha256` value and that its install receipt names the reviewed schema-v2 source SHA. Then, with the same exact reviewed release checkout, run `inspect` before `create`. Substitute the real current release ID, attempt ID, migration version and container name. `REVIEWED_POLICY_SHA256` must be copied from the inspected output after owner review, not calculated from caller-selected data:

```sh
env -i RELEASE_ID=RELEASE_ID BACKUP_ATTEMPT_ID=ATTEMPT_ID EXPECTED_MIGRATION_VERSION=REVIEWED_VERSION PRODUCTION_POSTGRES_CONTAINER=REVIEWED_POSTGRES_CONTAINER \
  /usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node \
  /srv/merchant-releases/RELEASE_ID/infra/protected/produce-protected-live-backup.mjs inspect

env -i RELEASE_ID=RELEASE_ID BACKUP_ATTEMPT_ID=ATTEMPT_ID EXPECTED_MIGRATION_VERSION=REVIEWED_VERSION PRODUCTION_POSTGRES_CONTAINER=REVIEWED_POSTGRES_CONTAINER \
  /usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node \
  /srv/merchant-releases/RELEASE_ID/infra/protected/produce-protected-live-backup.mjs create REVIEWED_POLICY_SHA256
```

The protected result lives under `/var/lib/merchant-release-security/backups/${RELEASE_ID}-${BACKUP_ATTEMPT_ID}/`. The JSON success line includes `schema_version: "2"` and the signed `snapshot_id_sha256`; it is not restore proof. Verify the v2 attestation through the strict backup gate and perform a real isolated PG17 restore before release approval. Failed attempts are immutable; choose a fresh attempt ID instead of deleting or overwriting one.

All five options are mandatory and must use independently reviewed SHA-256 values. Run the installer as root only after its protected destination, trust and state directories exist with root ownership and no group/other write access. Invoke repository `.mjs` sources explicitly with `node`; their checkout executable bit is not a trust signal. The installer binds the reviewed source bytes to the reviewed Node runtime, installs atomically, records protected history, and does not generate keys, sign evidence, deploy containers, or provision production data.

The isolated backup CLI drill is intentionally a shell runner, not a Vitest entry. Run it explicitly after the pinned Docker images are locally available:

```sh
bash tests/postgres-backup-attester-cli-e2e.sh
```

That runner uses an isolated Docker PostgreSQL 16 instance and synthetic keys/data to exercise snapshot, dump, restore and rejection behavior. It does not validate a production restore. The 2026-09-21 production backup verification belongs to an older release and is not evidence for the current candidate. Release readiness requires a fresh v2 attestation and separate real isolated restore acceptance bound to the candidate; do not report the complete release gate as passed from this drill alone.

The preidentity CLI/FD9 drill is also an explicit shell runner:

```sh
sh tests/run-ecs-preidentity-isolated-cli.sh
```

It uses partial Docker and `psql` stubs from `tests/fixtures/ecs-preidentity-isolated/`. It is a deterministic isolated contract drill, NOT real recovery evidence, and must not be cited as proof of a production recovery, restore, deployment, or cutover.

`validate-production-evidence-trust.sh` checks the installed bundle executable against that digest during the release gate. The deploy preflight also passes the release's operations mode (`manual` or `official_api`) and checks the matching installed attester against its mode-specific digest; the other mode's attester is not required. Both controls must live at their fixed root-owned, non-symlink paths outside the repository. Installation does not create or copy a private key; key provisioning remains a separate host security operation.

After independent evidence producers finish, the protected process signs the bundle. Set `RELEASE_EVIDENCE_BUNDLE_PATH` to that immutable output. The bundle's `manifest_sha256` is the SHA-256 of the exact `RELEASE_MANIFEST_PATH` bytes; it is intentionally distinct from the normalized rendered-Compose digest used by the individual production evidence gates. Supply both `--manifest-sha256 "$(shasum -a 256 "$RELEASE_MANIFEST_PATH" | awk '{print $1}')"` and `--candidate-manifest-sha256 "$manifest_sha256"`; the latter must equal `candidate_route.expected_manifest_sha256` in the preproduction ChatGPT host evidence. `deploy-preflight-ecs.sh` then validates the signature, lifetime, exact eight artifact hashes, exact paths supplied to deployment, release-manifest/image/Git/Compose-manifest/nonce binding, duplicate references, symlinks, and path escape before deployment can proceed. Unit fixtures exercise this contract only; they are not production evidence and do not provision a production private key.
