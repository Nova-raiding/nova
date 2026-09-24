import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validateProductionCapabilityEvidenceTrust } from '../../../packages/connectors/src/capability-evidence.js'
import { loadConnectorCapabilityEvidenceTrust } from './connector-capability-evidence-trust.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'connector-capability-trust-'))
  roots.push(root)
  const trustRoot = join(root, 'trust')
  mkdirSync(trustRoot)
  const paths = {
    evidencePath: join(root, 'capability.json'),
    publicKeyPath: join(trustRoot, 'public.pem'),
    keyIdPath: join(trustRoot, 'key-id'),
  }
  const source = {
    NODE_ENV: 'production', RELEASE_ID: 'release-1', RELEASE_GIT_SHA: 'a'.repeat(40),
    RELEASE_MANIFEST_SHA256: 'b'.repeat(64), RELEASE_IMAGE_SET_DIGEST: `sha256:${'c'.repeat(64)}`,
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const document: Record<string, unknown> = {
    schema_version: '1', release_id: source.RELEASE_ID, release_git_sha: source.RELEASE_GIT_SHA,
    manifest_sha256: source.RELEASE_MANIFEST_SHA256, image_set_digest: source.RELEASE_IMAGE_SET_DIGEST,
    deployment_nonce: 'deployment_nonce_abcdefghijklmnop', key_id: 'release-key', environment: 'production',
    simulated: false, platforms: [],
  }
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
    if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).filter(([key]) => key !== 'signature_base64').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
    return JSON.stringify(value) ?? 'null'
  }
  document.signature_base64 = sign(null, Buffer.from(canonical(document)), privateKey).toString('base64')
  writeFileSync(paths.evidencePath, JSON.stringify(document))
  writeFileSync(paths.publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }))
  writeFileSync(paths.keyIdPath, 'release-key\n')
  return { paths, source, document }
}

describe('production connector capability evidence trust loader', () => {
  it('loads a regular-file trust chain that verifies the signed release evidence and trusted key ID', () => {
    const { paths, source, document } = fixture()
    const trust = loadConnectorCapabilityEvidenceTrust(source, paths)

    expect(trust).toBeDefined()
    expect(validateProductionCapabilityEvidenceTrust(document, source, trust!)).toEqual([])
    expect(validateProductionCapabilityEvidenceTrust(document, source, { ...trust!, trustedKeyId: 'different-key' })).not.toEqual([])
  })

  it('fails closed for non-production, missing files, and symlinked trust anchors', () => {
    const { paths, source } = fixture()
    expect(loadConnectorCapabilityEvidenceTrust({ ...source, NODE_ENV: 'test' }, paths)).toBeUndefined()
    expect(loadConnectorCapabilityEvidenceTrust(source, { ...paths, evidencePath: join(tmpdir(), 'missing-capability-evidence') })).toBeUndefined()

    const replacement = join(dirname(paths.publicKeyPath), 'public-link.pem')
    symlinkSync(paths.publicKeyPath, replacement)
    expect(loadConnectorCapabilityEvidenceTrust(source, { ...paths, publicKeyPath: replacement })).toBeUndefined()
  })
})
