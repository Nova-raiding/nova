#!/bin/sh
set -eu

# Shell/FD9/flock/SQLite/signing/journal are real. Docker and psql are
# deterministic fixed-path stubs. This does NOT prove a real Docker recovery.
readonly NODE_IMAGE='node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32'
readonly CONTAINER='merchant-preidentity-isolated-cli'
root=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd -P)
fixture="$root/tests/fixtures/ecs-preidentity-isolated"

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT HUP INT TERM
cleanup
docker run -d --name "$CONTAINER" --network none "$NODE_IMAGE" sleep 600 >/dev/null
docker exec "$CONTAINER" mkdir -p /fixture
tar -C "$root" -cf - infra/protected/ecs-preidentity-recovery.mjs | docker exec -i "$CONTAINER" tar -C / -xf -
tar -C "$fixture" -cf - docker.mjs psql.mjs setup.mjs | docker exec -i "$CONTAINER" tar -C /fixture -xf -
docker exec "$CONTAINER" sh -lc '
  mkdir -p /fixture /usr/local/libexec/merchant
  cp /infra/protected/ecs-preidentity-recovery.mjs /usr/local/libexec/merchant/ecs-preidentity-recovery
  cp /fixture/docker.mjs /usr/bin/docker
  cp /fixture/psql.mjs /usr/bin/psql
  chown root:root /usr/local/libexec/merchant/ecs-preidentity-recovery /usr/bin/docker /usr/bin/psql
  chmod 700 /usr/local/libexec/merchant/ecs-preidentity-recovery /usr/bin/docker /usr/bin/psql
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

echo 'PASS: Shell/FD9/flock/SQLite/signing/journal real; Docker/psql deterministic stubs; no real Docker recovery claimed.'
