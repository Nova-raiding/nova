# Bridge B immutable package, before any 242 → 244 migration

Bridge B is a temporary release built from the live business commit
`ec3d69e37809c0d622c8f38057a072245217004f` plus only the 243/244
migration metadata and the 242-or-244 compatibility guard. The first cutover
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
   Freeze the old 242 Compose, environment file and eight-image digest JSON
   under the protected rollback root. The B-to-old rollback capsule must name
   the old live Git SHA, the current B release identity, migration version 242,
   target tail 242, forward-only schema and preserved volumes. It expires
   within 24 hours and must be generated from exact frozen bytes.
4. Before the code-only cutover, run the read-only package gate with all nine
   absolute inputs:

   ```sh
   node infra/scripts/verify-bridge-b-package.mjs \
     --candidate-identity /path/to/B/.candidate-identity \
     --source-archive /path/to/B/.candidate-source.tar \
     --release-images /path/to/B/release-images.json \
     --eight-image-set /path/to/B/eight-image-set.json \
     --rendered-compose /path/to/B/rendered-compose.yml \
     --rollback-plan /protected/B-to-old/plan.json \
     --rollback-compose /protected/B-to-old/compose.yml \
     --rollback-env /protected/B-to-old/runtime.env \
     --rollback-image-digests-json /protected/B-to-old/image-digests.json
   ```

The gate checks source hash, six/eight-image binding, rendered Compose image
and release identities, explicit API/worker compatibility mode, and old-242
rollback plan hashes and time window. It does not verify registry availability,
OCI labels on the deployment host, live production health, protected signatures,
the real database version or authorization. The two-stage runner and production
preflight must verify those independently. Only after B is healthy on schema
242 and a fresh B@244 rollback capsule is protected may migration 243/244 run.
