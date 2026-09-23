#!/bin/sh
set -eu
root=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd -P)
cd "$root"
readonly image='node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32'
# No host paths, sockets, keys, env files, credentials, or network enter this
# disposable root container. It exercises the installed fixed-path CLI only.
tar -cf - infra/protected/ecs-bridge-b-transition.mjs tests/fixtures/ecs-bridge-b-host-cli |
  docker run --rm -i --network none "$image" sh -c '
    tar -xf - -C /
    mkdir -p /usr/local/libexec/merchant /var/lib/merchant-release-security /run/release-security/evidence-trust
    cp /infra/protected/ecs-bridge-b-transition.mjs /usr/local/libexec/merchant/ecs-bridge-b-transition
    cp /tests/fixtures/ecs-bridge-b-host-cli/nonce-consumer.mjs /usr/local/libexec/merchant/consume-production-evidence-nonce
    chmod 0755 /usr/local/libexec/merchant/ecs-bridge-b-transition /usr/local/libexec/merchant/consume-production-evidence-nonce
    node /tests/fixtures/ecs-bridge-b-host-cli/setup.mjs
    node /tests/fixtures/ecs-bridge-b-host-cli/run.mjs
  '
