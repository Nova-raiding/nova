import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const temporaryDirectories: string[] = []
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
const temporaryDirectory = () => { const directory = mkdtempSync(join(tmpdir(), 'production-evidence-gate-')); temporaryDirectories.push(directory); return directory }
const run = (script: string, args: string[] = [], env: Record<string, string> = {}) => execFileSync('sh', [script, ...args], { cwd: resolve('.'), encoding: 'utf8', env: { ...process.env, ...env }, stdio: 'pipe' })

describe('production evidence trust and replay scripts', () => {
  it('accepts an externally provisioned trust bundle and rejects a repository-local anchor', () => {
    const directory = temporaryDirectory(); const pair = generateKeyPairSync('ed25519')
    writeFileSync(join(directory, 'production-evidence-public.pem'), pair.publicKey.export({ format: 'pem', type: 'spki' }))
    writeFileSync(join(directory, 'production-evidence-key-id'), 'release-security-2026\n')
    expect(run('infra/scripts/validate-production-evidence-trust.sh', [resolve('.'), directory])).toContain('trust boundary passed')
    expect(() => run('infra/scripts/validate-production-evidence-trust.sh', [resolve('.'), resolve('infra/trust')])).toThrow(/outside the mutable repository/)
  })

  it('rejects unprovisioned and symlinked trust-anchor files', () => {
    const directory = temporaryDirectory()
    writeFileSync(join(directory, 'production-evidence-public.pem'), 'UNPROVISIONED')
    writeFileSync(join(directory, 'production-evidence-key-id'), 'UNPROVISIONED\n')
    expect(() => run('infra/scripts/validate-production-evidence-trust.sh', [resolve('.'), directory])).toThrow(/not provisioned/)

    const pair = generateKeyPairSync('ed25519'); const target = join(directory, 'key-target.pem')
    writeFileSync(target, pair.publicKey.export({ format: 'pem', type: 'spki' })); unlinkSync(join(directory, 'production-evidence-public.pem')); symlinkSync(target, join(directory, 'production-evidence-public.pem'))
    writeFileSync(join(directory, 'production-evidence-key-id'), 'release-security-2026\n')
    expect(() => run('infra/scripts/validate-production-evidence-trust.sh', [resolve('.'), directory])).toThrow(/non-symlink/)
  })

  it('passes exact signed bindings to an atomic nonce consumer and refuses replay', () => {
    const directory = temporaryDirectory(); const consumer = join(directory, 'consume-once.sh'); const capture = join(directory, 'capture.txt'); const state = join(directory, 'consumed')
    writeFileSync(consumer, '#!/bin/sh\nif mkdir "$NONCE_STATE" 2>/dev/null; then printf "%s\\n" "$@" > "$NONCE_CAPTURE"; exit 0; fi\nexit 23\n'); chmodSync(consumer, 0o700)
    const env = {
      PRODUCTION_EVIDENCE_NONCE_CONSUMER: consumer,
      PRODUCTION_EVIDENCE_REPO_ROOT: resolve('.'),
      DEPLOYMENT_NONCE: 'deployment_nonce_abcdefghijklmnop',
      RELEASE_ID: 'release-1',
      IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`,
      PRODUCTION_EVIDENCE_MANIFEST_SHA256: 'b'.repeat(64),
      RELEASE_GIT_SHA: 'c'.repeat(40),
      NONCE_STATE: state,
      NONCE_CAPTURE: capture,
    }
    expect(run('infra/scripts/consume-production-evidence-nonce.sh', [], env)).toContain('nonce consumed')
    expect(readFileSync(capture, 'utf8').trim().split('\n')).toEqual(['consume', '--namespace', 'merchant-production-deploy', '--nonce', env.DEPLOYMENT_NONCE, '--release-id', env.RELEASE_ID, '--image-digest', env.IMAGE_DIGEST, '--manifest-sha256', env.PRODUCTION_EVIDENCE_MANIFEST_SHA256, '--release-git-sha', env.RELEASE_GIT_SHA])
    expect(() => run('infra/scripts/consume-production-evidence-nonce.sh', [], env)).toThrow(/already consumed|atomically/)
  })

  it('rejects a relative or missing nonce consumer before deployment', () => {
    const env = { PRODUCTION_EVIDENCE_NONCE_CONSUMER: './consumer', PRODUCTION_EVIDENCE_REPO_ROOT: resolve('.'), DEPLOYMENT_NONCE: 'deployment_nonce_abcdefghijklmnop', RELEASE_ID: 'release-1', IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`, PRODUCTION_EVIDENCE_MANIFEST_SHA256: 'b'.repeat(64), RELEASE_GIT_SHA: 'c'.repeat(40) }
    expect(() => run('infra/scripts/consume-production-evidence-nonce.sh', [], env)).toThrow(/absolute executable path/)
  })

  it('rejects a nonce consumer from the mutable repository', () => {
    const env = { PRODUCTION_EVIDENCE_NONCE_CONSUMER: resolve('infra/scripts/deploy-verified-manifest.sh'), PRODUCTION_EVIDENCE_REPO_ROOT: resolve('.'), DEPLOYMENT_NONCE: 'deployment_nonce_abcdefghijklmnop', RELEASE_ID: 'release-1', IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`, PRODUCTION_EVIDENCE_MANIFEST_SHA256: 'b'.repeat(64), RELEASE_GIT_SHA: 'c'.repeat(40) }
    expect(() => run('infra/scripts/consume-production-evidence-nonce.sh', [], env)).toThrow(/outside the mutable repository/)
  })
})
