import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildReleaseManifest } from '../scripts/release-manifest.js'
import { signProductionEvidence } from './production-evidence-gate.js'
import { validateReleaseManifest } from './release-manifest-gate.js'

const evidenceFields = ['capability', 'capacity', 'modelRelay', 'payment', 'restore', 'objectStorage', 'codexAppHost', 'canonicalCutover'] as const
const inputNames = { capability: 'capabilityEvidenceRef', capacity: 'capacityEvidenceRef', modelRelay: 'modelRelayEvidenceRef', payment: 'paymentEvidenceRef', restore: 'restoreEvidenceRef', objectStorage: 'objectStorageEvidenceRef', codexAppHost: 'codexAppHostEvidenceRef', canonicalCutover: 'canonicalCutoverEvidenceRef' } as const
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

function boundManifestFixture() {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'release-manifest-evidence-'))
  const pair = generateKeyPairSync('ed25519')
  const privateKeyPem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  const publicKeyPem = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString()
  const evidenceFiles = {} as Record<typeof evidenceFields[number], string>
  const refs = {} as Record<string, string>
  for (const field of evidenceFields) {
    const document: Record<string, unknown> = { schema_version: '2', release_id: 'release-1', generated_at: '2026-08-29T00:00:00Z', expires_at: '2026-09-02T00:00:00Z', key_id: 'release-security-test', environment: 'production', status: 'pass' }
    if (field === 'capability' || field === 'payment' || field === 'restore') document.signature_base64 = signProductionEvidence(document, privateKeyPem)
    const contents = JSON.stringify(document)
    const path = join(artifactRoot, `${field}.json`)
    writeFileSync(path, contents)
    evidenceFiles[field] = path
    refs[inputNames[field]] = `artifact://production/${field}.json#${digest(contents)}`
  }
  const manifest = buildReleaseManifest({ root: process.cwd(), releaseId: 'release-1', generatedAt: '2026-08-29T01:00:00Z', ...refs })
  const options = { root: process.cwd(), expectedReleaseId: 'release-1', artifactRoot, evidenceFiles, publicKeyPem, trustedKeyId: 'release-security-test', now: new Date('2026-08-29T02:00:00Z') }
  return { artifactRoot, evidenceFiles, manifest, options }
}

