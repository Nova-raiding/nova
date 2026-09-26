# Bridge B immutable package, before any 242 → 244 migration

Bridge B is a temporary release built from the reviewed cloud-v2 candidate
with the strict 242-or-244 compatibility guard. The historical rollback
target is the live business commit `ec3d69e37809c0d622c8f38057a072245217004f`.
The first cutover
must change code **without** running a migration. This is not achievable with
`deploy-verified-ecs-compose.sh` as currently written, because that runner
executes the candidate migration step before switching services. Use the
separately reviewed two-stage deployment runner; do not set a skip flag or
manually remove the migration step.

1. On a clean bridge B commit, prepare the candidate bundle with
   `sh infra/scripts/prepare-ecs-candidate-bundle.sh <absolute-output-dir>`.
   The SSH read is checksum-only. Stage it into a new release directory with
   `stage-verified-ecs-release.sh`; never overwrite the live checkout.
2. From the verified staged `.candidate-source.tar` and `.candidate-identity`,
   run `build-ecs-release-images.sh` with the exact B Git SHA and release ID.
   It publishes six repository images and records their immutable registry
   digests. Add the reviewed PG17 and ClamAV immutable references using
   `prepare-ecs-eight-image-set.mjs`. Do not use mutable image tags as rollout
   or rollback inputs.
3. Render the B Compose file with `BRIDGE_SCHEMA_COMPATIBILITY_MODE=prefix_242_or_244`.
   Freeze root-only old-runtime evidence for the exact seven unlabeled container
   IDs/configurations and unchanged external gateway. Retain a root-only
   `docker save` archive of the exact old API, worker and gateway image IDs;
   verify its config and layer hashes. The B-only
   `ecs-unlabeled-id-recovery-capsule` binds the evidence and archive SHA-256,
   old IDs, target identity, DB 242 checksum, preserved volumes and a 24-hour
   expiry. Do not fabricate registry manifest digests from Docker image IDs.
4. Before the code-only cutover, run the read-only package gate with eight
   absolute inputs:

   ```sh
   node infra/scripts/verify-bridge-b-package.mjs \
     --candidate-identity /path/to/B/.candidate-identity \
     --source-archive /path/to/B/.candidate-source.tar \
     --release-images /path/to/B/release-images.json \
     --eight-image-set /path/to/B/eight-image-set.json \
     --rendered-compose /path/to/B/rendered-compose.yml \
     --rollback-plan /protected/B-to-old/plan.json \
     --old-runtime-evidence /protected/B-to-old/old-runtime.json \
     --old-image-archive /protected/B-to-old/old-images.tar
   ```

The gate checks source hash, six/eight-image binding, rendered Compose image
and release identities, explicit API/worker compatibility mode, and old-242
rollback plan hashes and time window. The dedicated old-runtime verifier also
checks live old IDs, gateway, image archive contents and layer hashes before
nonce consumption. The package gate does not verify registry availability,
OCI labels on the deployment host, live production health, protected signatures,
the real database version or authorization. The two-stage runner and production
preflight must verify those independently. Only after B is healthy on schema
242 and a fresh B@244 rollback capsule is protected may migration 243/244 run.
