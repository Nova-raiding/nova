#!/bin/sh
set -eu

[ "${PRODUCTION_EVIDENCE_TEST_HOOK+x}" != x ] || { echo "production evidence test hooks are forbidden during rollback" >&2; exit 1; }
[ "${PRODUCTION_EVIDENCE_TEST_TRUST_DIR+x}" != x ] || { echo "production evidence test paths are forbidden during rollback" >&2; exit 1; }
[ "${PRODUCTION_EVIDENCE_TEST_CAPABILITY_ATTESTER+x}" != x ] || { echo "production evidence test paths are forbidden during rollback" >&2; exit 1; }

root=$(CDPATH='' cd -- "$(dirname "$0")/../.." && pwd)
: "${RELEASE_ID:?RELEASE_ID is required}"
: "${CONFIRM_ROLLBACK:?Set CONFIRM_ROLLBACK=YES to rollback}"
: "${ROLLBACK_RELEASE_BUNDLE_PATH:?ROLLBACK_RELEASE_BUNDLE_PATH is required}"
: "${PRODUCTION_EVIDENCE_ARTIFACT_ROOT:?PRODUCTION_EVIDENCE_ARTIFACT_ROOT is required}"
: "${POST_ROLLBACK_CANARY_OUTPUT:?POST_ROLLBACK_CANARY_OUTPUT is required}"
: "${PRODUCTION_API_BASE_URL:?PRODUCTION_API_BASE_URL is required}"
[ "$CONFIRM_ROLLBACK" = YES ] || { echo "rollback refused" >&2; exit 2; }
printf '%s\n' "$RELEASE_ID" | grep -Eq '^[A-Za-z0-9._-]+$' || { echo "RELEASE_ID contains unsafe characters" >&2; exit 1; }
[ -f "$ROLLBACK_RELEASE_BUNDLE_PATH" ] || { echo "signed rollback release bundle not found: $ROLLBACK_RELEASE_BUNDLE_PATH" >&2; exit 1; }
printf '%s\n' "$PRODUCTION_API_BASE_URL" | grep -Eq '^https://' || { echo "PRODUCTION_API_BASE_URL must use HTTPS" >&2; exit 1; }