describe('release manifest production gate', () => {
  it('binds API/OpenAPI, MCP and plugin source to one release', () => {
    const manifest = buildReleaseManifest({ root: process.cwd(), releaseId: 'release-1', capabilityEvidenceRef: 'artifact://production/evidence/capability#' + 'a'.repeat(64), capacityEvidenceRef: 'artifact://production/evidence/capacity#' + 'a'.repeat(64), modelRelayEvidenceRef: 'artifact://production/evidence/relay#' + 'a'.repeat(64), paymentEvidenceRef: 'artifact://production/evidence/payment#' + 'a'.repeat(64), restoreEvidenceRef: 'artifact://production/evidence/restore#' + 'a'.repeat(64), objectStorageEvidenceRef: 'artifact://production/evidence/storage#' + 'a'.repeat(64), codexAppHostEvidenceRef: 'artifact://production/evidence/codex-host#' + 'a'.repeat(64), canonicalCutoverEvidenceRef: 'artifact://production/evidence/canonical-cutover#' + 'a'.repeat(64) })
    expect(validateReleaseManifest(manifest, { root: process.cwd(), expectedReleaseId: 'release-1' })).toEqual([])
  })
  it('rejects stale API/MCP artifacts and unbound production evidence', () => {
    const manifest = buildReleaseManifest({ root: process.cwd(), releaseId: 'release-1' })
    manifest.artifacts.find(item => item.path === 'apps/api/openapi.yaml')!.sha256 = 'f'.repeat(64)
    expect(validateReleaseManifest(manifest, { root: process.cwd(), expectedReleaseId: 'release-1' })).toEqual(expect.arrayContaining(['artifact SHA-256 does not match current source: apps/api/openapi.yaml', 'productionEvidence.capability must be an immutable production artifact']))
    expect(readFileSync('apps/api/openapi.yaml', 'utf8').length).toBeGreaterThan(0)
  })
  it('rejects a stale bridge digest or missing marketplace mirror', () => {
    const manifest = buildReleaseManifest({ root: process.cwd(), releaseId: 'release-1', capabilityEvidenceRef: 'artifact://production/evidence/capability#' + 'a'.repeat(64), capacityEvidenceRef: 'artifact://production/evidence/capacity#' + 'a'.repeat(64), modelRelayEvidenceRef: 'artifact://production/evidence/relay#' + 'a'.repeat(64), paymentEvidenceRef: 'artifact://production/evidence/payment#' + 'a'.repeat(64), restoreEvidenceRef: 'artifact://production/evidence/restore#' + 'a'.repeat(64), objectStorageEvidenceRef: 'artifact://production/evidence/storage#' + 'a'.repeat(64), codexAppHostEvidenceRef: 'artifact://production/evidence/codex-host#' + 'a'.repeat(64), canonicalCutoverEvidenceRef: 'artifact://production/evidence/canonical-cutover#' + 'a'.repeat(64) })
    manifest.mcp!.bridgeSha256 = 'f'.repeat(64)
    manifest.artifacts = manifest.artifacts.filter(item => item.path !== '.codex-marketplace/plugins/merchant-marketing/mcp/bridge.mjs')
    expect(validateReleaseManifest(manifest, { root: process.cwd(), expectedReleaseId: 'release-1' })).toEqual(expect.arrayContaining(['mcp.bridgeSha256 does not match the current source bridge', 'artifact is missing: .codex-marketplace/plugins/merchant-marketing/mcp/bridge.mjs']))
  })

  it('binds the exact evidence bytes, freshness and existing production signatures without creating a production key', () => {
    const fixture = boundManifestFixture()
    expect(validateReleaseManifest(fixture.manifest, fixture.options)).toEqual([])

    const stale = boundManifestFixture()
    expect(validateReleaseManifest(stale.manifest, { ...stale.options, now: new Date('2026-09-10T02:00:00Z') })).toEqual(expect.arrayContaining(['generatedAt is stale', 'productionEvidence.capacity generated timestamp is stale']))

    writeFileSync(fixture.evidenceFiles.capacity, JSON.stringify({ release_id: 'release-1', generated_at: '2026-08-29T00:00:00Z' }))
    expect(validateReleaseManifest(fixture.manifest, fixture.options)).toContain('productionEvidence.capacity SHA-256 does not match the referenced artifact')

    const swapped = boundManifestFixture()
    expect(validateReleaseManifest(swapped.manifest, { ...swapped.options, evidenceFiles: { ...swapped.evidenceFiles, capacity: swapped.evidenceFiles.modelRelay } })).toContain('productionEvidence.capacity must reference the exact evidence file passed to deployment')

    const expired = boundManifestFixture()
    const expiredDocument = JSON.parse(readFileSync(expired.evidenceFiles.objectStorage, 'utf8')) as Record<string, unknown>
    expiredDocument.expires_at = '2026-08-29T01:30:00Z'
    const expiredContents = JSON.stringify(expiredDocument)
    writeFileSync(expired.evidenceFiles.objectStorage, expiredContents)
    expired.manifest.productionEvidence.objectStorage = `artifact://production/objectStorage.json#${digest(expiredContents)}`
    expect(validateReleaseManifest(expired.manifest, expired.options)).toContain('productionEvidence.objectStorage has expired')

    const unsigned = boundManifestFixture()
    const capability = JSON.parse(readFileSync(unsigned.evidenceFiles.capability, 'utf8')) as Record<string, unknown>
    delete capability.signature_base64
    const unsignedContents = JSON.stringify(capability)
    writeFileSync(unsigned.evidenceFiles.capability, unsignedContents)
    unsigned.manifest.productionEvidence.capability = `artifact://production/capability.json#${digest(unsignedContents)}`
    expect(validateReleaseManifest(unsigned.manifest, unsigned.options)).toContain('productionEvidence.capability signature_base64 must be a canonical Ed25519 signature')
  })
})
