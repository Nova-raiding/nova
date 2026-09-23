#!/bin/sh
set -eu

# The CLI runs only inside a digest-pinned, network-disabled disposable
# container with no host bind mounts or Docker socket. Docker, psql, curl and
# the nonce consumer are local deterministic stubs; this is not production
# acceptance and cannot mutate host or production state.
readonly NODE_IMAGE='node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32'
readonly CONTAINER="merchant-bridge-b-isolated-cli-$$"
root=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd -P)
container_id=''
cleanup() { if [ -n "$container_id" ]; then docker rm -f "$container_id" >/dev/null 2>&1 || true; fi; }
trap cleanup EXIT HUP INT TERM

container_id=$(docker run -d --name "$CONTAINER" --network none "$NODE_IMAGE" sleep 900)
isolation=$(docker inspect --format '{{.HostConfig.NetworkMode}} {{len .Mounts}}' "$container_id")
[ "$isolation" = 'none 0' ] || { echo 'Bridge B isolated CLI requires network=none and zero bind mounts' >&2; exit 2; }
tar -C "$root" -cf - infra/protected/ecs-bridge-b-transition.mjs tests/fixtures/ecs-bridge-b-host-cli |
  docker exec -i "$container_id" tar -C / -xf -
docker exec "$container_id" sh -lc '
  mkdir -p /usr/local/libexec/merchant /run/release-security/evidence-trust
  cp /infra/protected/ecs-bridge-b-transition.mjs /usr/local/libexec/merchant/ecs-bridge-b-transition
  cp /tests/fixtures/ecs-bridge-b-host-cli/nonce-consumer.mjs /usr/local/libexec/merchant/consume-production-evidence-nonce
  chown root:root /usr/local/libexec/merchant/ecs-bridge-b-transition /usr/local/libexec/merchant/consume-production-evidence-nonce
  chmod 0755 /usr/local/libexec/merchant/ecs-bridge-b-transition /usr/local/libexec/merchant/consume-production-evidence-nonce
  node /tests/fixtures/ecs-bridge-b-host-cli/setup.mjs
  node -e '\''const fs=require("node:fs"),crypto=require("node:crypto"); for(const [source,target] of [["/usr/local/libexec/merchant/ecs-bridge-b-transition","/run/release-security/evidence-trust/production-bridge-b-transition-sha256"],["/usr/local/libexec/merchant/consume-production-evidence-nonce","/run/release-security/evidence-trust/production-evidence-nonce-consumer-sha256"]]) fs.writeFileSync(target,crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex")+"\n",{mode:0o600})'\''
  test "$(stat -c %a /usr/local/libexec/merchant/ecs-bridge-b-transition)" = 755
  test "$(stat -c %a /var/lib/merchant-release-security/production-nonces.sqlite3)" = 600
'
docker exec "$container_id" node /tests/fixtures/ecs-bridge-b-host-cli/run.mjs

echo 'PASS: Bridge B host CLI exercised only in a no-network, no-mount container with deterministic command stubs.'
