import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { REQUIRED_BRIDGE_254_REVIEW_FILES, verifyBridge254ReviewPackage } from '../infra/scripts/verify-ecs-bridge-254-review-package.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bridge-254-review-package-'))
  const source = join(root, 'source'), bundle = join(root, 'bundle')
  mkdirSync(source); mkdirSync(bundle)
  for (const path of REQUIRED_BRIDGE_254_REVIEW_FILES) {
    mkdirSync(join(source, dirname(path)), { recursive: true })
    writeFileSync(join(source, path), `review fixture ${path}\n`)
  }
  execFileSync('git', ['init', '-q'], { cwd: source })
  execFileSync('git', ['add', '.'], { cwd: source })
  execFileSync('git', ['-c', 'user.name=Bridge Review', '-c', 'user.email=bridge@example.invalid', 'commit', '-qm', 'review'], { cwd: source })
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim()
  const archive = join(bundle, 'candidate-source.tar')
  execFileSync('git', ['archive', '--format=tar', `--output=${archive}`, revision], { cwd: source })
  const manifest = `${REQUIRED_BRIDGE_254_REVIEW_FILES.join('\n')}\n`
  const plan = `status\tlocal_sha256\tremote_sha256\tpath\n${REQUIRED_BRIDGE_254_REVIEW_FILES.map(path => `missing_remote\t${sha(readFileSync(join(source, path)))}\t-\t${path}\n`).join('')}`
  writeFileSync(join(bundle, 'files.txt'), manifest)
  writeFileSync(join(bundle, 'sync-plan.tsv'), plan)
  writeFileSync(join(bundle, 'candidate-identity.txt'), `git_sha=${revision}\nsource_sha256=sha256:${sha(readFileSync(archive))}\ncomparison_manifest_sha256=sha256:${sha(manifest)}\nsync_plan_sha256=sha256:${sha(plan)}\n`)
  return { root, bundle, archive }
}
function replaceIdentityDigest(bundle, key, bytes) {
  const path = join(bundle, 'candidate-identity.txt')
  writeFileSync(path, readFileSync(path, 'utf8').replace(new RegExp(`${key}=sha256:[0-9a-f]{64}`, 'u'), `${key}=sha256:${sha(bytes)}`))
}

test('254 review package verifies complete manifest, source archive and per-file digests while remaining blocked', () => {
  const { root, bundle } = fixture()
  try {
    assert.deepEqual(verifyBridge254ReviewPackage(bundle), {
      schema_version: 'ecs-bridge-254-review-package/1', status: 'review_only', deployable: false,
      source_sha256: `sha256:${sha(readFileSync(join(bundle, 'candidate-source.tar')))}`,
      review_files_verified: REQUIRED_BRIDGE_254_REVIEW_FILES.length,
    })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('254 review package rejects an omitted manifest row even after its manifest digest is updated', () => {
  const { root, bundle } = fixture()
  try {
    const path = join(bundle, 'files.txt')
    const content = readFileSync(path, 'utf8').replace(`${REQUIRED_BRIDGE_254_REVIEW_FILES[0]}\n`, '')
    writeFileSync(path, content)
    replaceIdentityDigest(bundle, 'comparison_manifest_sha256', content)
    assert.throws(() => verifyBridge254ReviewPackage(bundle), /comparison manifest omits/u)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('254 review package rejects a missing source archive member', () => {
  const { root, bundle, archive } = fixture()
  try {
    const source = join(root, 'source')
    const omitted = REQUIRED_BRIDGE_254_REVIEW_FILES[0]
    execFileSync('git', ['rm', '-q', '--', omitted], { cwd: source })
    execFileSync('git', ['-c', 'user.name=Bridge Review', '-c', 'user.email=bridge@example.invalid', 'commit', '-qm', 'omit'], { cwd: source })
    execFileSync('git', ['archive', '--format=tar', `--output=${archive}`, 'HEAD'], { cwd: source })
    replaceIdentityDigest(bundle, 'source_sha256', readFileSync(archive))
    assert.throws(() => verifyBridge254ReviewPackage(bundle), /source archive omits/u)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('254 review package rejects changed bytes with an updated archive identity but stale per-file plan', () => {
  const { root, bundle, archive } = fixture()
  try {
    const source = join(root, 'source')
    writeFileSync(join(source, REQUIRED_BRIDGE_254_REVIEW_FILES[0]), 'tampered review source\n')
    execFileSync('git', ['add', '.'], { cwd: source })
    execFileSync('git', ['-c', 'user.name=Bridge Review', '-c', 'user.email=bridge@example.invalid', 'commit', '-qm', 'tamper'], { cwd: source })
    execFileSync('git', ['archive', '--format=tar', `--output=${archive}`, 'HEAD'], { cwd: source })
    replaceIdentityDigest(bundle, 'source_sha256', readFileSync(archive))
    assert.throws(() => verifyBridge254ReviewPackage(bundle), /source digest differs from sync plan/u)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
