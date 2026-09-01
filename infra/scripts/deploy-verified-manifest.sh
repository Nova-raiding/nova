#!/bin/sh
set -eu

root=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
: "${RENDERED_MANIFEST_PATH:?RENDERED_MANIFEST_PATH is required}"
: "${PRODUCTION_CONFIG_PATH:?PRODUCTION_CONFIG_PATH is required}"
: "${DEPLOYMENT_NONCE:?DEPLOYMENT_NONCE is required}"
[ -f "$RENDERED_MANIFEST_PATH" ] || { echo "rendered manifest not found: $RENDERED_MANIFEST_PATH" >&2; exit 1; }
[ -f "$PRODUCTION_CONFIG_PATH" ] || { echo "production config not found: $PRODUCTION_CONFIG_PATH" >&2; exit 1; }

source_manifest=$RENDERED_MANIFEST_PATH
source_config=$PRODUCTION_CONFIG_PATH
verified_manifest=$(mktemp "${TMPDIR:-/tmp}/merchant-verified-manifest.XXXXXX")
verified_config=$(mktemp "${TMPDIR:-/tmp}/merchant-verified-config.XXXXXX")
trap 'rm -f -- "$verified_manifest" "$verified_config"' EXIT
source_before=$(shasum -a 256 "$source_manifest" | awk '{print $1}')
config_source_before=$(shasum -a 256 "$source_config" | awk '{print $1}')
cp "$source_manifest" "$verified_manifest"
cp "$source_config" "$verified_config"
source_after=$(shasum -a 256 "$source_manifest" | awk '{print $1}')
config_source_after=$(shasum -a 256 "$source_config" | awk '{print $1}')
before=$(shasum -a 256 "$verified_manifest" | awk '{print $1}')
config_before=$(shasum -a 256 "$verified_config" | awk '{print $1}')
[ "$source_before" = "$source_after" ] && [ "$source_before" = "$before" ] || { echo 'rendered manifest changed while creating the verified deployment copy' >&2; exit 1; }
[ "$config_source_before" = "$config_source_after" ] && [ "$config_source_before" = "$config_before" ] || { echo 'production config changed while creating the verified deployment copy' >&2; exit 1; }
RENDERED_MANIFEST_PATH=$verified_manifest
PRODUCTION_CONFIG_PATH=$verified_config
export RENDERED_MANIFEST_PATH
export PRODUCTION_CONFIG_PATH
sh "$root/infra/scripts/deploy-preflight.sh" "$PRODUCTION_CONFIG_PATH"
image_set_digest=$(sh "$root/infra/scripts/validate-kubernetes-release.sh" "$RENDERED_MANIFEST_PATH" "${IMAGE_DIGESTS_JSON:?IMAGE_DIGESTS_JSON is required}" --print-image-set-digest)
after=$(shasum -a 256 "$RENDERED_MANIFEST_PATH" | awk '{print $1}')
config_after=$(shasum -a 256 "$PRODUCTION_CONFIG_PATH" | awk '{print $1}')
[ "$before" = "$after" ] || { echo 'rendered manifest changed after verification; deployment refused' >&2; exit 1; }
[ "$config_before" = "$config_after" ] || { echo 'production config changed after verification; deployment refused' >&2; exit 1; }

release_git_sha=$(git -C "$root" rev-parse HEAD)
IMAGE_DIGEST="$image_set_digest" PRODUCTION_EVIDENCE_MANIFEST_SHA256="$after" RELEASE_GIT_SHA="$release_git_sha" PRODUCTION_EVIDENCE_REPO_ROOT="$root" \
  sh "$root/infra/scripts/consume-production-evidence-nonce.sh"
after_nonce=$(shasum -a 256 "$RENDERED_MANIFEST_PATH" | awk '{print $1}')
[ "$after" = "$after_nonce" ] || { echo 'verified manifest changed while consuming deployment nonce; deployment refused' >&2; exit 1; }

# Run the owner-credential migration Job before runtime workloads are created.
# The selector reads the Job from the already verified manifest bytes. Runtime
# pods never reference merchant-migration-secrets.
migration_selector='merchant.example.com/deployment-phase=migration'
if kubectl get job merchant-schema-migration -n merchant >/dev/null 2>&1; then
  active=$(kubectl get job merchant-schema-migration -n merchant -o jsonpath='{.status.active}')
  [ -z "$active" ] || [ "$active" = 0 ] || { echo 'an earlier schema migration Job is still active; deployment refused' >&2; exit 1; }
  kubectl delete job merchant-schema-migration -n merchant --wait=true
