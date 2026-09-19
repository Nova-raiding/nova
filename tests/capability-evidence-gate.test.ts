import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { signProductionEvidence } from './production-evidence-gate.js'
import { REQUIRED_CAPABILITIES, REQUIRED_PLATFORMS, validateCapabilityEvidence, validateCapabilityProductionSignature } from './capability-evidence-gate.js'

const root = resolve(import.meta.dirname, '..')
const CLI = 'tests/capability-evidence-gate.ts'
const FIXTURE = 'doc/todo/platform/platform-capability-evidence.example.json'
// The in-memory documents above never touch the repository fixture, so they
// cannot catch a fixture that drifted out of the gate's contract. These run the
// real CLI entrypoint against the real file.
const runGate = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
  cwd: root,
  encoding: 'utf8',
  timeout: 120_000,
})

function document(state: string = 'production_canary') {
  return {
    schema_version: '1', release_id: 'release-1', environment: 'preproduction', generated_at: '2026-08-23T00:00:00Z',
    platforms: REQUIRED_PLATFORMS.map(platform => ({
      platform,
      application_id: `${platform}-app`,
      test_store_id: `${platform}-store`,
      tenant_context: { workspace_id: `${platform}-workspace`, account_id: `${platform}-account` },
      capabilities: Object.fromEntries(REQUIRED_CAPABILITIES.map(capability => [capability, {
        state,
        evidence_ref: 'artifact://evidence/1',
        verified_by: 'qa',
        verified_at: '2026-08-23T00:00:00Z',
        api_version: 'v1',
        scope: 'product.read product.write',
        protocol: { name: 'https', version: '1.0' },
        error_evidence: { request_id: `error-${platform}-${capability}`, code: 'VALIDATION_FAILED', message: 'controlled negative-path response', observed_at: '2026-08-23T00:00:00Z', retryable: false },
      }]))
    })),
  }
}

