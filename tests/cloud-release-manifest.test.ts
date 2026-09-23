import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildCloudReleaseManifest, buildReleaseManifest } from '../scripts/release-manifest.js'
import { PLUGIN_CONTRACT_TESTS } from '../scripts/local-plugin-test-attestation.mjs'
import { validateReleaseManifest } from './release-manifest-gate.js'

const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const evidence = Object.fromEntries(
  ['capability', 'capacity', 'modelRelay', 'payment', 'restore', 'objectStorage', 'codexAppHost', 'canonicalCutover']
    .map(name => [name, `artifact://production/evidence/${name}.json#${'a'.repeat(64)}`]),
)

function fixture() {
  const root = process.cwd()
  const dir = mkdtempSync(join(tmpdir(), 'cloud-release-manifest-'))
  const legacy = buildReleaseManifest({ root, releaseId: 'release-cloud-test' })
  const pair = generateKeyPairSync('ed25519')
  const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const publicKeyPath = join(dir, 'plugin-public.pem')
  writeFileSync(publicKeyPath, publicKeyPem)
  const pluginArtifacts = Object.fromEntries((['darwin', 'win32'] as const).map(os => {
    const platform = os === 'darwin' ? 'darwin-arm64' : 'win32-x64'
    const packagePath = join(dir, `${os}-plugin.tar.gz`)
    writeFileSync(packagePath, `test-only ${os} package fixture`)
    const fields = {
      schema_version: 'plugin-release/2', release_id: legacy.releaseId, git_sha: legacy.components.releaseGitSha,
      plugin_id: 'merchant-marketing', plugin_version: legacy.components.pluginVersion, platform,
      package_sha256: sha(readFileSync(packagePath)), package_bytes: readFileSync(packagePath).length,
      bridge_sha256: legacy.mcp.bridgeSha256,
      manifest_sha256: sha(readFileSync('apps/plugin/.codex-plugin/plugin.json')),
      skill_sha256: sha(readFileSync('apps/plugin/skills/merchant-marketing/SKILL.md')),
      mcp_methods_sha256: legacy.mcp.methodListSha256, release_readiness: 'signed_installable', key_id: 'plugin-test-key',
    }
    const descriptorPath = join(dir, `${os}-plugin-descriptor.json`)
    const descriptor = { ...fields, signature_base64: sign(null, Buffer.from(JSON.stringify(fields)), pair.privateKey).toString('base64') }
    writeFileSync(descriptorPath, `${JSON.stringify(descriptor)}\n`)
    const testNow = Date.now()
    const testFields = {
      schema_version: 'local-plugin-tests/2', release_id: legacy.releaseId, git_sha: legacy.components.releaseGitSha,
      platform, descriptor_sha256: sha(readFileSync(descriptorPath)),
      suite_sha256: sha(JSON.stringify(PLUGIN_CONTRACT_TESTS)), status: 'pass',
      generated_at: new Date(testNow).toISOString(), expires_at: new Date(testNow + 86_400_000).toISOString(),
      key_id: 'plugin-test-key',
    }
    const testAttestationPath = join(dir, `${os}-local-plugin-test-attestation.json`)
    writeFileSync(testAttestationPath, `${JSON.stringify({ ...testFields,
      signature_base64: sign(null, Buffer.from(JSON.stringify(testFields)), pair.privateKey).toString('base64') })}\n`)
    return [os, { descriptorPath, packagePath, testAttestationPath }]
  })) as { darwin: { descriptorPath: string; packagePath: string; testAttestationPath: string }; win32: { descriptorPath: string; packagePath: string; testAttestationPath: string } }
  const manifest = buildCloudReleaseManifest({ root, releaseId: legacy.releaseId,
    pluginPublicKeyPath: publicKeyPath, pluginKeyId: 'plugin-test-key', pluginArtifacts })
  manifest.productionEvidence = evidence as typeof manifest.productionEvidence
  const staged = join(dir, 'staged')
  mkdirSync(staged)
  for (const item of manifest.artifacts) {
    const destination = join(staged, item.path)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(join(root, item.path), destination)
  }
  writeFileSync(join(staged, '.candidate-identity'), [
    `release_id=${manifest.releaseId}`, `git_sha=${manifest.components.releaseGitSha}`,
    `source_sha256=sha256:${'a'.repeat(64)}`, `comparison_manifest_sha256=sha256:${'b'.repeat(64)}`,
    `sync_plan_sha256=sha256:${'c'.repeat(64)}`, '',
  ].join('\n'))
  const options = { root: staged, expectedReleaseId: manifest.releaseId,
    pluginArtifactPaths: pluginArtifacts, pluginPublicKeyPem: publicKeyPem, pluginKeyId: 'plugin-test-key' }
  return { manifest, staged, pluginArtifacts, options, pair }
}

describe('cloud-only release manifest v2', () => {
  it('validates signed local plugin identity from a Git-less cloud tree without plugin source', () => {
    const f = fixture()
    expect(f.manifest.schemaVersion).toBe(2)
    expect(f.manifest.artifacts.some(item => item.path.startsWith('apps/plugin/') || item.path.startsWith('.codex-marketplace/'))).toBe(false)
    expect(validateReleaseManifest(f.manifest, f.options)).toEqual([])
  })

  it('fails closed on missing trust, tampered descriptor, or plugin artifact leakage', () => {
    const f = fixture()
    expect(validateReleaseManifest(f.manifest, { root: f.staged, expectedReleaseId: f.manifest.releaseId }))
      .toContain('plugin-release/2 requires both platform descriptors, local test attestations, public key and key ID')
    const bytes = readFileSync(f.pluginArtifacts.darwin.descriptorPath, 'utf8')
    writeFileSync(f.pluginArtifacts.darwin.descriptorPath, bytes.replace('darwin-arm64', 'win32-x64'))
    expect(validateReleaseManifest(f.manifest, f.options).some(error => error.includes('descriptor SHA-256 mismatch'))).toBe(true)
    writeFileSync(f.pluginArtifacts.darwin.descriptorPath, bytes)
    f.manifest.pluginReleases.pop()
    expect(validateReleaseManifest(f.manifest, f.options).some(error => error.includes('both macOS and Windows'))).toBe(true)
    f.manifest.artifacts.push({ path: 'apps/plugin/mcp/bridge.mjs', sha256: '0'.repeat(64), bytes: 1 })
    expect(validateReleaseManifest(f.manifest, f.options)).toContain('cloud manifest must not contain local plugin source artifacts')
  })

  it('rejects a correctly signed legacy descriptor without installable readiness', () => {
    const f = fixture()
    const path = f.pluginArtifacts.darwin.descriptorPath
    const current = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    delete current.release_readiness
    delete current.signature_base64
    const legacy = { ...current, signature_base64: sign(null, Buffer.from(JSON.stringify(current)), f.pair.privateKey).toString('base64') }
    const bytes = Buffer.from(`${JSON.stringify(legacy)}\n`)
    writeFileSync(path, bytes)
    f.manifest.pluginReleases[0]!.descriptorSha256 = sha(bytes)
    expect(validateReleaseManifest(f.manifest, f.options).some(error => error.includes('descriptor fields are not exact'))).toBe(true)
  })
})
