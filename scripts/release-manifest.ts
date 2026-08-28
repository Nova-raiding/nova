import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve, relative } from 'node:path'
import { MCP_METHODS } from '../packages/contracts/src/mcp.js'

export interface ReleaseManifest {
  schemaVersion: 1
  releaseId: string
  generatedAt: string
  components: {
    pluginVersion: string
    skillBundleVersion: string
    mcpVersion: string
    connectorBuild: string
    modelId: string
    promptBundleVersion: string
  }
  mcp: { methodCount: number; methodListSha256: string; bridgeSha256: string }
  artifacts: Array<{ path: string; sha256: string; bytes: number }>
  productionEvidence: { capability: string; capacity: string; modelRelay: string; payment: string; restore: string }
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
  capabilityEvidenceRef?: string
  capacityEvidenceRef?: string
  paymentEvidenceRef?: string
  modelRelayEvidenceRef?: string
  restoreEvidenceRef?: string
}): ReleaseManifest {
  const root = resolve(input.root ?? process.cwd())
  const pluginManifestPath = resolve(root, 'apps/plugin/.codex-plugin/plugin.json')
  const packagePath = resolve(root, 'apps/plugin/package.json')
  const skillPath = resolve(root, 'apps/plugin/skills/merchant-marketing/SKILL.md')
  const bridgePath = resolve(root, 'apps/plugin/mcp/bridge.mjs')
  const pluginManifest = readJson(pluginManifestPath)
  const packageJson = readJson(packagePath)
  const pluginVersion = String(pluginManifest.version ?? '')
  if (!/^0\.1\.0\+codex\.[0-9]{14}$/.test(pluginVersion)) throw new Error('plugin manifest version is not a release version')
  if (packageJson.version !== pluginVersion) throw new Error('plugin package version does not match plugin manifest')
  const artifactPaths = [pluginManifestPath, packagePath, skillPath, bridgePath]
  const artifacts = artifactPaths.map(path => {
    const bytes = readFileSync(path)
    return { path: relative(root, path), sha256: sha256(bytes), bytes: bytes.byteLength }
  })
  return {
    schemaVersion: 1,
    releaseId: input.releaseId,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    components: {
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
