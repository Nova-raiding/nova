#!/bin/sh
set -eu
root=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd -P)
cd "$root"
# Only these four reviewed source files enter the disposable container. No host
# directories, Docker socket, credentials, or signing keys are mounted.
tar -cf - infra/scripts/install-ecs-release-controls.mjs infra/scripts/verify-ecs-bridge-control-install.mjs infra/protected/ecs-preidentity-recovery.mjs tests/ecs-release-control-installer.container-check.mjs infra/protected/ecs-bridge-b-transition.mjs |
  docker run --rm -i --network none \
    node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 \
    sh -c 'mkdir /source && tar -xf - -C /source && chown -R 0:0 /source && node /source/tests/ecs-release-control-installer.container-check.mjs'
