import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve, relative } from 'node:path'
import { MCP_METHODS } from '../packages/contracts/src/mcp.js'

export interface ReleaseManifest {
  schemaVersion: 1
  releaseId: string
  generatedAt: string
  components: {
    repositoryVersion: string
    releaseGitSha: string
    pluginVersion: string
    skillBundleVersion: string
    mcpVersion: string
    connectorBuild: string
    modelId: string
    promptBundleVersion: string
  }
  mcp: { methodCount: number; methodListSha256: string; bridgeSha256: string }
  artifacts: Array<{ path: string; sha256: string; bytes: number }>
  productionEvidence: { capability: string; capacity: string; modelRelay: string; payment: string; restore: string; objectStorage: string; codexAppHost: string; canonicalCutover: string }
}

const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

export function buildReleaseManifest(input: {
  root?: string
  releaseId: string
  generatedAt?: string
  connectorBuild?: string
  modelId?: string
  promptBundleVersion?: string
  releaseGitSha?: string
  capabilityEvidenceRef?: string
  capacityEvidenceRef?: string
  paymentEvidenceRef?: string
  modelRelayEvidenceRef?: string
  restoreEvidenceRef?: string
  objectStorageEvidenceRef?: string
  codexAppHostEvidenceRef?: string
  canonicalCutoverEvidenceRef?: string
}): ReleaseManifest {
  const root = resolve(input.root ?? process.cwd())
  const pluginManifestPath = resolve(root, 'apps/plugin/.codex-plugin/plugin.json')
  const packagePath = resolve(root, 'apps/plugin/package.json')
  const skillPath = resolve(root, 'apps/plugin/skills/merchant-marketing/SKILL.md')
  const bridgePath = resolve(root, 'apps/plugin/mcp/bridge.mjs')
  const pluginManifest = readJson(pluginManifestPath)
  const packageJson = readJson(packagePath)
  const releaseMetadataPath = resolve(root, 'release-metadata.json')
  const releaseMetadata = readJson(releaseMetadataPath)
  const repositoryVersion = readFileSync(resolve(root, 'VERSION'), 'utf8').trim()
  const pluginVersion = String(pluginManifest.version ?? '')
  if (!/^0\.1\.0\+codex\.[0-9]{14}$/.test(pluginVersion)) throw new Error('plugin manifest version is not a release version')
  if (packageJson.version !== pluginVersion) throw new Error('plugin package version does not match plugin manifest')
  if (releaseMetadata.repositoryVersion !== repositoryVersion) throw new Error('release metadata repository version does not match VERSION')
  if (releaseMetadata.pluginVersion !== pluginVersion) throw new Error('release metadata plugin version does not match plugin manifest')
  if (releaseMetadata.mcpMethodCount !== MCP_METHODS.length) throw new Error('release metadata MCP method count does not match the current contract registry')
  const merchantHiddenMethods = new Set([
    'billing.model-usage.reconciliation.run', 'billing.model-usage.resolve', 'billing.usage.consume',
    'billing.usage.refund', 'billing.refund', 'billing.reconciliation.run', 'platform.settings.update',
    'platform.revoke', 'platform.model.status', 'asset.scan', 'content.codex.prepare', 'content.codex.commit',
  ])
  const bridge = readFileSync(bridgePath, 'utf8')
  const bridgeStart = bridge.indexOf('const METHODS = {')
  const bridgeEnd = bridge.indexOf('\n}\n\n', bridgeStart)
  const methodDefinitions = bridgeStart >= 0 && bridgeEnd > bridgeStart ? bridge.slice(bridgeStart, bridgeEnd) : ''
  const disabledBlock = bridge.match(/const COMMERCIAL_DISABLED_METHODS = new Set\(\[(.*?)\]\)/su)?.[1] ?? ''
  const commercialDisabledMethods = new Set([...disabledBlock.matchAll(/'([^']+)'/gu)].map(match => match[1]!))
  const bridgeToolCount = [...methodDefinitions.matchAll(/^  '([^']+)'\s*:/gmu)].map(match => match[1]!).filter(name => !name.startsWith('ops.') && !merchantHiddenMethods.has(name) && !commercialDisabledMethods.has(name)).length
  if (releaseMetadata.merchantBridgeToolCount !== bridgeToolCount) throw new Error('release metadata merchant bridge tool count does not match the current bridge surface')
  const opsNavigation = readFileSync(resolve(root, 'apps/ops-console/src/navigation/opsNavigation.ts'), 'utf8')
  const opsDomainCount = [...(opsNavigation.match(/export const opsDomains = \[(.*?)\] as const/su)?.[1] ?? '').matchAll(/"[a-z0-9-]+"/gu)].length
  if (releaseMetadata.opsDomainCount !== opsDomainCount) throw new Error('release metadata Ops domain count does not match the current navigation surface')
  const releaseGitSha = input.releaseGitSha?.trim()
    || process.env.RELEASE_GIT_SHA?.trim()
    || execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (!/^[a-f0-9]{40}$/u.test(releaseGitSha)) throw new Error('release git SHA must be a full 40-character commit SHA')
  const artifactPaths = [resolve(root, 'VERSION'), resolve(root, 'CHANGELOG.md'), releaseMetadataPath, pluginManifestPath, packagePath, skillPath, bridgePath, resolve(root, '.codex-marketplace/plugins/merchant-marketing/mcp/bridge.mjs'), resolve(root, 'apps/api/openapi.yaml'), resolve(root, 'packages/contracts/src/mcp.ts')]
  const artifacts = artifactPaths.map(path => {
    const bytes = readFileSync(path)
    return { path: relative(root, path), sha256: sha256(bytes), bytes: bytes.byteLength }
  })
  return {
    schemaVersion: 1,
    releaseId: input.releaseId,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    components: {
      repositoryVersion,
      releaseGitSha,
      pluginVersion,
      skillBundleVersion: process.env.SKILL_BUNDLE_VERSION?.trim() || pluginVersion,
      mcpVersion: process.env.MCP_VERSION?.trim() || pluginVersion,
      connectorBuild: input.connectorBuild ?? (process.env.CONNECTOR_BUILD?.trim() || 'local'),
      modelId: input.modelId ?? (process.env.MODEL_ID?.trim() || 'not-configured'),
      promptBundleVersion: input.promptBundleVersion ?? (process.env.PROMPT_BUNDLE_VERSION?.trim() || 'fixture-1.0.0'),
    },
    mcp: { methodCount: MCP_METHODS.length, methodListSha256: sha256(JSON.stringify(MCP_METHODS)), bridgeSha256: artifacts.find(item => item.path === 'apps/plugin/mcp/bridge.mjs')!.sha256 },
    artifacts,
    productionEvidence: {
      capability: input.capabilityEvidenceRef ?? (process.env.CAPABILITY_EVIDENCE_REF?.trim() || 'not-provided'),
      capacity: input.capacityEvidenceRef ?? (process.env.CAPACITY_EVIDENCE_REF?.trim() || 'not-provided'),
      modelRelay: input.modelRelayEvidenceRef ?? (process.env.MODEL_RELAY_EVIDENCE_REF?.trim() || 'not-provided'),
      payment: input.paymentEvidenceRef ?? (process.env.PAYMENT_EVIDENCE_REF?.trim() || 'not-provided'),
      restore: input.restoreEvidenceRef ?? (process.env.RESTORE_EVIDENCE_REF?.trim() || 'not-provided'),
      objectStorage: input.objectStorageEvidenceRef ?? (process.env.OBJECT_STORAGE_EVIDENCE_REF?.trim() || 'not-provided'),
      codexAppHost: input.codexAppHostEvidenceRef ?? (process.env.CODEX_APP_HOST_EVIDENCE_REF?.trim() || 'not-provided'),
      canonicalCutover: input.canonicalCutoverEvidenceRef ?? (process.env.CANONICAL_CUTOVER_EVIDENCE_REF?.trim() || 'not-provided'),
    },
  }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.url.replace('file://', ''))) {
  const output = argument('--output')
  const releaseId = argument('--release-id') ?? process.env.RELEASE_ID?.trim()
  if (!output || !releaseId) throw new Error('usage: tsx scripts/release-manifest.ts --release-id <id> --output <path>')
  const manifest = buildReleaseManifest({ root: process.cwd(), releaseId })
  const target = resolve(output)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`release manifest written: ${target}`)
}
