#!/bin/sh
set -eu

# Shell/FD9/flock/SQLite/signing/journal are real. Docker and psql are
# deterministic fixed-path stubs. This does NOT prove a real Docker recovery.
readonly NODE_IMAGE='node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32'
readonly CONTAINER="merchant-preidentity-isolated-cli-$$"
root=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd -P)
fixture="$root/tests/fixtures/ecs-preidentity-isolated"

container_id=''
cleanup() { if [ -n "$container_id" ]; then docker rm -f "$container_id" >/dev/null 2>&1 || true; fi; }
trap cleanup EXIT HUP INT TERM
container_id=$(docker run -d --name "$CONTAINER" --network none "$NODE_IMAGE" sleep 600)
docker exec "$CONTAINER" mkdir -p /fixture
tar -C "$root" -cf - infra/protected/ecs-preidentity-recovery.mjs | docker exec -i "$CONTAINER" tar -C / -xf -
tar -C "$fixture" -cf - docker.mjs psql.mjs curl.mjs setup.mjs | docker exec -i "$CONTAINER" tar -C /fixture -xf -
docker exec "$CONTAINER" sh -lc '
  mkdir -p /fixture /usr/local/libexec/merchant
  cp /infra/protected/ecs-preidentity-recovery.mjs /usr/local/libexec/merchant/ecs-preidentity-recovery
  cp /fixture/docker.mjs /usr/bin/docker
  cp /fixture/psql.mjs /usr/bin/psql
  cp /fixture/curl.mjs /usr/bin/curl
  chown root:root /usr/local/libexec/merchant/ecs-preidentity-recovery /usr/bin/docker /usr/bin/psql /usr/bin/curl
  chmod 700 /usr/local/libexec/merchant/ecs-preidentity-recovery /usr/bin/docker /usr/bin/psql /usr/bin/curl
  node /fixture/setup.mjs
  node -e '\''const fs=require("fs"),crypto=require("crypto");fs.writeFileSync("/run/release-security/evidence-trust/production-preidentity-recovery-sha256",crypto.createHash("sha256").update(fs.readFileSync("/usr/local/libexec/merchant/ecs-preidentity-recovery")).digest("hex")+"\n",{mode:0o600})'\''
'
base='exec 9>/state/lock; flock -n 9; DATABASE_URL=postgres://user:secret@db/merchant /usr/local/libexec/merchant/ecs-preidentity-recovery'
docker exec "$CONTAINER" sh -lc "$base capture --state /state/journal.json --lock-path /state/lock --attempt-id attempt_abcdefghijklmnop --service-map /state/map.json --compose-project merchant-production --candidate-release-id release-a9 --candidate-git-sha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --candidate-manifest-sha256 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb --candidate-image-set-digest sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc --candidate-image-digests /state/candidate.json --deployment-nonce nonce_abcdefghijklmnopqr --recovery-plan /state/plan.json"
docker exec "$CONTAINER" sh -lc "$base phase --state /state/journal.json --lock-path /state/lock --phase nonce_consumed"
docker exec "$CONTAINER" sh -lc "$base phase --state /state/journal.json --lock-path /state/lock --phase migration_started"
docker exec "$CONTAINER" sh -lc "$base verify --state /state/journal.json --lock-path /state/lock --service-map /state/map.json --compose-project merchant-production --deployment-nonce nonce_abcdefghijklmnopqr --recovery-plan /state/plan.json"

# Invalid URL must fail before recovery_started or a Docker mutation command.
before=$(docker exec "$CONTAINER" sh -lc 'wc -l < /state/docker-argv.jsonl')
if docker exec "$CONTAINER" sh -lc "$base recover --state /state/journal.json --lock-path /state/lock --service-map /state/map.json --compose-project merchant-production --deployment-nonce nonce_abcdefghijklmnopqr --recovery-plan /state/plan.json --recovery-compose /state/missing-compose --recovery-env /state/missing-env --recovery-image-digests /state/missing-digests --production-api-base-url http://yxsona.com/api"; then exit 1; fi
after=$(docker exec "$CONTAINER" sh -lc 'wc -l < /state/docker-argv.jsonl')
[ "$before" = "$after" ] || { echo 'invalid URL crossed the Docker mutation boundary' >&2; exit 1; }
docker exec "$CONTAINER" sh -lc '! grep -q secret /state/psql-argv.jsonl && ! grep -q postgres: /state/psql-argv.jsonl'

