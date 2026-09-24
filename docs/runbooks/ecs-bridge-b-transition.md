# ECS Bridge B: protected runtime transition

This runbook describes the host-side `capture`, `install`, and `recover` sequence for the reviewed Bridge B controller. It is an operational procedure, not production approval. The only supported transition is runtime-only Compose `up` while the database remains at the exact, checksummed migration-242 prefix. The controller never invokes a migration service. Do not use this procedure until the normal production release gates and the owner approval for the exact candidate are green.

## Preconditions and installation

1. Prepare and independently review a clean candidate bundle from the exact commit. Verify `files.txt`, `sync-plan.tsv`, the source archive digest, the protected source digests, and the reviewed old-runtime rollback capsule. The bundle must contain `infra/protected/consume-production-evidence-nonce.py`, `infra/scripts/consume-production-evidence-nonce.sh`, `tests/protected-nonce-consumer-smoke.py`, this runbook, and the Bridge B controller/journal source. Never copy the test nonce stub into production.
2. Complete the regular release gates first: signed evidence and key identity, backup/restore acceptance, PG17 restore acceptance, API and worker readiness, scanner/canary requirements, tenant/auth checks, safe candidate synchronization, exact Compose and image digests, and production `/readyz`. A `503`, missing evidence, or unreviewed remote difference is NO-GO. Bridge B does not override any gate.
3. Provision the fixed root-owned directories, protected Node runtime, Ed25519 trust material, and the shared one-use deployment nonce consumer using [ecs-production-nonce-consumer.md](ecs-production-nonce-consumer.md). Run its isolated smoke test against the reviewed source before first installation. The consumer digest in `/run/release-security/evidence-trust/production-evidence-nonce-consumer-sha256` must match the installed consumer. Its SQLite ledger is durable state; never replace, truncate, or delete it. Bridge B records `operation=bridge-b` and its signed `attempt_id` in `nonce_owners` atomically with the normal one-use row. A regular deployment owner or an old consumed row without an owner is never eligible for Bridge B, even if the release identity happens to match.
4. Install the controller from the reviewed source using the standard protected control installer. Use the exact Node runtime and independently checked hashes; installation must run from a clean environment as root:

   ```sh
   env -i /usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node \
     /srv/merchant-releases/RELEASE_ID/infra/scripts/install-ecs-release-controls.mjs \
     --control bridgeB \
     --source /srv/merchant-releases/RELEASE_ID/infra/protected/ecs-bridge-b-transition.mjs \
     --source-sha256 REVIEWED_BRIDGE_B_SOURCE_SHA256 \
     --node /usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node \
     --node-sha256 REVIEWED_NODE_SHA256
   ```

   Confirm the install receipt, fixed executable `/usr/local/libexec/merchant/ecs-bridge-b-transition`, digest `/run/release-security/evidence-trust/production-bridge-b-transition-sha256`, the nonce consumer and its digest, public key/key ID, protected private key, and `/var/lib/merchant-release-security/bridge-b` all satisfy owner/mode requirements. Do not execute controller source from the mutable checkout.
5. Prepare immutable Bridge B Compose/env/image-digest inputs and an independently frozen old-runtime recovery capsule. Provide a reviewed service map JSON of `{ "service": "api", "container": "<exact-running-container-name>" }` entries for every runtime service. It must include `api` and only services in the controller's fixed allowlist. All candidate inputs must identify the same release ID, Git SHA, manifest SHA-256, and immutable image-set digest. Protect all config files; do not print environment values, credentials, nonce, or key material.
   Before capture, verify that each mapped live container has `com.docker.compose.project=merchant-production` and a `com.docker.compose.service` label equal to its mapped service. Container names alone do not establish Compose ownership. On 101, the legacy production API replica and workers have been observed without these labels while Postgres and Redis belong to the Compose project. Bridge B must reject that baseline: Compose cannot adopt the unlabeled containers in place, and accepting them would put the signed recovery inventory at risk. First complete a separate, reviewed legacy-to-Compose transition of the old runtime, with exact image/configuration, network, volume, port, public release identity, database-242 and rollback verification; then capture a fresh Bridge B baseline. Do not edit the service map or weaken the label checks to make capture pass.
   The 101 read-only topology audit found that the Compose project points to release Compose files no longer present at those paths; an `api` service container exists only in `Created` state. A separate root-only old-release directory retains six static Compose inputs whose hashes match Git commit `ec3d69e3`, but the live API has different network aliases and mounts, the scan worker lacks the static health check, and the external HTTPS gateway is absent from those Compose layers. The old API and workers use mutable local image tags without registry digests. The single serving API is the unlabeled, unhealthy legacy replica, and the unhealthy gateway's Nginx upstream names that replica directly. That gateway already owns host ports 80/443 and spans three Docker networks; starting the candidate gateway before an independently verified external-gateway handoff would conflict on both ports and routing. Do not synthesize an old-runtime recovery Compose file from either container names or the static old-release inputs, or start a parallel API and assume traffic has moved. Recover and review the exact rendered old runtime configuration, protected environment references, immutable image identities, gateway routing and rollback capsule; inventory the live containers and attachments, repair and verify gateway health, and separately rehearse traffic cutover and rollback before attempting the legacy handoff. A worker handoff also needs a reviewed concurrency/maintenance plan. Missing any of these inputs is `NEEDS_RECOVERY_PLAN`, not a Bridge B capture retry.