fi
kubectl apply -f "$RENDERED_MANIFEST_PATH" --selector "$migration_selector"
kubectl wait --for=condition=complete job/merchant-schema-migration -n merchant --timeout="${MIGRATION_TIMEOUT:-10m}"

# Apply the exact verified bytes only after migration success. Re-rendering the
# overlay here would break the evidence binding and is intentionally forbidden.
kubectl apply -f "$RENDERED_MANIFEST_PATH"
# Runtime provenance cannot embed the hash of the manifest that contains it
# (that would be self-referential). Inject the already verified bindings as a
# controlled Deployment revision, then require /releasez to report them before
# the release is accepted. The image remains the digest-pinned verified image.
kubectl set env deployment/merchant-api -n merchant --containers=api \
  "RELEASE_ID=$RELEASE_ID" \
  "RELEASE_GIT_SHA=$release_git_sha" \
  "RELEASE_MANIFEST_SHA256=$after" \
  "RELEASE_IMAGE_SET_DIGEST=$image_set_digest"
for deployment in \
  merchant-api merchant-ui merchant-ops-ui \
  merchant-worker-sync merchant-worker-generation merchant-worker-publish \
  merchant-worker-reconcile merchant-worker-automation merchant-worker-scan
do
  kubectl rollout status "deployment/$deployment" -n merchant --timeout="${ROLLOUT_TIMEOUT:-10m}"
done

# Execute role-specific acceptance from the deployed worker images. A
# generation pod must never be widened to the aggregate role because that would
# test a topology and credential set that production does not run.
: "${PRODUCTION_CANARY_WORKSPACE_ID:?PRODUCTION_CANARY_WORKSPACE_ID is required for worker acceptance}"
kubectl exec -n merchant deployment/merchant-worker-generation -c worker -- env WORKER_ROLE=generation WORKER_ONCE=true "WORKER_WORKSPACES=$PRODUCTION_CANARY_WORKSPACE_ID" node --input-type=module -e '
  const { readWorkerConfig } = await import("./dist/apps/worker/src/main.js")
  const { loadMigrations } = await import("./dist/packages/persistence/src/migration.js")
  const { Pool } = await import("pg")
  const config = readWorkerConfig(process.env)
  if (config.role !== "generation") throw new Error("generation acceptance ran with the wrong worker role")
  const expected = await loadMigrations()
  const pool = new Pool({ connectionString: config.databaseUrl, max: 1 })
  try {
    const result = await pool.query("SELECT max(version)::int AS version FROM schema_migrations")
    if (Number(result.rows[0]?.version) !== expected.at(-1)?.version) throw new Error("generation worker migration compatibility failed")
  } finally { await pool.end() }
' >/dev/null