# B code-only cutover uses a separate signed state branch. Inject a partial
# Docker switch, a schema drift, and a failed restoration before retrying.
docker exec "$CONTAINER" touch /state/bridge-mode
docker exec "$CONTAINER" sh -lc "$base capture --mode bridge_code_only --state /state/bridge-journal.json --lock-path /state/lock --attempt-id attempt_bridge_abcdefghijklmnop --service-map /state/map.json --compose-project merchant-production --candidate-release-id release-a9 --candidate-git-sha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --candidate-manifest-sha256 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb --candidate-image-set-digest sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc --candidate-image-digests /state/bridge-candidate.json --deployment-nonce nonce_abcdefghijklmnopqr --recovery-plan /state/bridge-plan.json"
docker exec "$CONTAINER" sh -lc "$base phase --state /state/bridge-journal.json --lock-path /state/lock --phase nonce_consumed"
docker exec "$CONTAINER" sh -lc "$base bridge-begin --state /state/bridge-journal.json --lock-path /state/lock --service-map /state/map.json --compose-project merchant-production --deployment-nonce nonce_abcdefghijklmnopqr --recovery-plan /state/bridge-plan.json --production-api-base-url https://yxsona.com/api"
docker exec "$CONTAINER" touch /state/bridge-partial
docker exec "$CONTAINER" touch /state/bridge-db243
bridge_recover="$base bridge-recover --state /state/bridge-journal.json --lock-path /state/lock --service-map /state/map.json --compose-project merchant-production --deployment-nonce nonce_abcdefghijklmnopqr --recovery-plan /state/bridge-plan.json --recovery-compose /state/bridge-compose.yml --recovery-env /state/bridge-env --recovery-image-digests /state/bridge-old-digests.json --production-api-base-url https://yxsona.com/api"
before=$(docker exec "$CONTAINER" sh -lc 'grep -c "\"compose\"" /state/docker-argv.jsonl || true')
if docker exec "$CONTAINER" sh -lc "$bridge_recover"; then echo 'schema 243 unexpectedly recovered' >&2; exit 1; fi
after=$(docker exec "$CONTAINER" sh -lc 'grep -c "\"compose\"" /state/docker-argv.jsonl || true')
[ "$before" = "$after" ] || { echo 'schema drift crossed bridge Docker mutation boundary' >&2; exit 1; }
docker exec "$CONTAINER" rm /state/bridge-db243
docker exec "$CONTAINER" touch /state/bridge-up-fail
if docker exec "$CONTAINER" sh -lc "$bridge_recover"; then echo 'injected bridge Compose failure unexpectedly passed' >&2; exit 1; fi
docker exec "$CONTAINER" rm /state/bridge-up-fail
docker exec "$CONTAINER" sh -lc "$bridge_recover"
docker exec "$CONTAINER" sh -lc 'node -e '\''const fs=require("fs");const journal=JSON.parse(fs.readFileSync("/state/bridge-journal.json"));if(journal.phase!=="bridge_recovery_verified"||!journal.signature_base64)process.exit(1);const commands=fs.readFileSync("/state/docker-argv.jsonl","utf8").split("\n").filter(Boolean).map(JSON.parse);if(commands.some(args=>args[0]==="compose"&&args.includes("migrate")))process.exit(1)'\'''

# Successful B cutover also requires real observed image/health checks: a
# generic phase command must not be able to forge bridge_identity_verified.
docker exec "$CONTAINER" rm /state/bridge-restored /state/bridge-partial /state/bridge-partial-restore
docker exec "$CONTAINER" sh -lc "$base capture --mode bridge_code_only --state /state/bridge-success.json --lock-path /state/lock --attempt-id attempt_bridge_success_abcdefghijklmnop --service-map /state/map.json --compose-project merchant-production --candidate-release-id release-a9 --candidate-git-sha aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --candidate-manifest-sha256 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb --candidate-image-set-digest sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc --candidate-image-digests /state/bridge-candidate.json --deployment-nonce nonce_abcdefghijklmnopqr --recovery-plan /state/bridge-plan.json"
docker exec "$CONTAINER" sh -lc "$base phase --state /state/bridge-success.json --lock-path /state/lock --phase nonce_consumed"
docker exec "$CONTAINER" sh -lc "$base bridge-begin --state /state/bridge-success.json --lock-path /state/lock --service-map /state/map.json --compose-project merchant-production --deployment-nonce nonce_abcdefghijklmnopqr --recovery-plan /state/bridge-plan.json --production-api-base-url https://yxsona.com/api"
if docker exec "$CONTAINER" sh -lc "$base phase --state /state/bridge-success.json --lock-path /state/lock --phase bridge_identity_verified"; then echo 'generic phase forged bridge success' >&2; exit 1; fi
docker exec "$CONTAINER" touch /state/bridge-all-candidate /state/bridge-public
docker exec "$CONTAINER" sh -lc "$base bridge-verify --state /state/bridge-success.json --lock-path /state/lock --service-map /state/map.json --compose-project merchant-production --deployment-nonce nonce_abcdefghijklmnopqr --production-api-base-url https://yxsona.com/api"
docker exec "$CONTAINER" sh -lc 'node -e '\''const fs=require("fs");const journal=JSON.parse(fs.readFileSync("/state/bridge-success.json"));if(journal.phase!=="bridge_identity_verified"||!journal.signature_base64)process.exit(1)'\'''

echo 'PASS: protected signed bridge success/recovery branches, schema-drift rejection, partial-switch retry, and no-migration recovery through fixed-path Docker/psql stubs; no real Docker recovery claimed.'
