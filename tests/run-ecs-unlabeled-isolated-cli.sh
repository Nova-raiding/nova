#!/bin/sh
set -eu

# Real fixed-path helper, Ed25519 journal, SQLite nonce and FD9 lock. Docker,
# psql and HTTPS are deterministic stubs; never treat this as live evidence.
node_image='node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32'
container="merchant-unlabeled-isolated-$$"
root=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd -P)
fixture="$root/tests/fixtures/ecs-preidentity-isolated"
container_id=
cleanup() { if [ -n "$container_id" ]; then docker rm -f "$container_id" >/dev/null 2>&1 || true; fi; }
trap cleanup EXIT HUP INT TERM
container_id=$(docker run -d --name "$container" --network none "$node_image" sleep 600)
docker exec "$container" mkdir -p /fixture
tar -C "$root" -cf - infra/protected/ecs-preidentity-recovery.mjs | docker exec -i "$container" tar -C / -xf -
tar -C "$fixture" -cf - setup.mjs setup-unlabeled.mjs docker-unlabeled.mjs psql.mjs curl.mjs | docker exec -i "$container" tar -C /fixture -xf -
docker exec "$container" sh -lc '
  mkdir -p /usr/local/libexec/merchant
  cp /infra/protected/ecs-preidentity-recovery.mjs /usr/local/libexec/merchant/ecs-preidentity-recovery
  cp /fixture/docker-unlabeled.mjs /usr/bin/docker
  cp /fixture/psql.mjs /usr/bin/psql
  cp /fixture/curl.mjs /usr/bin/curl
  chmod 700 /usr/local/libexec/merchant/ecs-preidentity-recovery /usr/bin/docker /usr/bin/psql /usr/bin/curl
  node /fixture/setup-unlabeled.mjs
  node -e '\''const fs=require("fs"),crypto=require("crypto");fs.writeFileSync("/run/release-security/evidence-trust/production-preidentity-recovery-sha256",crypto.createHash("sha256").update(fs.readFileSync("/usr/local/libexec/merchant/ecs-preidentity-recovery")).digest("hex")+"\n",{mode:0o600})'\''
'
base='exec 9>/state/lock; flock -n 9; DATABASE_URL=postgres://user:secret@db/merchant /usr/local/libexec/merchant/ecs-preidentity-recovery'
common='--lock-path /state/lock --service-map /state/unlabeled-old-map.json --compose-project merchant-production --deployment-nonce nonce_abcdefghijklmnopqr --recovery-plan /state/bridge-unlabeled-plan.json --production-api-base-url https://yxsona.com/api'
capture="$base capture --mode bridge_unlabeled_code_only --lock-path /state/lock --service-map /state/unlabeled-old-map.json --candidate-service-map /state/unlabeled-candidate-map.json --external-gateway-id 9999999999999999999999999999999999999999999999999999999999999999 --compose-project merchant-production --candidate-release-id release-a9 --candidate-git-sha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --candidate-manifest-sha256 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb --candidate-image-set-digest sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc --candidate-image-digests /state/unlabeled-candidate-digests.json --candidate-compose /state/unlabeled-candidate-compose.yml --deployment-nonce nonce_abcdefghijklmnopqr --recovery-plan /state/bridge-unlabeled-plan.json"
docker exec "$container" mv /state/unlabeled-old-map.json /state/unlabeled-old-map.saved
if docker exec "$container" sh -lc "$capture --state /state/missing-map.json --attempt-id attempt_missing_map_abcdefghijklmnop"; then echo 'missing protected old service map unexpectedly signed takeover' >&2; exit 1; fi
docker exec "$container" mv /state/unlabeled-old-map.saved /state/unlabeled-old-map.json
docker exec "$container" mv /state/bridge-unlabeled-plan.json /state/bridge-unlabeled-plan.saved
if docker exec "$container" sh -lc "$capture --state /state/missing-capsule.json --attempt-id attempt_missing_plan_abcdefghijklmnop"; then echo 'missing protected old capsule unexpectedly signed takeover' >&2; exit 1; fi
docker exec "$container" mv /state/bridge-unlabeled-plan.saved /state/bridge-unlabeled-plan.json
docker exec "$container" sh -lc 'test ! -e /state/missing-map.json && test ! -e /state/missing-capsule.json'
docker exec "$container" sh -lc "$capture --state /state/unlabeled-failure.json --attempt-id attempt_unlabeled_abcdefghijklmnop"
docker exec "$container" sh -lc "$base phase --state /state/unlabeled-failure.json --lock-path /state/lock --phase nonce_consumed"
docker exec "$container" touch /state/bridge-db243
if docker exec "$container" sh -lc "$base bridge-begin --state /state/unlabeled-failure.json $common"; then echo 'schema 243 unexpectedly authorized unlabeled takeover' >&2; exit 1; fi
docker exec "$container" rm /state/bridge-db243
docker exec "$container" /usr/bin/docker stop --time 30 9999999999999999999999999999999999999999999999999999999999999999
if docker exec "$container" sh -lc "$base bridge-begin --state /state/unlabeled-failure.json $common"; then echo 'stopped external gateway unexpectedly authorized unlabeled takeover' >&2; exit 1; fi
docker exec "$container" /usr/bin/docker start 9999999999999999999999999999999999999999999999999999999999999999
docker exec "$container" touch /state/gateway-upstream-drift
if docker exec "$container" sh -lc "$base bridge-begin --state /state/unlabeled-failure.json $common"; then echo 'drifted external gateway upstream unexpectedly authorized unlabeled takeover' >&2; exit 1; fi
docker exec "$container" rm /state/gateway-upstream-drift
docker exec "$container" rm /state/unlabeled-mutation-count
docker exec "$container" sh -lc "$base bridge-begin --state /state/unlabeled-failure.json $common"
docker exec "$container" sh -lc 'printf 5 > /state/unlabeled-fail-at'
if docker exec "$container" sh -lc "$base bridge-switch-unlabeled --state /state/unlabeled-failure.json $common"; then echo 'injected partial takeover unexpectedly succeeded' >&2; exit 1; fi
docker exec "$container" sh -lc "$base bridge-recover-unlabeled --state /state/unlabeled-failure.json $common"
docker exec "$container" sh -lc "$base bridge-finalize --state /state/unlabeled-failure.json $common"
docker exec "$container" sh -lc 'node -e '\''const fs=require("fs"),x=JSON.parse(fs.readFileSync("/state/unlabeled-failure.json"));if(x.phase!=="bridge_recovery_verified"||x.unlabeled_takeover.length!==7)process.exit(1)'\'''