describe('capability evidence gate', () => {
  it('accepts a complete production canary matrix', () => expect(validateCapabilityEvidence(document(), { requireCanary: true })).toEqual([]))
  it('rejects a missing platform and incomplete capability evidence', () => {
    const value = document('test_e2e') as any
    value.platforms = value.platforms.slice(0, 3)
    delete value.platforms[0].capabilities.update.evidence_ref
    expect(validateCapabilityEvidence(value, { requireCanary: true }).some(error => error.includes('missing platform: pinduoduo'))).toBe(true)
    expect(validateCapabilityEvidence(value).some(error => error.includes('update.evidence_ref'))).toBe(true)
  })
  it('rejects secret-like evidence fields', () => {
    const value = document() as any
    value.platforms[0].capabilities.read.access_token = 'never-store-this'
    expect(validateCapabilityEvidence(value)).toContain('evidence document must not contain secret-like keys or values')
  })
  it('binds evidence to the release being deployed', () => {
    expect(validateCapabilityEvidence(document(), { expectedReleaseId: 'release-2' })).toContain('release_id must match release-2')
  })
  it('requires a production environment and strict evidence timestamps for canary promotion', () => {
    const value = document() as any
    value.environment = 'local'
    value.generated_at = '2026-08-23'
    expect(validateCapabilityEvidence(value, { requireCanary: true })).toEqual(expect.arrayContaining([
      'environment must be preproduction or production for production_canary',
      'generated_at must be an ISO date',
    ]))
  })
  it('rejects a capability verified after the evidence document was generated', () => {
    const value = document() as any
    value.platforms[0].capabilities.read.verified_at = '2026-08-24T00:00:00Z'
    expect(validateCapabilityEvidence(value)).toContain('jd.read.verified_at cannot be after generated_at')
  })
  it('rejects placeholders inside a canary capability record', () => {
    const value = document() as any
    value.platforms[0].capabilities.read.scope = 'SET_SCOPE_FROM_PLATFORM'
    expect(validateCapabilityEvidence(value)).toContain('jd.read contains a placeholder production_canary field')
  })
  it('reports malformed platform entries without throwing', () => {
    const value = document() as any
    value.platforms[0] = null
    expect(validateCapabilityEvidence(value)).toContain('platform entry must be an object')
  })

  it('requires a trusted signature bound to the exact production deployment', () => {
    const pair = generateKeyPairSync('ed25519')
    const privateKeyPem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    const publicKeyPem = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString()
    const bindings = { releaseId: 'release-1', imageSetDigest: `sha256:${'a'.repeat(64)}`, manifestSha256: 'b'.repeat(64), releaseGitSha: 'c'.repeat(40), deploymentNonce: 'deployment_nonce_abcdefghijklmnop', trustedKeyId: 'release-security-2026', publicKeyPem }
    const value = Object.assign(document(), { environment: 'production', image_set_digest: bindings.imageSetDigest, manifest_sha256: bindings.manifestSha256, release_git_sha: bindings.releaseGitSha, deployment_nonce: bindings.deploymentNonce, key_id: bindings.trustedKeyId, simulated: false }) as any
    value.signature_base64 = signProductionEvidence(value, privateKeyPem)
    expect(validateCapabilityProductionSignature(value, bindings)).toEqual([])
    value.platforms[0].capabilities.read.scope = 'tampered'
    expect(validateCapabilityProductionSignature(value, bindings)).toContain('signature_base64 is invalid')
  })

  it('accepts the on-disk example fixture through the real CLI entrypoint', () => {
    const result = runGate(['--file', FIXTURE])
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(`capability evidence schema passed: ${FIXTURE}`)
    // The fixture is not production evidence and the CLI must say so.
    expect(result.stdout).toContain('fixture/non-production validation only')
  })

  it('fails closed when a capability is missing from the fixture instead of silently passing', () => {
    const directory = mkdtempSync(join(tmpdir(), 'capability-evidence-'))
    try {
      const drifted = JSON.parse(readFileSync(resolve(root, FIXTURE), 'utf8')) as { platforms: Array<{ platform: string; capabilities: Record<string, unknown> }> }
      delete drifted.platforms[0]!.capabilities.refresh
      const driftedPath = join(directory, 'drifted.json')
      writeFileSync(driftedPath, JSON.stringify(drifted))
      const result = runGate(['--file', driftedPath])
      expect(result.status, result.stderr).toBe(1)
      expect(result.stderr).toContain(`${drifted.platforms[0]!.platform}.refresh.state is invalid`)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('requires an explicit --file rather than defaulting to the example fixture', () => {
    const result = runGate([])
    expect(result.status, result.stderr).toBe(2)
    expect(result.stderr).toContain('--file is required')
    expect(result.stdout).not.toContain('passed')
  })

  it('rejects a valid signature bound to another manifest or nonce', () => {
    const pair = generateKeyPairSync('ed25519')
    const privateKeyPem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    const publicKeyPem = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString()
    const value = Object.assign(document(), { environment: 'production', image_set_digest: `sha256:${'a'.repeat(64)}`, manifest_sha256: 'b'.repeat(64), release_git_sha: 'c'.repeat(40), deployment_nonce: 'deployment_nonce_abcdefghijklmnop', key_id: 'release-security-2026', simulated: false }) as any
    value.signature_base64 = signProductionEvidence(value, privateKeyPem)
    expect(validateCapabilityProductionSignature(value, { releaseId: 'release-1', imageSetDigest: value.image_set_digest, manifestSha256: 'd'.repeat(64), releaseGitSha: value.release_git_sha, deploymentNonce: 'different_deployment_nonce_1234', trustedKeyId: value.key_id, publicKeyPem })).toEqual(expect.arrayContaining([`manifest_sha256 must match ${'d'.repeat(64)}`, 'deployment_nonce must match different_deployment_nonce_1234']))
  })
})
