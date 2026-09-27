import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MCP_METHODS } from '../packages/contracts/src/mcp.js'
import { buildReleaseManifest } from '../scripts/release-manifest.js'
import { releaseGitShaForRoot } from '../scripts/release-identity.js'

function testReleaseId(root: string): string {
  if (releaseGitShaForRoot(root, 'release-1')) return 'release-1'
  const identity = readFileSync(`${root}/.candidate-identity`, 'utf8')
  const candidateReleaseId = identity.split(/\r?\n/u).find(line => line.startsWith('release_id='))?.slice('release_id='.length)
  if (!candidateReleaseId || !releaseGitShaForRoot(root, candidateReleaseId)) throw new Error('release manifest tests require a valid staged candidate identity')
  return candidateReleaseId
}

describe('release manifest', () => {
  it('binds the plugin, skill, MCP and evidence references to one release', () => {
    const pluginVersion = (JSON.parse(readFileSync('apps/plugin/package.json', 'utf8')) as { version: string }).version
    const repositoryVersion = readFileSync('VERSION', 'utf8').trim()
    const releaseId = testReleaseId(process.cwd())
    const releaseGitSha = releaseGitShaForRoot(process.cwd(), releaseId)
    const manifest = buildReleaseManifest({
      root: process.cwd(),
      releaseId,
      generatedAt: '2026-08-26T13:30:00.000Z',
      connectorBuild: 'connector-rc-1',
      modelId: 'relay-model-1',
      promptBundleVersion: 'prompt-rc-1',
      capabilityEvidenceRef: 'artifact://capability/rc-20260826',
      capacityEvidenceRef: 'artifact://capacity/rc-20260826',
      paymentEvidenceRef: 'artifact://payment/rc-20260826',
      modelRelayEvidenceRef: 'artifact://relay/rc-20260826',
      restoreEvidenceRef: 'artifact://restore/rc-20260826',
      objectStorageEvidenceRef: 'artifact://object-storage/rc-20260826',
      codexAppHostEvidenceRef: 'artifact://codex-app-host/rc-20260826',
    })
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      releaseId,
      components: {
        repositoryVersion,
        releaseGitSha,
        pluginVersion,
        skillBundleVersion: pluginVersion,
        mcpVersion: pluginVersion,
        connectorBuild: 'connector-rc-1',
        modelId: 'relay-model-1',
        promptBundleVersion: 'prompt-rc-1',
      },
      mcp: { methodCount: MCP_METHODS.length },
      productionEvidenceBundle: { required: true, schemaVersion: 'release-evidence-bundle/1' },
      productionEvidence: {
        capability: 'artifact://capability/rc-20260826',
        capacity: 'artifact://capacity/rc-20260826',
        modelRelay: 'artifact://relay/rc-20260826',
        payment: 'artifact://payment/rc-20260826',
        restore: 'artifact://restore/rc-20260826',
        objectStorage: 'artifact://object-storage/rc-20260826',
        codexAppHost: 'artifact://codex-app-host/rc-20260826',
      },
    })
    expect(manifest.artifacts).toHaveLength(129)
    expect(manifest.artifacts.map(item => item.path)).toEqual(expect.arrayContaining([
      'scripts/release-manifest.ts',
      'scripts/release-identity.ts',
      'scripts/collect-codex-app-host-evidence.mjs',
      'tests/codex-app-host-evidence-gate.ts',
      'infra/protected/canonical-safe-state-attestation.mjs',
      'infra/protected/canonical-safe-state-attestation.d.mts',
      'infra/protected/attest-canonical-safe-state.mjs',
      'infra/protected/attest-canonical-safe-state.d.mts',
      'infra/protected/canonical-safe-state-snapshot.mjs',
      'infra/protected/canonical-safe-state-snapshot.d.mts',
      'infra/protected/canonical-safe-state-reader-bootstrap.sql',
      'infra/scripts/verify-canonical-safe-state-reader.sh',
      'tests/canonical-product-cutover-evidence-gate.ts',
      'tests/canonical-safe-state-attestation.test.ts',
      'tests/attest-canonical-safe-state.test.ts',
      'tests/canonical-safe-state-reader.test.ts',
      'tests/canonical-safe-state-snapshot.test.ts',
      'tests/canonical-safe-state-column-acl.postgres.sh',
      'docs/runbooks/canonical-safe-state-reader-bootstrap.md',
      'docs/runbooks/canonical-safe-state-source-attestation.md',
      'tests/release-manifest-gate.ts',
      'docs/runbooks/chatgpt-candidate-host-route.md',
      'docs/runbooks/ecs-verified-compose-deploy.md',
      'services/payment-gateway/index.mjs',
      'services/payment-gateway/alipay.mjs',
      'services/payment-gateway/alipay.d.mts',
      'packages/billing/src/callback-envelope.mjs',
      'packages/billing/src/callback-envelope.d.mts',
      'services/payment-gateway/Dockerfile',
      'infra/docker/pilot-gateway-https.Dockerfile',
      'infra/nginx/pilot-gateway-https.conf',
      'infra/scripts/launch-ecs-candidate-tls-gateway.mjs',
      'infra/scripts/launch-ecs-candidate-tls-gateway.d.mts',
      'infra/scripts/launch-ecs-candidate-full-https-gateway.mjs',
      'infra/scripts/launch-ecs-candidate-full-https-gateway.d.mts',
      'infra/scripts/ecs-external-gateway-handoff.mjs',
      'infra/scripts/ecs-external-gateway-handoff.d.mts',
      'tests/ecs-candidate-tls-gateway.test.ts',
      'tests/ecs-candidate-full-https-gateway.test.ts',
      'tests/ecs-external-gateway-handoff.test.ts',
      'infra/scripts/render-ecs-production-compose.sh',
      'infra/scripts/validate-ecs-compose-project.mjs',
      'infra/scripts/stage-verified-ecs-release.sh',
      'infra/scripts/ecs-build-lock.sh',
      'infra/scripts/install-ecs-staging-toolchain.mjs',
      'infra/scripts/ecs-one-click-deploy.sh',
      'infra/scripts/deploy-verified-ecs-compose.sh',
      'infra/scripts/inspect-payment-gateway-receipt-runtime.mjs',
      'infra/scripts/inspect-payment-gateway-receipt-runtime.test.mjs',
      'infra/scripts/ecs-compose-published-ports.mjs',
      'infra/scripts/ecs-compose-published-ports.d.mts',
      'infra/scripts/deploy-preflight-ecs.sh',
      'tests/ecs-compose-published-ports.test.ts',
      'infra/scripts/build-ecs-release-images.sh',
      'infra/scripts/verify-ecs-ops-auth-mode.sh',
      'infra/scripts/rollback-ecs-compose.sh',
      'infra/scripts/invoke-ecs-automatic-rollback.sh',
      'infra/scripts/install-ecs-release-controls.mjs',
      'infra/scripts/install-ecs-release-controls.d.mts',
      'infra/protected/ecs-bridge-b-transition.mjs',
      'infra/protected/ecs-bridge-b-transition.d.mts',
      'infra/protected/ecs-bridge-b-journal-store.mjs',
      'infra/protected/ecs-bridge-b-journal-store.d.mts',
      'tests/ecs-bridge-b-transition.test.ts',
      'tests/run-ecs-bridge-b-host-cli.sh',
      'tests/fixtures/ecs-bridge-b-host-cli/curl.mjs',
      'tests/fixtures/ecs-bridge-b-host-cli/docker.mjs',
      'tests/fixtures/ecs-bridge-b-host-cli/nonce-consumer.mjs',
      'tests/fixtures/ecs-bridge-b-host-cli/psql.mjs',
      'tests/fixtures/ecs-bridge-b-host-cli/run.mjs',
      'tests/fixtures/ecs-bridge-b-host-cli/setup.mjs',
      'infra/scripts/prepare-ecs-bridge-254-review.mjs',
      'infra/scripts/overlay-ecs-bridge-254-review.mjs',
      'infra/scripts/inspect-ecs-bridge-254-rendered-compose.mjs',
      'infra/scripts/review-ecs-bridge-254-candidate-preflight.mjs',
      'infra/scripts/verify-ecs-bridge-254-review-package.mjs',
      'infra/protected/ecs-bridge-254-maintenance-core.mjs',
      'infra/protected/ecs-bridge-254-state-store.mjs',
      'tests/ecs-bridge-254-review-package.test.mjs',
      'tests/ecs-bridge-254-candidate-preflight-review.test.mjs',
      'apps/worker/src/scanner-container-healthcheck.ts',
      'apps/worker/src/scanner-container-healthcheck.test.ts',
      'tests/ecs-staging-toolchain-installer.test.mjs',
      'tests/ecs-staging-toolchain-installer.container-check.mjs',
      'tests/ecs-one-click-deploy.test.ts',
      'docs/runbooks/ecs-candidate-safe-sync.md',
      'infra/protected/attest-postgres-backup.mjs',
      'infra/protected/attest-postgres-backup.d.mts',
      'infra/protected/ecs-preidentity-recovery.mjs',
      'infra/protected/ecs-preidentity-recovery.d.mts',
      'infra/protected/attest-release-evidence-bundle.mjs',
      'infra/protected/attest-release-evidence-bundle.d.mts',
      'infra/protected/attest-manual-operations-evidence.mjs',
      'infra/protected/attest-manual-operations-evidence.d.mts',
      'tests/release-evidence-bundle-gate.ts',
    ]))
    expect(manifest.artifacts.every(item => /^[a-f0-9]{64}$/.test(item.sha256) && item.bytes > 0)).toBe(true)
  })

  it('marks production evidence as missing when no evidence refs are supplied', () => {
    const manifest = buildReleaseManifest({ root: process.cwd(), releaseId: testReleaseId(process.cwd()) })
    expect(manifest.productionEvidence).toEqual({
      capability: 'not-provided',
      capacity: 'not-provided',
      modelRelay: 'not-provided',
      payment: 'not-provided',
      restore: 'not-provided',
      objectStorage: 'not-provided',
        codexAppHost: 'not-provided',
        canonicalCutover: 'not-provided',
    })
  })
})