verified_manifest=$(mktemp "${TMPDIR:-/tmp}/merchant-rollback-manifest.XXXXXX")
descriptor=$(mktemp "${TMPDIR:-/tmp}/merchant-rollback-descriptor.XXXXXX")
compatibility_pod=
cleanup() {
  rm -f -- "$verified_manifest" "$descriptor"
  if [ -n "$compatibility_pod" ]; then kubectl delete pod "$compatibility_pod" -n merchant --ignore-not-found=true --wait=false >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
trust_dir=/run/release-security/evidence-trust
sh "$root/infra/scripts/validate-production-evidence-trust.sh" "$root"
trusted_key_id=$(sed -n '1p' "$trust_dir/production-evidence-key-id")
npx --no-install tsx "$root/tests/release-bundle-gate.ts" --file "$ROLLBACK_RELEASE_BUNDLE_PATH" --release-id "$RELEASE_ID" \
  --artifact-root "$PRODUCTION_EVIDENCE_ARTIFACT_ROOT" --public-key "$trust_dir/production-evidence-public.pem" --key-id "$trusted_key_id" --descriptor-out "$descriptor"
field() { node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const result=value[process.argv[2]];process.stdout.write(typeof result==="string"?result:JSON.stringify(result))' "$descriptor" "$1"; }
ROLLBACK_MANIFEST_PATH=$(field manifest_path)
ROLLBACK_MANIFEST_SHA256=$(field manifest_sha256)
ROLLBACK_IMAGE_DIGESTS_JSON=$(field image_digests)
ROLLBACK_CAPABILITY_EVIDENCE_PATH=$(field capability_evidence_path)
release_git_sha=$(field release_git_sha)
image_set_digest=$(field image_set_digest)
source_before=$(shasum -a 256 "$ROLLBACK_MANIFEST_PATH" | awk '{print $1}')
[ "$source_before" = "$ROLLBACK_MANIFEST_SHA256" ] || { echo "signed rollback manifest checksum mismatch" >&2; exit 1; }
cp "$ROLLBACK_MANIFEST_PATH" "$verified_manifest"
source_after=$(shasum -a 256 "$ROLLBACK_MANIFEST_PATH" | awk '{print $1}')
verified_sha=$(shasum -a 256 "$verified_manifest" | awk '{print $1}')
[ "$source_before" = "$source_after" ] && [ "$source_before" = "$verified_sha" ] || { echo "rollback manifest changed during verification" >&2; exit 1; }
sh "$root/infra/scripts/validate-kubernetes-release.sh" "$verified_manifest" "$ROLLBACK_IMAGE_DIGESTS_JSON" --rollback >/dev/null
npx --no-install tsx "$root/tests/capability-evidence-gate.ts" --file "$ROLLBACK_CAPABILITY_EVIDENCE_PATH" --require-canary --require-signed-production --release-id "$RELEASE_ID" \
  --image-set-digest "$image_set_digest" --manifest-sha256 "$verified_sha" --release-git-sha "$release_git_sha" --deployment-nonce "${DEPLOYMENT_NONCE:?DEPLOYMENT_NONCE is required}" \
  --public-key "$trust_dir/production-evidence-public.pem" --key-id "$trusted_key_id"
IMAGE_DIGEST="$image_set_digest" PRODUCTION_EVIDENCE_MANIFEST_SHA256="$verified_sha" RELEASE_GIT_SHA="$release_git_sha" PRODUCTION_EVIDENCE_REPO_ROOT="$root" \
  sh "$root/infra/scripts/consume-production-evidence-nonce.sh"

# Database migrations are forward-only. Rollback restores only the previously
# verified runtime image set; it never executes a schema downgrade. Before any
# workload mutation, run the rollback worker image against the live forward
# schema and scanner protocol. A runtime that does not understand migrations
# 084 through the live tail, immutable scan receipts, durable attempts, or the
# timestamp+nonce+body-digest HMAC contract is forbidden.
rollback_worker_image=$(ruby -ryaml -e '
  docs = YAML.load_stream(File.read(ARGV.fetch(0)))
  deployment = docs.compact.find { |doc| doc.is_a?(Hash) && doc["kind"] == "Deployment" && doc.dig("metadata", "name") == "merchant-worker-scan" }
  worker = deployment&.dig("spec", "template", "spec", "containers")&.find { |container| container["name"] == "worker" }
  abort "rollback manifest does not contain merchant-worker-scan worker image" unless worker && worker["image"].to_s.match?(/@sha256:[a-f0-9]{64}\z/)
  print worker["image"]
' "$verified_manifest")
source_scanner_pod=$(kubectl get pods -n merchant -l app.kubernetes.io/name=merchant-worker-scan -o jsonpath='{.items[0].metadata.name}')
[ -n "$source_scanner_pod" ] || { echo 'a live scanner pod is required to build the isolated rollback compatibility probe' >&2; exit 1; }
compatibility_suffix=$(printf '%s' "$RELEASE_ID" | shasum -a 256 | cut -c1-16)
compatibility_pod="merchant-rollback-compat-$compatibility_suffix"
kubectl delete pod "$compatibility_pod" -n merchant --ignore-not-found=true --wait=true >/dev/null
# shellcheck disable=SC2016 # JavaScript is intentionally single-quoted for the compatibility pod builder.
kubectl get pod "$source_scanner_pod" -n merchant -o json | ROLLBACK_COMPATIBILITY_POD="$compatibility_pod" ROLLBACK_WORKER_IMAGE="$rollback_worker_image" node -e '
  const fs = require("fs")
  const source = JSON.parse(fs.readFileSync(0, "utf8"))
  const worker = source.spec.containers.find(container => container.name === "worker")
  if (!worker) throw new Error("live scanner pod has no worker container")
  const compatibilityProgram = `
    const { createHash, createHmac } = await import("node:crypto")
    const { Pool } = await import("pg")
    const migrationsModule = await import("./dist/packages/persistence/src/migration.js")
    const receiptModule = await import("./dist/packages/security/src/asset-scan-receipt.js")
    const persistenceModule = await import("./dist/packages/persistence/src/index.js")
    const workerModule = await import("./dist/apps/worker/src/main.js")
    if (receiptModule.ASSET_SCAN_RECEIPT_SCHEMA !== "asset-scan-receipt/1.0" || typeof receiptModule.parseAssetScanReceipt !== "function" || typeof receiptModule.canonicalAssetScanReceipt !== "function") throw new Error("rollback image lacks immutable scan receipt compatibility")
    if (typeof persistenceModule.PostgresAssetScanAttemptRepository !== "function") throw new Error("rollback image lacks durable scan attempt compatibility")
    if (typeof workerModule.executeAssetScan !== "function") throw new Error("rollback image lacks scanner execution compatibility")
    const migrations = await migrationsModule.loadMigrations()
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
    let liveTail
    try { liveTail = Number((await pool.query("SELECT max(version)::int AS version FROM schema_migrations")).rows[0]?.version) } finally { await pool.end() }
    if (!Number.isInteger(liveTail) || liveTail < 84) throw new Error("live database is missing scanner migration 084")
    const versions = new Set(migrations.map(item => item.version))
    for (let version = 84; version <= liveTail; version += 1) if (!versions.has(version)) throw new Error(\`rollback image is incompatible with live migration \${version}\`)
    if ((migrations.at(-1)?.version ?? 0) < liveTail) throw new Error("rollback image migration tail is older than the live database")

    const workspaceId = "rollback_canary"
    const event = { id: "evt_rollback_scanner_contract", workspaceId, aggregateId: "asset_rollback_scanner_contract", sequence: 1, eventType: "asset.uploaded", payload: { asset_id: "asset_rollback_scanner_contract", storage_key: \`quarantine/\${workspaceId}/asset/file.bin\`, sha256: "a".repeat(64), size_bytes: 1 } }
    const secret = process.env.ASSET_SCANNER_WORKSPACE_SIGNING_SECRET
    if (!secret) throw new Error("rollback scanner signing secret is unavailable")
    const observed = []
    const verifyProof = (method, path, body, init) => {
      const headers = new Headers(init.headers)
      const timestamp = headers.get("x-scanner-timestamp") ?? ""
      const nonce = headers.get("x-scanner-nonce") ?? ""
      const digest = headers.get("x-scanner-body-sha256") ?? ""
      const signature = headers.get("x-scanner-workspace-signature") ?? ""
      if (!/^\\d{10}$/.test(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 60) throw new Error("rollback scanner HMAC timestamp is missing or stale")
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) throw new Error("rollback scanner HMAC nonce is missing")
      if (digest !== createHash("sha256").update(body).digest("hex")) throw new Error("rollback scanner HMAC body digest is invalid")
      const expected = createHmac("sha256", secret).update([method, path, workspaceId, timestamp, nonce, digest].join("\\n")).digest("hex")
      if (signature !== expected) throw new Error("rollback scanner HMAC signature is invalid")
      observed.push(nonce)
    }
    const base = { apiBaseUrl: "https://rollback-scanner-contract.invalid", apiToken: "token", apiSigningSecret: secret, receiptPrivateKeyPem: "unused", receiptKeyId: "rollback-key", scannerServiceId: "merchant-asset-scanner", scannerInstanceId: "rollback-compatibility", policyVersion: process.env.ASSET_SCAN_POLICY_VERSION ?? "rollback", clamavHost: process.env.CLAMAV_HOST ?? "127.0.0.1", clamavPort: Number(process.env.CLAMAV_PORT ?? 3310), clamavTimeoutMs: 1000, event }
    await workerModule.executeAssetScan({ ...base, attemptRepository: { getByOutboxEvent: async () => null }, fetcher: async (_url, init) => { const path = \`/v1/internal/assets/\${event.aggregateId}/scan-content\`; verifyProof("GET", path, "", init); return new Response(null, { status: 409 }) } })
    const callbackBody = JSON.stringify({ receipt: { receipt_id: "scan_rollback", subject: { workspace_id: workspaceId, asset_id: event.aggregateId, object_key: event.payload.storage_key, sha256: event.payload.sha256, size_bytes: event.payload.size_bytes }, scan: { verdict: "clean" } }, signature: "rollback-signature" })
    const attempt = { outboxEventId: event.id, assetSourceRevision: 1, receiptDigest: "b".repeat(64), callbackBody, callbackStatus: "pending", receipt: JSON.parse(callbackBody).receipt }
    const repository = { getByOutboxEvent: async () => attempt, recordCallbackAttempt: async () => undefined, recordCallbackFailure: async () => undefined, markCallbackAccepted: async () => undefined }
    await workerModule.executeAssetScan({ ...base, attemptRepository: repository, fetcher: async (_url, init) => { const path = \`/v1/internal/assets/\${event.aggregateId}/scan-result\`; verifyProof("POST", path, callbackBody, init); return new Response("{}", { status: 200, headers: { "content-type": "application/json" } }) } })
    if (observed.length !== 2 || observed[0] === observed[1]) throw new Error("rollback scanner HMAC nonces are not unique per request")
  `
  worker.image = process.env.ROLLBACK_WORKER_IMAGE
  worker.command = ["node", "--input-type=module", "-e"]
  worker.args = [compatibilityProgram]
  delete worker.readinessProbe
  delete worker.livenessProbe
  delete worker.startupProbe
  source.metadata = { name: process.env.ROLLBACK_COMPATIBILITY_POD, namespace: "merchant", labels: { "app.kubernetes.io/name": "merchant-rollback-compatibility" } }
  source.spec.containers = [worker]
  source.spec.restartPolicy = "Never"
  delete source.spec.affinity
  delete source.spec.nodeName
  delete source.spec.hostname
  delete source.spec.subdomain
  delete source.status
  process.stdout.write(JSON.stringify(source))
' | kubectl apply -f - >/dev/null
compatibility_deadline=$(( $(date +%s) + ${ROLLBACK_COMPATIBILITY_TIMEOUT_SECONDS:-300} ))
while :; do
  compatibility_phase=$(kubectl get pod "$compatibility_pod" -n merchant -o jsonpath='{.status.phase}')
  case "$compatibility_phase" in
    Succeeded) break ;;
    Failed) kubectl logs "$compatibility_pod" -n merchant -c worker >&2 || true; echo 'rollback image failed scanner and migration compatibility gate' >&2; exit 1 ;;
  esac
  [ "$(date +%s)" -lt "$compatibility_deadline" ] || { kubectl logs "$compatibility_pod" -n merchant -c worker >&2 || true; echo 'rollback image compatibility gate timed out' >&2; exit 1; }
  sleep 2
done

kubectl apply -f "$verified_manifest"
kubectl set env deployment/merchant-api -n merchant --containers=api \
  "RELEASE_ID=$RELEASE_ID" "RELEASE_GIT_SHA=$release_git_sha" "RELEASE_MANIFEST_SHA256=$verified_sha" "RELEASE_IMAGE_SET_DIGEST=$image_set_digest"
for deployment in \
  merchant-api merchant-ui merchant-ops-ui \
  merchant-worker-sync merchant-worker-generation merchant-worker-publish \
  merchant-worker-reconcile merchant-worker-automation merchant-worker-scan
do
  kubectl rollout status "deployment/$deployment" -n merchant --timeout="${ROLLOUT_TIMEOUT:-10m}"
done

: "${PRODUCTION_CANARY_WORKSPACE_ID:?PRODUCTION_CANARY_WORKSPACE_ID is required for worker acceptance}"
kubectl exec -n merchant deployment/merchant-worker-generation -c worker -- env WORKER_ROLE=generation WORKER_ONCE=true "WORKER_WORKSPACES=$PRODUCTION_CANARY_WORKSPACE_ID" node --input-type=module -e '
  const { readWorkerConfig } = await import("./dist/apps/worker/src/main.js")
  const { loadMigrations } = await import("./dist/packages/persistence/src/migration.js")
  const { Pool } = await import("pg")
  const config = readWorkerConfig(process.env)
  if (config.role !== "generation") throw new Error("generation rollback acceptance ran with the wrong worker role")
  const expected = await loadMigrations()
  const pool = new Pool({ connectionString: config.databaseUrl, max: 1 })
  try { const result = await pool.query("SELECT max(version)::int AS version FROM schema_migrations"); if (Number(result.rows[0]?.version) !== expected.at(-1)?.version) throw new Error("generation rollback migration compatibility failed") } finally { await pool.end() }
' >/dev/null
scanner_pods=$(kubectl get pods -n merchant -l app.kubernetes.io/name=merchant-worker-scan -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}')
scanner_pod_count=$(printf '%s\n' "$scanner_pods" | awk 'NF { count += 1 } END { print count + 0 }')
[ "$scanner_pod_count" -ge 2 ] || { echo 'rollback scanner acceptance requires at least two scanner pods' >&2; exit 1; }
for scanner_pod in $scanner_pods; do
  # shellcheck disable=SC2016 # JavaScript is intentionally single-quoted for remote execution.
  kubectl exec -n merchant "$scanner_pod" -c worker -- env WORKER_ROLE=scan WORKER_ONCE=true "WORKER_WORKSPACES=$PRODUCTION_CANARY_WORKSPACE_ID" node --input-type=module -e '
    const { readFile } = await import("node:fs/promises")
    const { readWorkerConfig } = await import("./dist/apps/worker/src/main.js")
    const config = readWorkerConfig(process.env)
    if (config.role !== "scan") throw new Error("scanner rollback acceptance ran with the wrong worker role")
    for (const name of ["ASSET_SCANNER_API_TOKEN", "ASSET_SCANNER_WORKSPACE_SIGNING_SECRET", "ASSET_SCAN_RECEIPT_KEY_ID", "ASSET_SCAN_POLICY_VERSION", "CLAMAV_HOST"]) if (!process.env[name]?.trim()) throw new Error(`rollback scanner configuration missing: ${name}`)
    const heartbeat = JSON.parse(await readFile(process.env.WORKER_READY_FILE, "utf8"))
    if (!heartbeat.ready || heartbeat.schemaVersion !== "scanner-heartbeat/1.0" || heartbeat.instanceId !== process.env.HOSTNAME || Date.parse(heartbeat.expiresAt) <= Date.now()) throw new Error("rollback scanner heartbeat is missing, stale, or not bound to this pod")
    if (!heartbeat.checks?.databaseReady || !heartbeat.checks?.redisReady || !heartbeat.checks?.apiReady || !heartbeat.clamav?.reachable || !heartbeat.clamav?.definitionsVersion || !heartbeat.eicar?.passed || heartbeat.eicar?.signature !== "Eicar-Test-Signature" || !heartbeat.callback?.configured || !heartbeat.callback?.capable || !heartbeat.callback?.lastAcceptedAt) throw new Error("rollback scanner ClamAV, EICAR, configuration, or callback evidence is incomplete")
  ' >/dev/null
done

curl --fail --silent --show-error --max-time 15 "${PRODUCTION_API_BASE_URL%/}/livez" >/dev/null
curl --fail --silent --show-error --max-time 15 "${PRODUCTION_API_BASE_URL%/}/readyz" >/dev/null
: "${PRODUCTION_CANARY_BEARER_TOKEN:?PRODUCTION_CANARY_BEARER_TOKEN is required}"
release_payload=$(curl --fail --silent --show-error --max-time 15 "${PRODUCTION_API_BASE_URL%/}/releasez")
EXPECTED_RELEASE_ID="$RELEASE_ID" EXPECTED_RELEASE_GIT_SHA="$release_git_sha" EXPECTED_MANIFEST_SHA256="$verified_sha" EXPECTED_IMAGE_SET_DIGEST="$image_set_digest" \
  node -e 'const fs=require("fs");const body=JSON.parse(fs.readFileSync(0,"utf8"));const got=body.data?.release??body.release;const expected={release_id:process.env.EXPECTED_RELEASE_ID,release_git_sha:process.env.EXPECTED_RELEASE_GIT_SHA,manifest_sha256:process.env.EXPECTED_MANIFEST_SHA256,image_set_digest:process.env.EXPECTED_IMAGE_SET_DIGEST};if(!got||Object.entries(expected).some(([k,v])=>got[k]!==v))process.exit(1)' <<EOF
$release_payload
EOF
curl --fail --silent --show-error --max-time 20 -H "authorization: Bearer $PRODUCTION_CANARY_BEARER_TOKEN" -H "x-workspace-id: $PRODUCTION_CANARY_WORKSPACE_ID" "${PRODUCTION_API_BASE_URL%/}/v1/products?limit=1&offset=0" >/dev/null
PLATFORM_CANARY_BASE_EVIDENCE="$ROLLBACK_CAPABILITY_EVIDENCE_PATH" \
PLATFORM_CANARY_OUTPUT="$POST_ROLLBACK_CANARY_OUTPUT" \
RELEASE_GIT_SHA="$release_git_sha" RELEASE_MANIFEST_SHA256="$verified_sha" RELEASE_IMAGE_SET_DIGEST="$image_set_digest" \
  sh "$root/infra/scripts/run-production-canary.sh"
npx --no-install tsx "$root/tests/capability-evidence-gate.ts" --file "$POST_ROLLBACK_CANARY_OUTPUT" --require-canary --require-signed-production --release-id "$RELEASE_ID" \
  --image-set-digest "$image_set_digest" --manifest-sha256 "$verified_sha" --release-git-sha "$release_git_sha" --deployment-nonce "$DEPLOYMENT_NONCE" \
  --public-key "$trust_dir/production-evidence-public.pem" --key-id "$trusted_key_id"

echo "verified rollback passed: release_id=$RELEASE_ID manifest_sha256=$verified_sha canary=$POST_ROLLBACK_CANARY_OUTPUT"
