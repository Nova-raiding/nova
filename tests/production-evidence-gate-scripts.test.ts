import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const temporaryDirectories: string[] = []
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
const temporaryDirectory = () => { const directory = realpathSync(mkdtempSync(join(tmpdir(), 'production-evidence-gate-'))); temporaryDirectories.push(directory); chmodSync(directory, 0o700); return directory }
const run = (script: string, args: string[] = [], env: Record<string, string> = {}) => execFileSync('sh', [script, ...args], { cwd: resolve('.'), encoding: 'utf8', env: { ...process.env, ...env }, stdio: 'pipe' })
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const testHook = (trustDirectory: string) => ({ NODE_ENV: 'test', PRODUCTION_EVIDENCE_TEST_HOOK: 'enabled-for-local-tests-only', PRODUCTION_EVIDENCE_TEST_TRUST_DIR: trustDirectory })

const provisionTrustBundle = (directory: string, consumerContents = '#!/bin/sh\nexit 0\n') => {
  const pair = generateKeyPairSync('ed25519')
  const pem = pair.publicKey.export({ format: 'pem', type: 'spki' })
  const der = pair.publicKey.export({ format: 'der', type: 'spki' })
  writeFileSync(join(directory, 'production-evidence-public.pem'), pem, { mode: 0o600 })
  writeFileSync(join(directory, 'production-evidence-key-id'), 'release-security-2026\n', { mode: 0o600 })
  writeFileSync(join(directory, 'production-evidence-public-key-sha256'), `${sha256(der)}\n`, { mode: 0o600 })
  writeFileSync(join(directory, 'production-evidence-nonce-consumer-sha256'), `${sha256(consumerContents)}\n`, { mode: 0o600 })
  writeFileSync(join(directory, 'production-capability-attester-sha256'), `${sha256('#!/bin/sh\nexit 0\n')}\n`, { mode: 0o600 })
  writeFileSync(join(directory, 'production-evidence-bundle-attester-sha256'), `${sha256('#!/bin/sh\nexit 0\n')}\n`, { mode: 0o600 })
  const controls = join(directory, 'controls'); mkdirSync(controls, { mode: 0o700 })
  for (const name of ['attest-capability-evidence', 'attest-manual-operations-evidence', 'attest-release-evidence-bundle']) {
    writeFileSync(join(controls, name), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  }
  writeFileSync(join(directory, 'production-manual-operations-attester-sha256'), `${sha256('#!/bin/sh\nexit 0\n')}\n`, { mode: 0o600 })
}

const nonceEnvironment = (directory: string, consumer: string) => ({
  ...testHook(directory), PRODUCTION_EVIDENCE_TEST_NONCE_CONSUMER: consumer, PRODUCTION_EVIDENCE_REPO_ROOT: resolve('.'),
  DEPLOYMENT_NONCE: 'deployment_nonce_abcdefghijklmnop', RELEASE_ID: 'release-1', IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`,
  PRODUCTION_EVIDENCE_MANIFEST_SHA256: 'b'.repeat(64), RELEASE_GIT_SHA: 'c'.repeat(40),
})

const deployPreflightEnvironment = (directory: string, overrides: Record<string, string> = {}) => {
  const placeholder = join(directory, 'placeholder.json')
  writeFileSync(placeholder, '{}')
  const imageDigest = (letter: string) => `sha256:${letter.repeat(64)}`
  return {
    NODE_ENV: 'test', VITEST: 'true',
    PRODUCTION_CONFIG_PATH: join(directory, 'production.yml'),
    RELEASE_ID: 'candidate-test-1',
    IMAGE_DIGESTS_JSON: JSON.stringify({ 'merchant-api': imageDigest('a'), 'merchant-worker': imageDigest('b'), 'merchant-ui': imageDigest('c'), 'merchant-ops-ui': imageDigest('d'), clamav: imageDigest('e') }),
    DATABASE_URL: 'postgresql://merchant_app:local@db.example.test/merchant?sslmode=verify-full',
    OPS_DATABASE_URL: 'postgresql://merchant_ops:local@db.example.test/merchant?sslmode=verify-full',
    ALERT_RECEIVER_DATABASE_URL: 'postgresql://merchant_alert:local@db.example.test/merchant?sslmode=verify-full',
    REDIS_URL: 'rediss://redis.example.test:6379', SECRET_PROVIDER: 'ecs-protected-env',
    CAPABILITY_EVIDENCE_PATH: placeholder, CAPACITY_REPORT_PATH: placeholder,
    MODEL_RELAY_EVIDENCE_PATH: placeholder, CODEX_APP_HOST_EVIDENCE_PATH: placeholder,
    OBJECT_STORAGE_EVIDENCE_PATH: placeholder, CANONICAL_CUTOVER_EVIDENCE_PATH: placeholder,
    EXPECTED_MIGRATION_VERSION: '248', RELEASE_MANIFEST_PATH: placeholder, PAYMENT_EVIDENCE_PATH: placeholder,
    RESTORE_EVIDENCE_PATH: placeholder, RENDERED_MANIFEST_PATH: placeholder, PRODUCTION_EVIDENCE_ARTIFACT_ROOT: directory,
    ...overrides,
  }
}

describe('production evidence trust and replay scripts', () => {
  it('accepts a secure test bundle and rejects repository-local or environment-selected anchors', () => {
    const directory = temporaryDirectory(); provisionTrustBundle(directory)
    expect(run('infra/scripts/validate-production-evidence-trust.sh', [resolve('.')], testHook(directory))).toContain('trust boundary passed')
    expect(() => run('infra/scripts/validate-production-evidence-trust.sh', [resolve('.')], testHook(resolve('infra/trust')))).toThrow(/outside the mutable repository/)
    expect(() => run('infra/scripts/validate-production-evidence-trust.sh', [resolve('.')], { PRODUCTION_EVIDENCE_TRUST_DIR: directory })).toThrow(/forbidden.*fixed/)
  })

  it('checks the selected attester and bundle bytes, without requiring the other operations mode', () => {
    const directory = temporaryDirectory(); provisionTrustBundle(directory)
    const capabilityDigest = join(directory, 'production-capability-attester-sha256')
    unlinkSync(capabilityDigest)
    expect(run('infra/scripts/validate-production-evidence-trust.sh', [resolve('.'), 'manual'], testHook(directory))).toContain('trust boundary passed')
    expect(() => run('infra/scripts/validate-production-evidence-trust.sh', [resolve('.'), 'official_api'], testHook(directory))).toThrow(/capability.*digest|trust file/)
    writeFileSync(capabilityDigest, `${sha256('#!/bin/sh\nexit 0\n')}\n`, { mode: 0o600 })
    writeFileSync(join(directory, 'controls', 'attest-manual-operations-evidence'), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
    expect(() => run('infra/scripts/validate-production-evidence-trust.sh', [resolve('.'), 'manual'], testHook(directory))).toThrow(/manual operations attester digest mismatch/)
    writeFileSync(join(directory, 'controls', 'attest-manual-operations-evidence'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    writeFileSync(join(directory, 'controls', 'attest-release-evidence-bundle'), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
    expect(() => run('infra/scripts/validate-production-evidence-trust.sh', [resolve('.'), 'manual'], testHook(directory))).toThrow(/bundle attester digest mismatch/)
  })

  it('rejects unsafe mode selection and modified or symlinked control executables', () => {
    const directory = temporaryDirectory(); provisionTrustBundle(directory)
    expect(() => run('infra/scripts/validate-production-evidence-trust.sh', [resolve('.'), 'unknown'], testHook(directory))).toThrow(/mode must be manual or official_api/)
    writeFileSync(join(directory, 'controls', 'attest-capability-evidence'), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
    expect(() => run('infra/scripts/validate-production-evidence-trust.sh', [resolve('.'), 'official_api'], testHook(directory))).toThrow(/capability attester digest mismatch/)
    const control = join(directory, 'controls', 'attest-release-evidence-bundle')
    const target = join(directory, 'controls', 'bundle-target')
    writeFileSync(target, '#!/bin/sh\nexit 0\n', { mode: 0o700 }); unlinkSync(control); symlinkSync(target, control)
    expect(() => run('infra/scripts/validate-production-evidence-trust.sh', [resolve('.'), 'manual'], testHook(directory))).toThrow(/regular non-symlink executable/)
  })

  it('fails closed unless the non-production test hook has both explicit guards', () => {
    const directory = temporaryDirectory(); provisionTrustBundle(directory)
    expect(() => run('infra/scripts/validate-production-evidence-trust.sh', [resolve('.')], { NODE_ENV: 'production', PRODUCTION_EVIDENCE_TEST_HOOK: 'enabled-for-local-tests-only', PRODUCTION_EVIDENCE_TEST_TRUST_DIR: directory })).toThrow(/requires NODE_ENV=test/)
    expect(() => run('infra/scripts/validate-production-evidence-trust.sh', [resolve('.')], { NODE_ENV: 'test', PRODUCTION_EVIDENCE_TEST_HOOK: 'yes', PRODUCTION_EVIDENCE_TEST_TRUST_DIR: directory })).toThrow(/exact local-test token/)
    expect(() => run('infra/scripts/validate-production-evidence-trust.sh', [resolve('.')], { PRODUCTION_EVIDENCE_TEST_TRUST_DIR: directory })).toThrow(/forbidden without the explicit test hook/)
  })

  it('makes deploy preflight reject every trust-path and test-hook override before other work', () => {
    expect(() => run('infra/scripts/deploy-preflight.sh', [], { PRODUCTION_EVIDENCE_TRUST_DIR: '/tmp/anchor' })).toThrow(/forbidden.*fixed/)
    expect(() => run('infra/scripts/deploy-preflight.sh', [], { PRODUCTION_EVIDENCE_NONCE_CONSUMER: '/tmp/consumer' })).toThrow(/forbidden.*fixed/)
    expect(() => run('infra/scripts/deploy-preflight.sh', [], { NODE_ENV: 'test', PRODUCTION_EVIDENCE_TEST_HOOK: 'enabled-for-local-tests-only' })).toThrow(/test hooks are forbidden/)
    expect(() => run('infra/scripts/deploy-preflight.sh', [], { NODE_ENV: 'test', PRODUCTION_EVIDENCE_TEST_TRUST_DIR: '/tmp/anchor' })).toThrow(/test paths are forbidden/)
    expect(() => run('infra/scripts/deploy-preflight.sh', [], { NODE_ENV: 'test', PRODUCTION_EVIDENCE_TEST_NONCE_CONSUMER: '/tmp/consumer' })).toThrow(/test paths are forbidden/)
    expect(() => run('infra/scripts/deploy-preflight.sh', [], { NODE_ENV: 'production', VITEST: 'true' })).toThrow(/VITEST.*NODE_ENV=test/)
  })

  it('fails closed when the capability or capacity evidence path is missing or unreadable', () => {
    const directory = temporaryDirectory()
    const config = join(directory, 'production.yml')
    writeFileSync(config, 'platform_operations_mode: manual\n')
    const missingCapability = join(directory, 'missing-capability.json')
    const unreadableCapability = join(directory, 'unreadable-capability.json')
    symlinkSync(join(directory, 'absent-target.json'), unreadableCapability)
    const missingCapacity = join(directory, 'missing-capacity.json')
    const unreadableCapacity = join(directory, 'unreadable-capacity.json')
    symlinkSync(join(directory, 'absent-capacity-target.json'), unreadableCapacity)

    for (const [field, path, expected] of [
      ['CAPABILITY_EVIDENCE_PATH', missingCapability, 'capability evidence file not found'],
      ['CAPABILITY_EVIDENCE_PATH', unreadableCapability, 'capability evidence file not found'],
      ['CAPACITY_REPORT_PATH', missingCapacity, 'capacity report not found'],
      ['CAPACITY_REPORT_PATH', unreadableCapacity, 'capacity report not found'],
    ] as const) {
      const result = spawnSync('sh', ['infra/scripts/deploy-preflight.sh'], {
        cwd: resolve('.'), encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, ...deployPreflightEnvironment(directory, { [field]: path, PRODUCTION_CONFIG_PATH: config }) },
      })
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(1)
      expect(result.stderr).toContain(expected)
      expect(result.stdout + result.stderr).not.toContain('deploy preflight passed')
    }
  })

  it('keeps capability evidence and the capacity artifact under the exact candidate release binding', () => {
    const preflight = readFileSync('infra/scripts/deploy-preflight.sh', 'utf8').replace(/\\\n\s*/gu, ' ')
    const bundleGate = readFileSync('tests/release-evidence-bundle-gate.ts', 'utf8')
    expect(preflight).toContain('manual-operations-evidence-gate.ts" --file "$CAPABILITY_EVIDENCE_PATH" --release-id "$RELEASE_ID"')
    expect(preflight).toContain('capability-evidence-gate.ts" --file "$CAPABILITY_EVIDENCE_PATH" --require-canary --require-signed-production --release-id "$RELEASE_ID"')
    expect(preflight).toContain('--require-signed-production --image-set-digest "$image_set_digest" --manifest-sha256 "$manifest_sha256"')
    expect(preflight).toContain('--release-git-sha "$release_git_sha" --deployment-nonce "$DEPLOYMENT_NONCE"')
    expect(preflight).toContain('--capability-evidence "$CAPABILITY_EVIDENCE_PATH" --capacity-evidence "$CAPACITY_REPORT_PATH"')
    expect(preflight).toContain('--release-id "$RELEASE_ID" --image-set-digest "$image_set_digest"')
    expect(preflight).toContain('--release-git-sha "$release_git_sha" --deployment-nonce "$DEPLOYMENT_NONCE"')
    expect(bundleGate).toContain('image_set_digest:options.imageSetDigest, manifest_sha256:options.manifestSha256, release_git_sha:options.releaseGitSha')
    expect(bundleGate).toContain('if (kind === \'capacity\')')
    expect(bundleGate).toContain('if (sha256(bytes) !== match[2]) errors.push(`${kind} artifact SHA-256 mismatch`)')
    expect(bundleGate).toContain('manifest.productionEvidence?.[kind] !== bundleRefs.get(kind)')
  })

  it('rejects writable trust directories, symlinked files, and public-key fingerprint mismatch', () => {
    const writableDirectory = temporaryDirectory(); provisionTrustBundle(writableDirectory); chmodSync(writableDirectory, 0o777)
    expect(() => run('infra/scripts/validate-production-evidence-trust.sh', [resolve('.')], testHook(writableDirectory))).toThrow(/must not be writable by group or other users/)

    const symlinkDirectory = temporaryDirectory(); provisionTrustBundle(symlinkDirectory)
    const publicKey = join(symlinkDirectory, 'production-evidence-public.pem'); const target = join(symlinkDirectory, 'key-target.pem')
    writeFileSync(target, readFileSync(publicKey)); unlinkSync(publicKey); symlinkSync(target, publicKey)
    expect(() => run('infra/scripts/validate-production-evidence-trust.sh', [resolve('.')], testHook(symlinkDirectory))).toThrow(/regular non-symlink/)

    const attesterSymlinkDirectory = temporaryDirectory(); provisionTrustBundle(attesterSymlinkDirectory)
    const attesterDigest = join(attesterSymlinkDirectory, 'production-capability-attester-sha256'); const attesterDigestTarget = join(attesterSymlinkDirectory, 'attester-digest-target')
    writeFileSync(attesterDigestTarget, readFileSync(attesterDigest)); unlinkSync(attesterDigest); symlinkSync(attesterDigestTarget, attesterDigest)
    expect(() => run('infra/scripts/validate-production-evidence-trust.sh', [resolve('.')], testHook(attesterSymlinkDirectory))).toThrow(/regular non-symlink/)

    const mismatchDirectory = temporaryDirectory(); provisionTrustBundle(mismatchDirectory)
    writeFileSync(join(mismatchDirectory, 'production-evidence-public-key-sha256'), `${'f'.repeat(64)}\n`, { mode: 0o600 })
    expect(() => run('infra/scripts/validate-production-evidence-trust.sh', [resolve('.')], testHook(mismatchDirectory))).toThrow(/fingerprint mismatch/)

    const ownerDirectory = temporaryDirectory(); provisionTrustBundle(ownerDirectory)
    const fakeBin = join(ownerDirectory, 'fake-bin'); mkdirSync(fakeBin, { mode: 0o700 })
    const fakeStat = join(fakeBin, 'stat')
    writeFileSync(fakeStat, '#!/bin/sh\ncase "$*" in *production-evidence-public.pem*) echo 99999 ;; *) exec /usr/bin/stat "$@" ;; esac\n', { mode: 0o700 })
    expect(() => run('infra/scripts/validate-production-evidence-trust.sh', [resolve('.')], { ...testHook(ownerDirectory), PATH: `${fakeBin}:${process.env.PATH ?? ''}` })).toThrow(/must be owned by uid/)
  })

  it('passes exact bindings to the digest-pinned atomic nonce consumer and refuses replay', () => {
    const directory = temporaryDirectory(); const consumer = join(directory, 'consume-once.sh'); const capture = join(directory, 'capture.txt'); const state = join(directory, 'consumed')
    const consumerContents = '#!/bin/sh\nif mkdir "$NONCE_STATE" 2>/dev/null; then printf "%s\\n" "$@" > "$NONCE_CAPTURE"; exit 0; fi\nexit 23\n'
    writeFileSync(consumer, consumerContents, { mode: 0o700 }); provisionTrustBundle(directory, consumerContents)
    const env = { ...nonceEnvironment(directory, consumer), NONCE_STATE: state, NONCE_CAPTURE: capture }
    expect(run('infra/scripts/consume-production-evidence-nonce.sh', [], env)).toContain('nonce consumed')
    expect(readFileSync(capture, 'utf8').trim().split('\n')).toEqual(['consume', '--namespace', 'merchant-production-deploy', '--nonce', env.DEPLOYMENT_NONCE, '--release-id', env.RELEASE_ID, '--image-digest', env.IMAGE_DIGEST, '--manifest-sha256', env.PRODUCTION_EVIDENCE_MANIFEST_SHA256, '--release-git-sha', env.RELEASE_GIT_SHA])
    expect(() => run('infra/scripts/consume-production-evidence-nonce.sh', [], env)).toThrow(/already consumed|atomically/)
  })

  it('rejects consumer path overrides, insecure modes, symlinks, and digest mismatch', () => {
    const directory = temporaryDirectory(); const consumer = join(directory, 'consumer.sh'); const consumerContents = '#!/bin/sh\nexit 0\n'
    writeFileSync(consumer, consumerContents, { mode: 0o700 }); provisionTrustBundle(directory, consumerContents)
    const env = nonceEnvironment(directory, consumer)
    expect(() => run('infra/scripts/consume-production-evidence-nonce.sh', [], { ...env, PRODUCTION_EVIDENCE_NONCE_CONSUMER: consumer })).toThrow(/forbidden.*fixed/)
    chmodSync(consumer, 0o722)
    expect(() => run('infra/scripts/consume-production-evidence-nonce.sh', [], env)).toThrow(/must not be writable by group or other users/)
    chmodSync(consumer, 0o700)
    writeFileSync(join(directory, 'production-evidence-nonce-consumer-sha256'), `${'0'.repeat(64)}\n`, { mode: 0o600 })
    expect(() => run('infra/scripts/consume-production-evidence-nonce.sh', [], env)).toThrow(/digest mismatch/)

    const target = join(directory, 'consumer-target.sh'); writeFileSync(target, consumerContents, { mode: 0o700 }); unlinkSync(consumer); symlinkSync(target, consumer)
    expect(() => run('infra/scripts/consume-production-evidence-nonce.sh', [], env)).toThrow(/regular non-symlink executable/)
  })
})
