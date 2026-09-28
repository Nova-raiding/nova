#!/bin/sh
set -eu
root=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd -P)
cd "$root"
readonly image='node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32'
# Disposable root-only container, no network or host mounts. The fixed paths
# below are the production paths inside this isolated namespace only.
tar -cf - infra/protected/ecs-bridge-255-review.mjs infra/protected/ecs-bridge-255-state.mjs \
  infra/protected/ecs-bridge-255-state-store.mjs tests/fixtures/ecs-bridge-255-state-store |
  docker run --rm -i --network none "$image" sh -c '
    set -eu
    tar -xf - -C /
    mkdir -p /usr/local/libexec/merchant /var/lib/merchant-release-security/bridge-255 /run/release-security/evidence-trust
    chmod 0700 /var/lib/merchant-release-security/bridge-255
    cp /infra/protected/ecs-bridge-255-review.mjs /usr/local/libexec/merchant/ecs-bridge-255-review.mjs
    cp /infra/protected/ecs-bridge-255-state.mjs /usr/local/libexec/merchant/ecs-bridge-255-state.mjs
    cp /infra/protected/ecs-bridge-255-state-store.mjs /usr/local/libexec/merchant/ecs-bridge-255-state-store.mjs
    printf "#!/bin/sh\\nexit 0\\n" >/usr/local/libexec/merchant/consume-production-evidence-nonce
    chmod 0755 /usr/local/libexec/merchant/ecs-bridge-255-review.mjs /usr/local/libexec/merchant/ecs-bridge-255-state.mjs /usr/local/libexec/merchant/ecs-bridge-255-state-store.mjs /usr/local/libexec/merchant/consume-production-evidence-nonce
    : >/var/lib/merchant-release-security/production-deploy.lock
    chmod 0600 /var/lib/merchant-release-security/production-deploy.lock
    exec /usr/bin/flock -n /var/lib/merchant-release-security/production-deploy.lock \
      sh -c "exec 9>>/var/lib/merchant-release-security/production-deploy.lock; exec node /tests/fixtures/ecs-bridge-255-state-store/verify.mjs"
  '