# Retry from clean original IDs, with a new signed journal and no injected
# Docker failure. Public release identity must reflect B before final success.
docker exec "$container" rm /state/unlabeled-fail-at
docker exec "$container" sh -lc "$capture --state /state/unlabeled-success.json --attempt-id attempt_unlabeled_success_abcdefghijklmnop"
docker exec "$container" sh -lc "$base phase --state /state/unlabeled-success.json --lock-path /state/lock --phase nonce_consumed"
docker exec "$container" sh -lc "$base bridge-begin --state /state/unlabeled-success.json $common"
docker exec "$container" sh -lc "$base bridge-switch-unlabeled --state /state/unlabeled-success.json $common"
docker exec "$container" rm /state/bridge-public
if docker exec "$container" sh -lc "$base bridge-verify --state /state/unlabeled-success.json --lock-path /state/lock --service-map /state/unlabeled-old-map.json --compose-project merchant-production --deployment-nonce nonce_abcdefghijklmnopqr --production-api-base-url https://yxsona.com/api"; then echo 'unverified public B identity unexpectedly signed success' >&2; exit 1; fi
docker exec "$container" sh -lc 'node -e '\''const fs=require("fs"),x=JSON.parse(fs.readFileSync("/state/unlabeled-success.json"));if(x.phase!=="bridge_cutover_started")process.exit(1)'\'''
docker exec "$container" touch /state/bridge-public
docker exec "$container" sh -lc "$base bridge-verify --state /state/unlabeled-success.json --lock-path /state/lock --service-map /state/unlabeled-old-map.json --compose-project merchant-production --deployment-nonce nonce_abcdefghijklmnopqr --production-api-base-url https://yxsona.com/api"
docker exec "$container" sh -lc 'node -e '\''const fs=require("fs"),x=JSON.parse(fs.readFileSync("/state/unlabeled-success.json"));if(x.phase!=="bridge_identity_verified"||x.unlabeled_takeover.length!==7)process.exit(1)'\'''
echo 'PASS: fixed-path signed seven-container unlabeled takeover, partial failure recovery, original IDs and public identity (Docker/PG/public stubbed).'