# Every scanner replica must prove the real scan role, live dependency
# heartbeat, fresh ClamAV/EICAR state, accepted callback capability, and the
# timestamp+nonce+body-digest HMAC contract used by both scanner API requests.
scanner_pods=$(kubectl get pods -n merchant -l app.kubernetes.io/name=merchant-worker-scan -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}')
scanner_pod_count=$(printf '%s\n' "$scanner_pods" | awk 'NF { count += 1 } END { print count + 0 }')
[ "$scanner_pod_count" -ge 2 ] || { echo 'scanner acceptance requires at least two deployed scanner pods' >&2; exit 1; }
for scanner_pod in $scanner_pods; do
  # shellcheck disable=SC2016 # JavaScript is intentionally single-quoted for remote execution.
  kubectl exec -n merchant "$scanner_pod" -c worker -- env WORKER_ROLE=scan WORKER_ONCE=true "WORKER_WORKSPACES=$PRODUCTION_CANARY_WORKSPACE_ID" node --input-type=module -e '
    const { createHash, createHmac } = await import("node:crypto")
    const { readFile } = await import("node:fs/promises")
    const { executeAssetScan, readWorkerConfig } = await import("./dist/apps/worker/src/main.js")
    const config = readWorkerConfig(process.env)
    if (config.role !== "scan") throw new Error("scanner acceptance ran with the wrong worker role")
    for (const name of ["ASSET_SCANNER_API_TOKEN", "ASSET_SCANNER_WORKSPACE_SIGNING_SECRET", "ASSET_SCAN_RECEIPT_KEY_ID", "ASSET_SCAN_POLICY_VERSION", "CLAMAV_HOST"]) if (!process.env[name]?.trim()) throw new Error(`scanner configuration missing: ${name}`)
    const heartbeat = JSON.parse(await readFile(process.env.WORKER_READY_FILE, "utf8"))
    if (!heartbeat.ready || heartbeat.schemaVersion !== "scanner-heartbeat/1.0" || heartbeat.instanceId !== process.env.HOSTNAME) throw new Error("scanner heartbeat is not ready or is not bound to this pod")
    if (!heartbeat.checks?.databaseReady || !heartbeat.checks?.redisReady || !heartbeat.checks?.apiReady) throw new Error("scanner dependencies are not ready")
    if (!heartbeat.clamav?.reachable || !heartbeat.clamav?.engineVersion || !heartbeat.clamav?.definitionsVersion || !heartbeat.clamav?.definitionsPublishedAt) throw new Error("ClamAV engine or definitions evidence is missing")
    if (!heartbeat.eicar?.passed || heartbeat.eicar?.signature !== "Eicar-Test-Signature" || !heartbeat.eicar?.checkedAt) throw new Error("ClamAV EICAR evidence is missing")
    if (!heartbeat.callback?.configured || !heartbeat.callback?.capable || !heartbeat.callback?.lastAcceptedAt) throw new Error("scanner callback capability has not been proven")
    if (Date.parse(heartbeat.expiresAt) <= Date.now()) throw new Error("scanner heartbeat is stale")

    const workspaceId = "release_canary"
    const event = { id: "evt_release_scanner_contract", workspaceId, aggregateId: "asset_release_scanner_contract", sequence: 1, eventType: "asset.uploaded", payload: { asset_id: "asset_release_scanner_contract", storage_key: `quarantine/${workspaceId}/asset/file.bin`, sha256: "a".repeat(64), size_bytes: 1 } }
    const secret = process.env.ASSET_SCANNER_WORKSPACE_SIGNING_SECRET
    const observed = []
    const verifyProof = (method, path, body, init) => {
      const headers = new Headers(init.headers)
      const timestamp = headers.get("x-scanner-timestamp") ?? ""
      const nonce = headers.get("x-scanner-nonce") ?? ""
      const digest = headers.get("x-scanner-body-sha256") ?? ""
      const signature = headers.get("x-scanner-workspace-signature") ?? ""
      if (!/^\d{10}$/.test(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 60) throw new Error("scanner HMAC timestamp is missing or stale")
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) throw new Error("scanner HMAC nonce is missing")
      if (digest !== createHash("sha256").update(body).digest("hex")) throw new Error("scanner HMAC body digest is invalid")
      const expected = createHmac("sha256", secret).update([method, path, workspaceId, timestamp, nonce, digest].join("\n")).digest("hex")
      if (signature !== expected) throw new Error("scanner HMAC signature is invalid")
      observed.push(nonce)
    }
    const base = { apiBaseUrl: "https://scanner-contract.invalid", apiToken: "token", apiSigningSecret: secret, receiptPrivateKeyPem: "unused", receiptKeyId: "release-key", scannerServiceId: "merchant-asset-scanner", scannerInstanceId: process.env.HOSTNAME, policyVersion: process.env.ASSET_SCAN_POLICY_VERSION, clamavHost: process.env.CLAMAV_HOST, clamavPort: Number(process.env.CLAMAV_PORT ?? 3310), clamavTimeoutMs: 1000, event }
    const emptyRepository = { getByOutboxEvent: async () => null }
    await executeAssetScan({ ...base, attemptRepository: emptyRepository, fetcher: async (_url, init) => { const path = `/v1/internal/assets/${event.aggregateId}/scan-content`; verifyProof("GET", path, "", init); return new Response(null, { status: 409 }) } })
    const callbackBody = JSON.stringify({ receipt: { receipt_id: "scan_release", subject: { workspace_id: workspaceId, asset_id: event.aggregateId, object_key: event.payload.storage_key, sha256: event.payload.sha256, size_bytes: event.payload.size_bytes }, scan: { verdict: "clean" } }, signature: "release-signature" })
    const attempt = { outboxEventId: event.id, assetSourceRevision: 1, receiptDigest: "b".repeat(64), callbackBody, callbackStatus: "pending", receipt: JSON.parse(callbackBody).receipt }
    const callbackRepository = { getByOutboxEvent: async () => attempt, recordCallbackAttempt: async () => undefined, recordCallbackFailure: async () => undefined, markCallbackAccepted: async () => undefined }
    await executeAssetScan({ ...base, attemptRepository: callbackRepository, fetcher: async (_url, init) => { const path = `/v1/internal/assets/${event.aggregateId}/scan-result`; verifyProof("POST", path, callbackBody, init); return new Response("{}", { status: 200, headers: { "content-type": "application/json" } }) } })
    if (observed.length !== 2 || observed[0] === observed[1]) throw new Error("scanner HMAC nonces are not unique per request")
  ' >/dev/null
