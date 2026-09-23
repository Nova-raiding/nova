#!/bin/sh
set -eu

# Run the root-only nonce consumer smoke in a digest-pinned, network-disabled
# container with no host bind mounts or Docker socket.
readonly image='python@sha256:79e7a9b9ff1cbceff819f856fb374477792a5967759d94df266de7b7b4120e6f'
root=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd -P)
tar -C "$root" -cf - infra/protected/consume-production-evidence-nonce.py tests/protected-nonce-consumer-smoke.py |
  docker run --rm -i --network none "$image" sh -c '
    mkdir -p /source
    tar -xf - -C /source
    python3 /source/tests/protected-nonce-consumer-smoke.py /source/infra/protected/consume-production-evidence-nonce.py
  '