6. Confirm the shared deployment lock is the canonical root-owned protected file. Create a new random attempt ID (16–128 URL-safe characters) and one fresh deployment nonce (22–128 URL-safe characters). Bind both to the approved candidate evidence. The nonce is one-use; never generate a replacement to retry a partially completed attempt.

## Capture baseline

With the exact reviewed release checkout and host configuration, set `DATABASE_URL` and `OPS_DATABASE_URL` to the production runtime-role and ops-role connections, respectively, and call the fixed executable under the already-held FD 9 deployment lock. `LOCK_PATH`, project, paths, and all four candidate identity fields must match the frozen release inputs. The controller verifies live `/releasez`, complete running Docker inventory, matching exact migration-242 history/checksum in both databases, old-runtime capsule, candidate artifacts, and creates a signed immutable journal under `/var/lib/merchant-release-security/bridge-b/<attempt-id>.json`.

```sh
exec 9>>/var/lib/merchant-release-security/production-deploy.lock
flock -n 9 || { echo 'production deployment lock is busy' >&2; exit 1; }
env -i DATABASE_URL="$DATABASE_URL" OPS_DATABASE_URL="$OPS_DATABASE_URL" /usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node \
  /usr/local/libexec/merchant/ecs-bridge-b-transition capture \
  --state /var/lib/merchant-release-security/bridge-b/ATTEMPT_ID.json \
  --lock-path /var/lib/merchant-release-security/production-deploy.lock \
  --compose-project merchant-production --production-api-base-url https://yxsona.com \
  --attempt-id ATTEMPT_ID --deployment-nonce "$DEPLOYMENT_NONCE" \
  --service-map /protected/path/bridge-b-service-map.json \
  --bridge-release-id REVIEWED_RELEASE_ID --bridge-git-sha REVIEWED_GIT_SHA \
  --bridge-manifest-sha256 REVIEWED_MANIFEST_SHA256 --bridge-image-set-digest sha256:REVIEWED_IMAGE_SET_DIGEST \
  --bridge-compose /protected/path/bridge-b-compose.yml --bridge-env /protected/path/bridge-b.env \
  --bridge-image-digests /protected/path/bridge-b-image-digests.json \
  --recovery-plan /protected/path/old-runtime-plan.json --recovery-compose /protected/path/old-runtime-compose.yml \
  --recovery-env /protected/path/old-runtime.env --recovery-image-digests /protected/path/old-runtime-image-digests.json \
  9>&9
```

This illustrates required arguments, not a ready-to-run command: substitute only reviewed values and source secrets through the host's approved protected environment mechanism. If capture fails or any observed identity, database prefix, inventory, or health differs, stop and preserve the evidence. Do not edit the journal.

## Install Bridge B

Immediately before install, re-evaluate every normal production gate and confirm the same old runtime, database history, Compose project, service map, candidate hashes, and frozen recovery capsule. The first install consumes the deployment nonce through the shared protected consumer, binds that use to this release and attempt, records the signed journal transition, then starts only the allowlisted runtime services with `docker compose up -d --no-build --pull never --no-deps --wait`. It does not run `migrate`, change schemas, or downgrade data.

