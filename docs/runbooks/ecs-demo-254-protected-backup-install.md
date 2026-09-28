# Current demo 254 protected backup controls

This runbook stages controls only. It does not authorize a release, a database
migration, or a gateway switch. The current public source is
`release-f48c8454-dual-e2e` at the time this protected backup source plan was
captured. The API was later updated to `release-demo-manual-import-20260928`
(`bb417660402c341df1b0d1debd5778f8b963c568`); the existing signed backup and
isolated PG17 preview remain bound to their original `f48c8454` source and are
not evidence for a fresh capture of the newer live runtime. Its serving PostgreSQL is the
`merchant-demo-85575f9c` project, not `merchant-production`.

## 1. Package one reviewed `main` commit

From the sole main worktree, record the full reviewed commit and run:

```sh
node infra/scripts/prepare-demo-254-backup-bundles.mjs \
  --commit FULL_REVIEWED_MAIN_SHA \
  --output /ABSOLUTE_NEW_LOCAL_STAGE
```

The packager reads six protected source files exclusively via `git show` at
that exact main HEAD. It bundles the plan signer and backup collector as
standalone Node 22 ESM files and copies the nonce consumer. Review the printed
`manifest_sha256`, bundle SHA values and source commit. Transfer the four stage
files to a **new root-owned** 0700 directory on 101 using the reviewed release
sync process; make each staged file root-owned and not group/other writable.
Do not use an unreviewed mutable checkout as the control source.

## 2. Install the controls on 101

Review the exact SHA-256 of the new wrapper source, the existing generic
installer source and the fixed Node binary. Run the new wrapper from a
root-owned reviewed release checkout with an empty environment:

```sh
env -i /usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node \
  /srv/merchant-releases/REVIEWED_RELEASE/infra/protected/install-demo-254-backup-controls.mjs install \
  --stage /var/lib/merchant-release-security/REVIEWED_STAGE \
  --approved-manifest-sha256 REVIEWED_MANIFEST_SHA256 \
  --installer /srv/merchant-releases/REVIEWED_RELEASE/infra/scripts/install-ecs-release-controls.mjs \
  --approved-installer-sha256 REVIEWED_GENERIC_INSTALLER_SHA256 \
  --approved-wrapper-sha256 REVIEWED_WRAPPER_SHA256 \
  --node-sha256 REVIEWED_NODE_SHA256
```

The wrapper installs the digest-pinned plan signer, then the digest-pinned
backup collector, then the new nonce consumer and digest. It snapshots prior
control bytes in a root-only recovery journal first. If an installation step
fails it restores those exact bytes. A crash leaves the journal and blocks a
new install. Recover from the same reviewed wrapper with:

```sh
env -i /usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node \
  /srv/merchant-releases/REVIEWED_RELEASE/infra/protected/install-demo-254-backup-controls.mjs recover \
  --approved-wrapper-sha256 REVIEWED_WRAPPER_SHA256
```

Recovery affects only the protected control executables and digest receipts.
Neither install nor recover opens the business database or nonce ledger.

## 3. Inspect, sign and capture only after owner review

The following commands remain pending an owner-reviewed install receipt,
fresh public identity, backup capacity, and the actual digest outputs. The
plan signer reads the 1–254 SQL prefix from the protected 255 candidate and
compares every name and checksum with the current PostgreSQL 254 snapshot.

```sh
env -i /usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node \
  /usr/local/libexec/merchant/attest-demo-254-frozen-plan inspect \
  --release-id release-f48c8454-dual-e2e \
  --candidate-release-id release-ab61720a-ops-review-20260928
```

`inspect` only reads Docker metadata, gateway config, TLS release endpoint,
candidate SQL and PostgreSQL. The signer requires the resulting freeze digest
as an independently reviewed input:

```sh
env -i /usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node \
  /usr/local/libexec/merchant/attest-demo-254-frozen-plan sign \
  --release-id release-f48c8454-dual-e2e \
  --candidate-release-id release-ab61720a-ops-review-20260928 \
  --approved-freeze-sha256 OWNER_REVIEWED_FREEZE_SHA256
```

`sign` writes the signed root-owned 0444 plan under the protected trust root.
It does not modify PostgreSQL. Review the plan file SHA-256 before capture:

```sh
env -i /usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node \
  /usr/local/libexec/merchant/attest-demo-254-backup create \
  --release-id release-f48c8454-dual-e2e \
  --attempt-id NEW_URL_SAFE_ATTEMPT_AT_LEAST_16_CHARS \
  --approved-plan-sha256 OWNER_REVIEWED_SIGNED_PLAN_SHA256 \
  --nonce NEW_URL_SAFE_NONCE_AT_LEAST_22_CHARS
```

`create` makes read-only PostgreSQL snapshot connections and a PG16 custom
`pg_dump` against the exact demo source. Host-side effects are one durable
nonce ledger row and a new root-owned backup directory containing the dump,
SHA-256 sidecar, signed v2 attestation and signed capture manifest. The nonce
is strictly one-use, including a failed backup attempt. It never writes a
business table. Verify all four files and perform an isolated restore before
using the backup as a release gate. Current production remains **NO-GO** until
these operations and the isolated restore have been observed.
