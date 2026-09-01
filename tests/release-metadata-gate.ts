import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { MCP_METHODS } from '../packages/contracts/src/mcp.js'

export interface ReleaseMetadataSnapshot {
  declared: {
    schemaVersion?: number
    repositoryVersion?: string
    pluginVersion?: string
    expectedMigrationVersion?: number
    mcpMethodCount?: number
    merchantBridgeToolCount?: number
    opsDomainCount?: number
  }
  version: string
  rootPackageVersion: string
  lockRootVersion: string
  changelogVersion: string
  pluginVersions: Record<string, string>
  migrationFiles: string[]
  actualMcpMethodCount: number
  actualMerchantBridgeToolCount: number
  actualOpsDomainCount: number
}

function json(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>
}

const merchantHiddenMethods = new Set([
  'billing.model-usage.reconciliation.run',
  'billing.model-usage.resolve',
  'billing.usage.consume',
  'billing.usage.refund',
  'billing.refund',
  'billing.reconciliation.run',
  'platform.settings.update',
  'platform.revoke',
  'platform.model.status',
  'asset.scan',
  'content.codex.prepare',
  'content.codex.commit',
])

function countBridgeTools(root: string): number {
  const source = readFileSync(resolve(root, 'apps/plugin/mcp/bridge.mjs'), 'utf8')
  const start = source.indexOf('const METHODS = {')
  const end = source.indexOf('\n}\n\n', start)
  const methods = start >= 0 && end > start ? source.slice(start, end) : ''
  const names = [...methods.matchAll(/^  '([^']+)'\s*:/gmu)].map(match => match[1]!)
  return names.filter(name => !name.startsWith('ops.') && !merchantHiddenMethods.has(name)).length
}

function countOpsDomains(root: string): number {
  const source = readFileSync(resolve(root, 'apps/ops-console/src/navigation/opsNavigation.ts'), 'utf8')
  const block = source.match(/export const opsDomains = \[(.*?)\] as const/su)?.[1] ?? ''
  return [...block.matchAll(/"([a-z0-9-]+)"/gu)].length
}

export function collectReleaseMetadata(root = process.cwd()): ReleaseMetadataSnapshot {
  const at = (path: string) => resolve(root, path)
  const changelog = readFileSync(at('CHANGELOG.md'), 'utf8')
  const changelogVersion = changelog.match(/^##\s+(\d+\.\d+\.\d+)\b/mu)?.[1] ?? ''
  const lock = json(at('package-lock.json'))
  return {
    declared: json(at('release-metadata.json')),
    version: readFileSync(at('VERSION'), 'utf8').trim(),
    rootPackageVersion: String(json(at('package.json')).version ?? ''),
    lockRootVersion: String(lock.packages?.['']?.version ?? lock.version ?? ''),
    changelogVersion,
    pluginVersions: {
      sourcePackage: String(json(at('apps/plugin/package.json')).version ?? ''),
      sourceManifest: String(json(at('apps/plugin/.codex-plugin/plugin.json')).version ?? ''),
      marketplacePackage: String(json(at('.codex-marketplace/plugins/merchant-marketing/package.json')).version ?? ''),
      marketplaceManifest: String(json(at('.codex-marketplace/plugins/merchant-marketing/.codex-plugin/plugin.json')).version ?? ''),
    },
    migrationFiles: readdirSync(at('packages/persistence/src/migrations')).filter(file => file.endsWith('.sql')).sort(),
    actualMcpMethodCount: MCP_METHODS.length,
    actualMerchantBridgeToolCount: countBridgeTools(root),
    actualOpsDomainCount: countOpsDomains(root),
  }
}

export function validateReleaseMetadata(snapshot: ReleaseMetadataSnapshot): string[] {
  const errors: string[] = []
  const declared = snapshot.declared
  if (declared.schemaVersion !== 1) errors.push('release-metadata schemaVersion must be 1')
  if (!/^\d+\.\d+\.\d+$/u.test(snapshot.version)) errors.push('VERSION must be strict major.minor.patch')
  if (declared.repositoryVersion !== snapshot.version) errors.push('release-metadata repositoryVersion must match VERSION')
  if (snapshot.rootPackageVersion !== snapshot.version) errors.push('package.json version must match VERSION')
  if (snapshot.lockRootVersion !== snapshot.version) errors.push('package-lock root version must match VERSION')
  if (snapshot.changelogVersion !== snapshot.version) errors.push('latest CHANGELOG version must match VERSION')

  const pluginVersions = Object.values(snapshot.pluginVersions)
  if (pluginVersions.some(version => version !== declared.pluginVersion)) errors.push('source and marketplace plugin versions must match release-metadata pluginVersion')
  if (!/^\d+\.\d+\.\d+\+codex\.\d{14}$/u.test(String(declared.pluginVersion ?? ''))) errors.push('pluginVersion must include a 14-digit codex build timestamp')
  if (declared.mcpMethodCount !== snapshot.actualMcpMethodCount) errors.push('release-metadata mcpMethodCount must match the MCP contract registry')
  if (!Number.isInteger(declared.merchantBridgeToolCount) || Number(declared.merchantBridgeToolCount) < 1) errors.push('release-metadata merchantBridgeToolCount must be a positive integer')
  else if (declared.merchantBridgeToolCount !== snapshot.actualMerchantBridgeToolCount) errors.push('release-metadata merchantBridgeToolCount must match the merchant bridge surface')
  if (!Number.isInteger(declared.opsDomainCount) || Number(declared.opsDomainCount) < 1) errors.push('release-metadata opsDomainCount must be a positive integer')
  else if (declared.opsDomainCount !== snapshot.actualOpsDomainCount) errors.push('release-metadata opsDomainCount must match the Ops navigation surface')

  const parsed = snapshot.migrationFiles.map(file => ({ file, match: /^(\d{3})_[a-z0-9][a-z0-9_]*\.sql$/u.exec(file) }))
  for (const item of parsed) if (!item.match) errors.push(`migration filename is invalid: ${item.file}`)
  const versions = parsed.flatMap(item => item.match ? [Number(item.match[1])] : []).sort((left, right) => left - right)
  const duplicateVersions = versions.filter((version, index) => index > 0 && version === versions[index - 1])
  for (const version of [...new Set(duplicateVersions)]) {
    errors.push(`migration chain contains duplicate version ${String(version).padStart(3, '0')}`)
  }
  const migrationNames = parsed.flatMap(item => item.match ? [item.match[0].replace(/^\d{3}_/u, '').replace(/\.sql$/u, '')] : [])
  const duplicateNames = migrationNames.filter((name, index) => index > 0 && migrationNames.slice(0, index).includes(name))
  for (const name of [...new Set(duplicateNames)]) {
    errors.push(`migration chain contains duplicate name ${name}`)
  }
  for (let index = 0; index < versions.length; index += 1) {
    const expected = index + 1
    if (versions[index] !== expected) { errors.push(`migration chain must be contiguous at ${String(expected).padStart(3, '0')}`); break }
  }
  if (versions.at(-1) !== declared.expectedMigrationVersion) errors.push('release-metadata expectedMigrationVersion must match the migration chain tail')
  return errors
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const errors = validateReleaseMetadata(collectReleaseMetadata())
  if (errors.length > 0) {
    console.error(errors.map(error => `- ${error}`).join('\n'))
    process.exit(1)
  }
  console.log('release metadata gate passed: VERSION, package metadata, CHANGELOG, plugin mirrors, MCP registry and migrations are aligned')
}
