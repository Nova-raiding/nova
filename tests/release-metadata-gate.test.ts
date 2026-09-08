import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectReleaseMetadata, validateReleaseMetadata } from './release-metadata-gate.js'

describe('repository release metadata gate', () => {
  it('keeps the live repository release metadata aligned', () => {
    expect(validateReleaseMetadata(collectReleaseMetadata())).toEqual([])
  })

  it('matches the actual merchant Bridge tools/list surface', () => {
    const snapshot = collectReleaseMetadata()
    const result = spawnSync(process.execPath, [resolve('apps/plugin/mcp/bridge.mjs')], {
      encoding: 'utf8',
      input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })}\n`,
      timeout: 10_000,
      env: {
        ...process.env,
        MERCHANT_MCP_BASE_URL: 'http://127.0.0.1:9',
        MERCHANT_WORKSPACE_ID: 'ws_release_metadata',
      },
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    const response = JSON.parse(result.stdout.trim().split(/\r?\n/u)[0]!) as {
      result: { tools: Array<{ name: string }> }
    }
    const names = response.result.tools.map(tool => tool.name)
    const declaredCount = snapshot.declared.merchantBridgeToolCount
    if (typeof declaredCount !== 'number') throw new Error('release metadata merchant bridge tool count is missing')
    expect(names).toHaveLength(declaredCount)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toContain('rule.sync.now')
    expect(names.some(name => name.startsWith('ops.'))).toBe(false)
  })

  it('rejects version, plugin, MCP and migration drift', () => {
    const snapshot = collectReleaseMetadata()
    expect(validateReleaseMetadata({ ...snapshot, rootPackageVersion: '0.0.0' })).toContain('package.json version must match VERSION')
    expect(validateReleaseMetadata({ ...snapshot, pluginVersions: { ...snapshot.pluginVersions, marketplaceManifest: '0.0.0+codex.20260829000000' } })).toContain('source and marketplace plugin versions must match release-metadata pluginVersion')
    expect(validateReleaseMetadata({ ...snapshot, actualMcpMethodCount: snapshot.actualMcpMethodCount + 1 })).toContain('release-metadata mcpMethodCount must match the MCP contract registry')
    expect(validateReleaseMetadata({ ...snapshot, actualMerchantBridgeToolCount: snapshot.actualMerchantBridgeToolCount + 1 })).toContain('release-metadata merchantBridgeToolCount must match the merchant bridge surface')
    expect(validateReleaseMetadata({ ...snapshot, actualOpsDomainCount: snapshot.actualOpsDomainCount + 1 })).toContain('release-metadata opsDomainCount must match the Ops navigation surface')
    expect(validateReleaseMetadata({ ...snapshot, migrationFiles: snapshot.migrationFiles.filter(file => !file.startsWith('063_')) })).toContain('migration chain must be contiguous at 063')
  })

  it('rejects duplicate migration versions explicitly', () => {
    const snapshot = collectReleaseMetadata()
    const migration = snapshot.migrationFiles.find(file => file.startsWith('001_'))
    expect(migration).toBeDefined()
    expect(validateReleaseMetadata({
      ...snapshot,
      migrationFiles: [...snapshot.migrationFiles, migration!],
    })).toContain('migration chain contains duplicate version 001')
  })
})