done

: "${PRODUCTION_API_BASE_URL:?PRODUCTION_API_BASE_URL is required for post-deploy health verification}"
printf '%s' "$PRODUCTION_API_BASE_URL" | grep -Eq '^https://' || { echo 'PRODUCTION_API_BASE_URL must use HTTPS' >&2; exit 1; }
curl --fail --silent --show-error --max-time 15 "${PRODUCTION_API_BASE_URL%/}/livez" >/dev/null
curl --fail --silent --show-error --max-time 15 "${PRODUCTION_API_BASE_URL%/}/readyz" >/dev/null
: "${PRODUCTION_CANARY_BEARER_TOKEN:?PRODUCTION_CANARY_BEARER_TOKEN is required for the deployed business-path canary}"
release_payload=$(curl --fail --silent --show-error --max-time 15 "${PRODUCTION_API_BASE_URL%/}/releasez")
EXPECTED_RELEASE_ID="$RELEASE_ID" EXPECTED_RELEASE_GIT_SHA="$release_git_sha" EXPECTED_MANIFEST_SHA256="$after" EXPECTED_IMAGE_SET_DIGEST="$image_set_digest" \
  node -e 'const fs=require("fs");const body=JSON.parse(fs.readFileSync(0,"utf8"));const got=body.data?.release??body.release;const expected={release_id:process.env.EXPECTED_RELEASE_ID,release_git_sha:process.env.EXPECTED_RELEASE_GIT_SHA,manifest_sha256:process.env.EXPECTED_MANIFEST_SHA256,image_set_digest:process.env.EXPECTED_IMAGE_SET_DIGEST};if(!got||Object.entries(expected).some(([k,v])=>got[k]!==v)){console.error("deployed release metadata does not match the verified release");process.exit(1)}' <<EOF
$release_payload
EOF
# Exercise an authenticated, database-backed route on the deployed API. This
# prevents a healthy ingress plus runner-local connector code from being
# accepted as proof that the deployed business application works.
curl --fail --silent --show-error --max-time 20 \
  -H "authorization: Bearer $PRODUCTION_CANARY_BEARER_TOKEN" \
  -H "x-workspace-id: $PRODUCTION_CANARY_WORKSPACE_ID" \
  "${PRODUCTION_API_BASE_URL%/}/v1/products?limit=1&offset=0" >/dev/null

: "${POST_DEPLOY_CANARY_OUTPUT:?POST_DEPLOY_CANARY_OUTPUT is required}"
PLATFORM_CANARY_BASE_EVIDENCE="$CAPABILITY_EVIDENCE_PATH" \
PLATFORM_CANARY_OUTPUT="$POST_DEPLOY_CANARY_OUTPUT" \
PRODUCTION_API_BASE_URL="$PRODUCTION_API_BASE_URL" \
RELEASE_GIT_SHA="$release_git_sha" \
RELEASE_MANIFEST_SHA256="$after" \
RELEASE_IMAGE_SET_DIGEST="$image_set_digest" \
  sh "$root/infra/scripts/run-production-canary.sh"

trust_dir=/run/release-security/evidence-trust
if [ "${PRODUCTION_EVIDENCE_TEST_HOOK:-}" = enabled-for-local-tests-only ] && [ "${NODE_ENV:-}" = test ]; then trust_dir=${PRODUCTION_EVIDENCE_TEST_TRUST_DIR:-$trust_dir}; fi
trusted_key_id=$(sed -n '1p' "$trust_dir/production-evidence-key-id")
npx --no-install tsx "$root/tests/capability-evidence-gate.ts" --file "$POST_DEPLOY_CANARY_OUTPUT" --require-canary --require-signed-production \
  --release-id "$RELEASE_ID" --image-set-digest "$image_set_digest" --manifest-sha256 "$after" --release-git-sha "$release_git_sha" \
  --deployment-nonce "$DEPLOYMENT_NONCE" --public-key "$trust_dir/production-evidence-public.pem" --key-id "$trusted_key_id"

echo "verified manifest rollout and post-deploy canary passed: sha256=$after release_id=$RELEASE_ID canary=$POST_DEPLOY_CANARY_OUTPUT"
