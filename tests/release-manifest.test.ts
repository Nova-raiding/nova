import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { MCP_METHODS } from '../packages/contracts/src/mcp.js'
import { buildReleaseManifest } from '../scripts/release-manifest.js'

describe('release manifest', () => {
  it('binds the plugin, skill, MCP and evidence references to one release', () => {
    const pluginVersion = (JSON.parse(readFileSync('apps/plugin/package.json', 'utf8')) as { version: string }).version
    const repositoryVersion = readFileSync('VERSION', 'utf8').trim()
    const releaseGitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const manifest = buildReleaseManifest({
      root: process.cwd(),
      releaseId: 'rc-20260826',
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
      releaseId: 'rc-20260826',
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
    expect(manifest.artifacts).toHaveLength(30)
    expect(manifest.artifacts.map(item => item.path)).toEqual(expect.arrayContaining([
      'services/payment-gateway/index.mjs',
      'services/payment-gateway/alipay.mjs',
      'services/payment-gateway/alipay.d.mts',
      'packages/billing/src/callback-envelope.mjs',
      'packages/billing/src/callback-envelope.d.mts',
      'services/payment-gateway/Dockerfile',
      'infra/scripts/render-ecs-production-compose.sh',
      'infra/scripts/stage-verified-ecs-release.sh',
      'infra/scripts/deploy-verified-ecs-compose.sh',
      'infra/scripts/rollback-ecs-compose.sh',
      'infra/scripts/invoke-ecs-automatic-rollback.sh',
      'infra/scripts/install-ecs-release-controls.mjs',
      'infra/scripts/install-ecs-release-controls.d.mts',
      'infra/protected/attest-postgres-backup.mjs',
      'infra/protected/attest-postgres-backup.d.mts',
      'infra/protected/ecs-preidentity-recovery.mjs',
      'infra/protected/ecs-preidentity-recovery.d.mts',
      'infra/protected/attest-release-evidence-bundle.mjs',
      'infra/protected/attest-release-evidence-bundle.d.mts',
      'tests/release-evidence-bundle-gate.ts',
    ]))
    expect(manifest.artifacts.every(item => /^[a-f0-9]{64}$/.test(item.sha256) && item.bytes > 0)).toBe(true)
  })

  it('marks production evidence as missing when no evidence refs are supplied', () => {
    const manifest = buildReleaseManifest({ root: process.cwd(), releaseId: 'local-audit-20260826' })
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
