import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MCP_METHODS } from '../packages/contracts/src/mcp.js'
import { buildReleaseManifest } from '../scripts/release-manifest.js'

describe('release manifest', () => {
  it('binds the plugin, skill, MCP and evidence references to one release', () => {
    const pluginVersion = (JSON.parse(readFileSync('apps/plugin/package.json', 'utf8')) as { version: string }).version
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
    })
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      releaseId: 'rc-20260826',
      components: {
        pluginVersion,
        skillBundleVersion: pluginVersion,
        mcpVersion: pluginVersion,
        connectorBuild: 'connector-rc-1',
        modelId: 'relay-model-1',
        promptBundleVersion: 'prompt-rc-1',
      },
      mcp: { methodCount: MCP_METHODS.length },
      productionEvidence: {
        capability: 'artifact://capability/rc-20260826',
        capacity: 'artifact://capacity/rc-20260826',
        modelRelay: 'artifact://relay/rc-20260826',
        payment: 'artifact://payment/rc-20260826',
        restore: 'artifact://restore/rc-20260826',
      },
    })
    expect(manifest.artifacts).toHaveLength(4)
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
    })
  })
})
