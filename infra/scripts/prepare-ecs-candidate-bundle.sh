#!/bin/sh
set -eu

# Build a local, reviewable ECS candidate bundle. This script only reads the
# remote checkout (via sha256sum) and never copies to, edits, or restarts it.

root=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
remote_alias=${ECS_CANDIDATE_REMOTE_ALIAS:-101}
remote_root=${ECS_CANDIDATE_REMOTE_ROOT:-/opt/merchant-deploy}
output_dir=${1:-"$root/artifacts/deployment-candidates/ecs-$(date -u +%Y%m%dT%H%M%SZ)"}

case "$remote_root" in
  /*) ;;
  *) echo "ECS_CANDIDATE_REMOTE_ROOT must be an absolute path" >&2; exit 1 ;;
esac
# The path is interpolated into a remote POSIX shell command. Reject quotes,
# whitespace, shell metacharacters and traversal before opening SSH, so this
# read-only checksum command cannot be turned into remote shell source.
printf '%s' "$remote_root" | grep -Eq '^/[A-Za-z0-9._/-]+$' || {
  echo 'ECS_CANDIDATE_REMOTE_ROOT contains unsafe characters' >&2; exit 1;
}
case "$remote_root/" in
  */../*|*/./*|*//*) echo 'ECS_CANDIDATE_REMOTE_ROOT must be canonical' >&2; exit 1 ;;
esac
printf '%s' "$remote_alias" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._@-]*$' || {
  echo 'ECS_CANDIDATE_REMOTE_ALIAS must be a safe SSH host or alias' >&2; exit 1;
}

command -v git >/dev/null 2>&1 || { echo 'git is required' >&2; exit 2; }
command -v shasum >/dev/null 2>&1 || { echo 'shasum is required' >&2; exit 2; }
[ -z "$(git -C "$root" status --porcelain --untracked-files=normal)" ] || {
  echo 'candidate bundle requires a clean committed source tree' >&2
  exit 2
}
revision=$(git -C "$root" rev-parse HEAD)
printf '%s' "$revision" | grep -Eq '^[0-9a-f]{40}$' || {
  echo 'candidate HEAD must be a full commit SHA' >&2; exit 2;
}
cloud_source_v2=${ECS_CLOUD_SOURCE_V2:-0}
case "$cloud_source_v2" in 0|1) ;; *) echo 'ECS_CLOUD_SOURCE_V2 must be 0 or 1' >&2; exit 2 ;; esac
if [ "$cloud_source_v2" = 1 ]; then
  : "${RELEASE_ID:?cloud-only candidate requires RELEASE_ID}"
  : "${ECS_PLUGIN_DARWIN_DESCRIPTOR_PATH:?cloud-only candidate requires signed macOS plugin descriptor}"
  : "${ECS_PLUGIN_DARWIN_PACKAGE_PATH:?cloud-only candidate requires macOS plugin package}"
  : "${ECS_PLUGIN_DARWIN_TEST_PATH:?cloud-only candidate requires signed macOS plugin tests}"
  : "${ECS_PLUGIN_WIN32_DESCRIPTOR_PATH:?cloud-only candidate requires signed Windows plugin descriptor}"
  : "${ECS_PLUGIN_WIN32_PACKAGE_PATH:?cloud-only candidate requires Windows plugin package}"
  : "${ECS_PLUGIN_WIN32_TEST_PATH:?cloud-only candidate requires signed Windows plugin tests}"
  : "${ECS_PLUGIN_PUBLIC_KEY_PATH:?cloud-only candidate requires trusted plugin public key}"
  : "${ECS_PLUGIN_KEY_ID:?cloud-only candidate requires trusted plugin key ID}"
  verify_plugin_platform() {
    os=$1 descriptor=$2 package=$3 tests=$4
    node "$root/scripts/plugin-release-descriptor.mjs" verify \
      --descriptor "$descriptor" --package "$package" \
      --public-key "$ECS_PLUGIN_PUBLIC_KEY_PATH" --key-id "$ECS_PLUGIN_KEY_ID" \
      --release-id "$RELEASE_ID" --git-sha "$revision"
    plugin_platform=$(node -e 'const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(x.platform)' "$descriptor")
    case "$plugin_platform" in "$os"-x64|"$os"-arm64) ;; *) echo "signed $os package platform mismatch" >&2; exit 2 ;; esac
    node "$root/scripts/local-plugin-test-attestation.mjs" verify \
      --record "$tests" --descriptor "$descriptor" \
      --public-key "$ECS_PLUGIN_PUBLIC_KEY_PATH" --key-id "$ECS_PLUGIN_KEY_ID" \
      --release-id "$RELEASE_ID" --git-sha "$revision" --platform "$plugin_platform"
  }
  verify_plugin_platform darwin "$ECS_PLUGIN_DARWIN_DESCRIPTOR_PATH" "$ECS_PLUGIN_DARWIN_PACKAGE_PATH" "$ECS_PLUGIN_DARWIN_TEST_PATH"
  verify_plugin_platform win32 "$ECS_PLUGIN_WIN32_DESCRIPTOR_PATH" "$ECS_PLUGIN_WIN32_PACKAGE_PATH" "$ECS_PLUGIN_WIN32_TEST_PATH"
fi

# Never reuse a prior candidate directory: replacing its review inputs can
# invalidate an operator's review while leaving the path and name unchanged.
# Create the parent as needed, then use mkdir (not mkdir -p) for an atomic
# claim of the final candidate path.
output_parent=$(dirname "$output_dir")
mkdir -p "$output_parent"
mkdir "$output_dir" 2>/dev/null || {
  echo 'candidate output directory already exists; choose a new path' >&2
  exit 2
}
manifest="$output_dir/files.txt"
report="$output_dir/sync-plan.tsv"
archive="$output_dir/candidate-source.tar"

cat > "$manifest" <<'EOF'
.env.example
package.json
package-lock.json
apps/api/src/server.ts
apps/api/src/scanner-health.test.ts
apps/api/src/connector-capability-evidence-trust.ts
apps/api/src/connector-capability-evidence-trust.test.ts
apps/api/src/ops/csv-cell.ts
apps/api/src/csv-cell-injection.test.ts
apps/api/src/aliyun-ecs-role-credentials.ts
apps/api/src/customer-delivery-contract-download.ts
packages/persistence/src/migration.ts
packages/persistence/src/migration-210.test.ts
packages/persistence/src/migration-210-release.postgres.test.ts
release-metadata.json
infra/docker/api.Dockerfile
infra/docker/worker.Dockerfile
infra/docker/pilot-gateway-https.Dockerfile
infra/nginx/pilot-gateway-https.conf
infra/scripts/apply-migrations.sh
infra/scripts/verify-runtime-db-role.sh
infra/scripts/generate-container-source-manifest.mjs
infra/local/ensure-app-role.sql
infra/local/docker-compose.yml
infra/local/docker-compose.ecs-pilot.yml
infra/local/docker-compose.ecs-production-api-private.yml
infra/local/docker-compose.ecs-oss-cutover.yml
infra/local/docker-compose.ecs-production-migration.yml
infra/local/docker-compose.ecs-pilot-https.yml
infra/local/docker-compose.ecs-pilot-release.yml
infra/local/ecs-production-compose.layers
infra/scripts/pilot-compose-preflight.sh
infra/scripts/render-ecs-production-compose.sh
infra/scripts/rotate-alipay-secrets.sh
infra/scripts/validate-ecs-compose-project.mjs
infra/scripts/stage-verified-ecs-release.sh
infra/scripts/verify-staged-plugin-release-v2.sh
scripts/plugin-release-descriptor.mjs
scripts/local-plugin-test-attestation.mjs
infra/scripts/ecs-build-lock.sh
infra/scripts/install-ecs-staging-toolchain.mjs
infra/scripts/ecs-one-click-deploy.sh
infra/scripts/check-ecs-storage-budget.sh
infra/scripts/build-ecs-release-images.sh
infra/scripts/prepare-ecs-eight-image-set.mjs
infra/scripts/ecs-review-structure.mjs
infra/scripts/ecs-review-structure.d.mts
infra/scripts/inspect-ecs-review-structure.mjs
tests/ecs-review-structure-inspection.test.ts
docs/runbooks/ecs-source-review-acquisition.md
infra/scripts/verify-bridge-b-package.mjs
infra/scripts/deploy-ecs-bridge-unlabeled.sh
infra/scripts/create-ecs-bridge-old-map.mjs
infra/scripts/create-ecs-bridge-candidate-map.mjs
infra/scripts/validate-ecs-bridge-scoped-compose.mjs
infra/scripts/verify-ecs-bridge-control-install.mjs
infra/scripts/verify-ecs-cloud-only-artifacts.mjs
infra/scripts/capture-manual-operations-evidence.sh
infra/scripts/candidate-api-docker-request.mjs
infra/scripts/launch-ecs-candidate-api.mjs
infra/scripts/launch-ecs-candidate-tls-gateway.mjs
infra/scripts/launch-ecs-candidate-tls-gateway.d.mts
infra/scripts/launch-ecs-candidate-full-https-gateway.mjs
infra/scripts/launch-ecs-candidate-full-https-gateway.d.mts
tests/ecs-candidate-full-https-gateway.test.ts
infra/scripts/deploy-verified-ecs-compose.sh
infra/scripts/ecs-compose-published-ports.mjs
infra/scripts/ecs-compose-published-ports.d.mts
infra/scripts/ecs-external-gateway-handoff.mjs
infra/scripts/ecs-external-gateway-handoff.d.mts
tests/ecs-external-gateway-handoff.test.ts
infra/scripts/rollback-ecs-compose.sh
infra/scripts/invoke-ecs-automatic-rollback.sh
infra/scripts/install-ecs-release-controls.mjs
infra/scripts/install-ecs-release-controls.d.mts
infra/scripts/test-ecs-release-control-installer.sh
tests/ecs-staging-toolchain-installer.test.mjs
tests/ecs-staging-toolchain-installer.container-check.mjs
tests/ecs-production-compose-contract.test.ts
tests/ecs-one-click-deploy.test.ts
infra/scripts/consume-production-evidence-nonce.sh
infra/protected/consume-production-evidence-nonce.py
tests/protected-nonce-consumer-smoke.py
tests/run-protected-nonce-consumer-isolated.sh
docs/runbooks/ecs-production-nonce-consumer.md
docs/runbooks/ecs-bridge-b-transition.md
infra/protected/attest-release-evidence-bundle.mjs
infra/protected/attest-release-evidence-bundle.d.mts
infra/protected/attest-postgres-backup.mjs
infra/protected/attest-postgres-backup.d.mts
infra/protected/restore-pg17-isolated.mjs
infra/protected/restore-pg17-isolated.d.mts
infra/protected/attest-manual-operations-evidence.mjs
infra/protected/attest-manual-operations-evidence.d.mts
infra/protected/ecs-preidentity-recovery.mjs
infra/protected/ecs-preidentity-recovery.d.mts
tests/release-evidence-bundle-gate.ts
tests/ecs-release-control-installer.container-check.mjs
tests/ecs-release-control-installer.test.ts
tests/postgres-backup-attester.test.ts
tests/postgres-backup-attester-cli-e2e.sh
tests/ecs-preidentity-recovery.test.ts
tests/bridge-b-package.test.ts
tests/ecs-bridge-unlabeled-runner.test.ts
tests/ecs-cloud-only-artifacts.test.ts
tests/run-ecs-preidentity-isolated-cli.sh
tests/fixtures/ecs-preidentity-isolated/docker.mjs
tests/fixtures/ecs-preidentity-isolated/psql.mjs
tests/fixtures/ecs-preidentity-isolated/setup.mjs
tests/worker-apk-repository.test.ts
infra/scripts/validate-ecs-production-compose.mjs
infra/scripts/validate-production-config.sh
scripts/collect-aliyun-oss-control-plane.ts
scripts/object-storage-canary.ts
scripts/produce-object-storage-evidence.ts
scripts/model-relay-recovery-evidence.ts
tests/ecs-object-storage-evidence-preflight.test.ts
tests/ecs-pilot-api-replica-parity.test.ts
tests/ecs-oss-cutover-overlay.test.ts
tests/object-storage-canary.test.ts
tests/object-storage-evidence-gate.test.ts
tests/object-storage-evidence-gate.ts
tests/object-storage-evidence-producer.test.ts
tests/production-config-gate.test.ts
tests/rendered-production-config-contract.test.ts
tests/rendered-production-config-gate.test.ts
docs/runbooks/aliyun-oss-canary-delete-version-authorization.md
docs/runbooks/durable-platform-authorization-bootstrap.md
docs/runbooks/ecs-verified-compose-deploy.md
docs/runbooks/ecs-release-evidence-bundle-attester.md
docs/runbooks/pg17-isolated-restore-capture.md
tests/restore-pg17-isolated.test.ts
docs/runbooks/ecs-release-image-build.md
docs/runbooks/ecs-candidate-api-sidecar.md
apps/api/src/local-plugin-auth.e2e.test.ts
apps/api/src/local-plugin-auth.ts
apps/api/src/local-plugin-auth.test.ts
apps/api/src/local-plugin-connect-request.e2e.test.ts
apps/api/src/local-plugin-instance-proof.ts
apps/api/src/local-plugin-instance-proof.test.ts
apps/api/src/local-plugin-installer.integration.test.ts
packages/persistence/src/local-plugin-connection-repository.ts
packages/persistence/src/local-plugin-connection-repository.test.ts
packages/persistence/src/local-plugin-install-instance-repository.ts
packages/persistence/src/local-plugin-install-instance-repository.test.ts
packages/persistence/src/migrations/243_local_plugin_connection_requests.sql
packages/persistence/src/migrations/244_local_plugin_install_instances.sql
packages/persistence/src/migrations/245_local_plugin_authorized_timestamp.sql
apps/api/src/production-readiness.e2e.test.ts
apps/plugin/scripts/upgrade-installed-plugin.mjs
apps/plugin/scripts/upgrade-installed-plugin.test.ts
.codex-marketplace/plugins/merchant-marketing/scripts/upgrade-installed-plugin.mjs
.codex-marketplace/plugins/merchant-marketing/scripts/upgrade-installed-plugin.test.ts
demo/merchant-studio/package.json
demo/merchant-studio/src/App.tsx
demo/merchant-studio/scripts/verify-production-copy.mjs
demo/merchant-studio/scripts/verify-production-copy.test.mjs
infra/scripts/deploy-preflight-ecs.sh
infra/scripts/deploy-preflight.sh
infra/scripts/check-mcp-integration-production.mjs
tests/mcp-integration-production-script.test.ts
infra/scripts/verify-ecs-ops-auth-mode.sh
packages/ai/src/embedding.ts
packages/ai/src/generator.ts
packages/ai/src/image-editor.ts
packages/ai/src/image-facts.ts
packages/ai/src/image-generator.ts
packages/ai/src/image-generator.test.ts
packages/ai/src/relay-usage.ts
packages/ai/src/relay-usage.test.ts
packages/ai/src/video-generator.ts
packages/contracts/src/ops/feature-flags.ts
packages/contracts/src/ops/feature-flags.test.ts
packages/persistence/src/migration.test.ts
packages/persistence/src/postgres-scope-fixture-cleanup.ts
packages/persistence/src/migration-245.test.ts
packages/persistence/src/local-plugin-install-rls.release.postgres.test.ts
scripts/model-relay-canary.ts
scripts/release-manifest.ts
scripts/scanner-callback-canary.mjs
scripts/scanner-callback-canary.test.mjs
scripts/scanner-callback-canary-evidence.ts
tests/ecs-compose-deploy-runner.test.ts
tests/ecs-compose-published-ports.test.ts
tests/ecs-release-images-build.test.ts
tests/model-relay-contract.test.ts
tests/plugin-upgrade-path.test.ts
tests/production-evidence-gate.test.ts
tests/production-evidence-gate.ts
tests/release-manifest-gate.test.ts
tests/release-manifest-gate.ts
tests/release-manifest.test.ts
tests/test-suite-isolation.ts
.github/workflows/ci.yml
docs/runbooks/ecs-candidate-safe-sync.md
docs/runbooks/scanner-callback-canary.md
AGENTS.md
infra/scripts/prepare-ecs-candidate-bundle.sh
tests/ecs-candidate-bundle-contract.test.ts
tests/local-compose-ops-ui.test.ts
tests/test-entrypoint-coverage.ts
tests/scanner-callback-canary-evidence.test.ts
docs/chatgpt-host-canary-runbook.md
docs/runbooks/chatgpt-candidate-host-route.md
infra/scripts/chatgpt-candidate-fetch-route.d.mts
infra/scripts/chatgpt-candidate-fetch-route.mjs
scripts/collect-codex-app-host-evidence.mjs
tests/chatgpt-candidate-fetch-route.test.ts
tests/codex-app-host-evidence-gate.test.ts
tests/codex-app-host-evidence-gate.ts
tests/operations-scripts.test.ts
apps/worker/src/scanner-heartbeat.ts
apps/worker/src/scanner-container-healthcheck.ts
apps/worker/src/scanner-container-healthcheck.test.ts
demo/merchant-studio/src/manual-platform-account-discovery.test.ts
infra/scripts/validate-production-config-yaml.rb
infra/protected/ecs-bridge-b-journal-store.mjs
infra/protected/ecs-bridge-b-journal-store.d.mts
infra/protected/ecs-bridge-b-transition.mjs
infra/protected/ecs-bridge-b-transition.d.mts
packages/workers/src/scanner-heartbeat.ts
packages/workers/src/scanner-heartbeat.test.ts
tests/ecs-compose-rollback.test.ts
tests/mcp-integration-mode-release-gate.test.ts
tests/ecs-bridge-b-transition.test.ts
tests/run-ecs-bridge-b-host-cli.sh
tests/fixtures/ecs-bridge-b-host-cli/curl.mjs
tests/fixtures/ecs-bridge-b-host-cli/docker.mjs
tests/fixtures/ecs-bridge-b-host-cli/nonce-consumer.mjs
tests/fixtures/ecs-bridge-b-host-cli/psql.mjs
tests/fixtures/ecs-bridge-b-host-cli/run.mjs
tests/fixtures/ecs-bridge-b-host-cli/setup.mjs
docs/runbooks/ecs-bridge-b-package.md
docs/runbooks/ecs-bridge-b-unlabeled-rollback.md
EOF

# The migration registry, both UI images, and their reverse-proxy configs are
# release inputs even when a hand-curated manifest already names one of them.
# Add every tracked input once so remote comparison cannot silently omit build
# dependencies or produce duplicate report rows.
scope_list=$(mktemp "${TMPDIR:-/tmp}/ecs-candidate-manifest.XXXXXX")
trap 'rm -f "$scope_list"' 0 HUP INT TERM
for scope in packages/persistence/src/migrations apps/ops-console demo/merchant-studio infra/docker infra/nginx; do
  git -C "$root" ls-files -- "$scope" > "$scope_list"
  while IFS= read -r path; do
    if ! grep -Fxq "$path" "$manifest"; then
      printf '%s\n' "$path" >> "$manifest"
    fi
  done < "$scope_list"
done
rm -f "$scope_list"
trap - 0 HUP INT TERM

while IFS= read -r path; do
  [ -f "$root/$path" ] || {
    echo "candidate file is missing locally: $path" >&2
    exit 1
  }
done < "$manifest"

printf 'status\tlocal_sha256\tremote_sha256\tpath\n' > "$report"
# Read all remote checksums through one SSH connection. A full migration
# inventory otherwise establishes hundreds of connections for one review.
remote_checksums="$output_dir/remote-checksums.txt"
ssh "$remote_alias" "cd '$remote_root' && while IFS= read -r path; do if [ -f \"\$path\" ]; then sha256sum \"\$path\"; else printf 'MISSING  %s\\n' \"\$path\"; fi; done" < "$manifest" > "$remote_checksums"
while IFS= read -r path; do
  local_sha=$(shasum -a 256 "$root/$path" | awk '{print $1}')
  remote_line=$(awk -v wanted="$path" '$2 == wanted { print; exit }' "$remote_checksums")
  [ -n "$remote_line" ] || { echo "remote checksum missing: $path" >&2; exit 1; }
  remote_sha=$(printf '%s\n' "$remote_line" | awk '{print $1}')
  if [ "$remote_sha" = MISSING ]; then
    status=missing_remote
    remote_sha=-
  elif [ "$local_sha" = "$remote_sha" ]; then
    status=same
  else
    status=review_required
  fi
  printf '%s\t%s\t%s\t%s\n' "$status" "$local_sha" "$remote_sha" "$path" >> "$report"
done < "$manifest"

printf '%s\n' "$revision" > "$output_dir/source-head.txt"
# Match build-ecs-candidate-gates-image.sh exactly: the canonical source
# artifact is the complete committed tree, not a hand-maintained subset of the
# current working directory. Its digest can therefore be compared directly
# with the candidate image's source_sha256 OCI label.
# The ECS source archive is a runtime/release input, not a copy of the
# repository's generated delivery evidence. Keep the digest algorithm identical
# to build-ecs-candidate-gates-image.sh while excluding large non-runtime
# material that is attested and delivered separately. Dogfood scripts and
# contracts remain in the source archive because release verification imports
# their markdown/spec fixtures; only their large generated media belongs in
# the separately attested evidence bundle.
if [ "$cloud_source_v2" = 1 ]; then
  git -C "$root" archive --format=tar "$revision" \
    ':(exclude)artifacts' ':(exclude)screenshots' ':(exclude)apps/plugin' ':(exclude).codex-marketplace' > "$archive"
  cp "$ECS_PLUGIN_DARWIN_DESCRIPTOR_PATH" "$output_dir/plugin-release-descriptor-darwin.json"
  cp "$ECS_PLUGIN_DARWIN_TEST_PATH" "$output_dir/local-plugin-test-attestation-darwin.json"
  cp "$ECS_PLUGIN_WIN32_DESCRIPTOR_PATH" "$output_dir/plugin-release-descriptor-win32.json"
  cp "$ECS_PLUGIN_WIN32_TEST_PATH" "$output_dir/local-plugin-test-attestation-win32.json"
  darwin_descriptor_sha=$(shasum -a 256 "$output_dir/plugin-release-descriptor-darwin.json" | awk '{print $1}')
  darwin_test_sha=$(shasum -a 256 "$output_dir/local-plugin-test-attestation-darwin.json" | awk '{print $1}')
  win32_descriptor_sha=$(shasum -a 256 "$output_dir/plugin-release-descriptor-win32.json" | awk '{print $1}')
  win32_test_sha=$(shasum -a 256 "$output_dir/local-plugin-test-attestation-win32.json" | awk '{print $1}')
else
  git -C "$root" archive --format=tar "$revision" \
    ':(exclude)artifacts' ':(exclude)screenshots' > "$archive"
fi
archive_sha=$(shasum -a 256 "$archive" | awk '{print $1}')
manifest_sha=$(shasum -a 256 "$manifest" | awk '{print $1}')
report_sha=$(shasum -a 256 "$report" | awk '{print $1}')
printf '%s  %s\n' "$archive_sha" "$(basename "$archive")" > "$archive.sha256"
cat > "$output_dir/candidate-identity.txt" <<EOF
git_sha=$revision
source_sha256=sha256:$archive_sha
comparison_manifest_sha256=sha256:$manifest_sha
sync_plan_sha256=sha256:$report_sha
EOF
if [ "$cloud_source_v2" = 1 ]; then
  printf 'schema_version=candidate-identity/2\nrelease_id=%s\nplugin_darwin_descriptor_sha256=sha256:%s\nplugin_darwin_test_sha256=sha256:%s\nplugin_win32_descriptor_sha256=sha256:%s\nplugin_win32_test_sha256=sha256:%s\nplugin_key_id=%s\n' \
    "$RELEASE_ID" "$darwin_descriptor_sha" "$darwin_test_sha" "$win32_descriptor_sha" "$win32_test_sha" "$ECS_PLUGIN_KEY_ID" >> "$output_dir/candidate-identity.txt"
fi

cat > "$output_dir/README.txt" <<'EOF'
This review candidate must be materialized by
infra/scripts/stage-verified-ecs-release.sh before deployment. candidate-source.tar
is the committed source tree (v2 excludes local plugin code). candidate-identity.txt binds its Git SHA,
source digest, comparison manifest and sync plan; the source digest must equal
the candidate gate image's com.storenova.candidate.source_sha256 label.

Safety rules:
1. Do not rsync or extract this archive over /opt/merchant-deploy. Stage it to
   a new repository-external release directory with the verified staging script.
2. A review_required file must be merged against the remote copy. In
   particular, docker-compose.ecs-pilot.yml may contain server-only platform
   connector and secret wiring that must not be removed.
3. Do not bundle .env, secret files, private keys, access keys, webhook
   secrets, OAuth secrets, or generated production evidence.
4. Production evidence must be generated for the exact release identity and
   signed by the provisioned trust boundary; repository examples are invalid.
5. Run pilot-compose-preflight.sh and the targeted tests before any cutover.
6. This candidate is ECS-only. Kubernetes manifests, ACK/RRSA configuration,
   and kubectl workflows are outside its scope.
7. Alerts are disabled for this candidate. Do not enable the alerts profile or
   require alert delivery evidence. Deploy to a sidecar/candidate service first;
   require readiness, OSS canary, authorization, and rollback evidence before
   replacing the healthy API.
EOF

printf 'candidate bundle prepared locally: %s\n' "$output_dir"
printf 'remote access was read-only; no server files or services were changed\n'