Run `install` with the same lock, nonce, service map, Bridge B inputs, and recovery inputs as capture. Acquire and retain FD 9 as shown above; do not reopen it per command while a different lock descriptor is held. The controller consumes the nonce with operation `bridge-b` and this journal's exact `attempt_id`; it then verifies both the immutable release binding and `nonce_owners.operation='bridge-b'` / matching `attempt_id` in the durable ledger. A nonce previously consumed by ordinary deployment, owned by another Bridge B attempt, or missing its owner row is rejected. A retry after a crash between the ledger commit and journal update is accepted only for that same attempt and release. The exact CLI contract is defined in `infra/protected/ecs-bridge-b-transition.mjs`; unknown, missing, duplicate, changed, or expired input fails closed:

```sh
env -i DATABASE_URL="$DATABASE_URL" OPS_DATABASE_URL="$OPS_DATABASE_URL" /usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node \
  /usr/local/libexec/merchant/ecs-bridge-b-transition install \
  --state /var/lib/merchant-release-security/bridge-b/ATTEMPT_ID.json \
  --lock-path /var/lib/merchant-release-security/production-deploy.lock \
  --compose-project merchant-production --production-api-base-url https://yxsona.com \
  --deployment-nonce "$DEPLOYMENT_NONCE" --service-map /protected/path/bridge-b-service-map.json \
  --bridge-compose /protected/path/bridge-b-compose.yml --bridge-env /protected/path/bridge-b.env \
  --bridge-image-digests /protected/path/bridge-b-image-digests.json \
  --recovery-plan /protected/path/old-runtime-plan.json --recovery-compose /protected/path/old-runtime-compose.yml \
  --recovery-env /protected/path/old-runtime.env --recovery-image-digests /protected/path/old-runtime-image-digests.json \
  --wait-timeout 300 9>&9
```

On success, preserve the journal and output, then independently confirm `/releasez` matches the full candidate identity, both the `merchant_app` and `merchant_ops` databases remain at migration 242 with the same respective history digests recorded in the journal, the full Docker inventory is expected, `/healthz` and `/readyz` are healthy, and the ordinary post-deploy canary and tenant checks pass. Do not proceed to migration-bearing candidate C until those checks and all C gates independently pass.

## Recover

Recovery is available only after the signed journal records `bridge_runtime_mutation_started` or `bridge_runtime_verified`, the deployment nonce is already consumed and bound to the same release, the live database remains the exact captured 242 prefix, and the current container inventory is explainable by the captured baseline/candidate. Recovery reuses the signed old-runtime plan, Compose, environment, and image-digest files; it verifies their hashes, starts only the old allowlisted runtime services without migrations, and verifies old `/releasez` plus the full restored inventory.

Invoke the same fixed executable with `recover` and these required parameters. Keep both database URLs in a clean, protected process environment and FD 9 bound to the same production lock:

```sh
env -i DATABASE_URL="$DATABASE_URL" OPS_DATABASE_URL="$OPS_DATABASE_URL" /usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node \
  /usr/local/libexec/merchant/ecs-bridge-b-transition recover \
  --state /var/lib/merchant-release-security/bridge-b/ATTEMPT_ID.json \
  --lock-path /var/lib/merchant-release-security/production-deploy.lock \
  --compose-project merchant-production --production-api-base-url https://yxsona.com \
  --deployment-nonce "$DEPLOYMENT_NONCE" \
  --recovery-plan /protected/path/old-runtime-plan.json --recovery-compose /protected/path/old-runtime-compose.yml \
  --recovery-env /protected/path/old-runtime.env --recovery-image-digests /protected/path/old-runtime-image-digests.json \
  --wait-timeout 300 9>&9
```

`--wait-timeout` is optional and accepts 30–900 seconds. Recovery failure, migration version other than 242, inventory drift, signature/hash mismatch, or an unrecognized runtime requires manual incident handling; preserve database, volumes, journal, and containers for investigation. Never delete data, rerun migrations, restore an old nonce ledger snapshot, hand-edit signed evidence, or fall through to the regular deploy script as a retry.

## Release boundary

The regular release preflight remains authoritative before and after Bridge B. Bridge B is not a bypass for failed readiness, missing signature keys, incomplete evidence, stale scanner state, cross-tenant failures, invalid remote merge review, missing backup/restore acceptance, or an unapproved release. Any absent prerequisite means NO-GO: leave the current runtime in place and report the exact blocker. The runbook and local fixture tests are not production evidence and do not authorize a deployment.
