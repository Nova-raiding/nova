import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createScreenshotMatrixEvidence } from './screenshot-matrix-evidence.mjs'

async function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

async function repository(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'screenshot-matrix-evidence-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  await git(cwd, 'init', '-q')
  await git(cwd, 'config', 'user.email', 'matrix-test@example.invalid')
  await git(cwd, 'config', 'user.name', 'Matrix Test')
  await writeFile(join(cwd, '.gitignore'), 'evidence/\n')
  await writeFile(join(cwd, 'tracked.txt'), 'committed baseline\n')
  await git(cwd, 'add', '.gitignore', 'tracked.txt')
  await git(cwd, 'commit', '-qm', 'fixture')
  return cwd
}

test('writes clean SHA, per-page viewport/time, and a positive exact-clean claim', async t => {
  const cwd = await repository(t)
  const evidenceDir = join(cwd, 'evidence')
  const times = [new Date('2026-09-30T01:02:03.000Z'), new Date('2026-09-30T01:02:04.000Z'), new Date('2026-09-30T01:02:05.000Z')]
  const evidence = await createScreenshotMatrixEvidence({ evidenceDir, matrixName: 'ops', cwd, now: () => times.shift() })
  const screenshot = join(evidenceDir, 'overview.png')
  const page = { viewportSize: () => ({ width: 1440, height: 1050 }), url: () => 'http://127.0.0.1:8080/ops/overview?workbench=platform', screenshot: async ({ path, fullPage }) => {
    assert.equal(fullPage, true)
    await writeFile(path, Buffer.from('png-test'))
  } }
  await evidence.capture(page, { filePath: screenshot, label: 'overview' })
  const manifest = await evidence.finalize()
  assert.equal(manifest.source.gitSha.length, 40)
  assert.equal(manifest.source.captureStart.status, 'clean')
  assert.deepEqual(manifest.source.captureStart.dirtyPaths, [])
  assert.equal(manifest.source.exactCleanShaClaimable, true)
  assert.equal(manifest.source.claimStatus, 'exact_clean_git_sha')
  assert.deepEqual(manifest.captures[0], {
    label: 'overview', file: 'overview.png', route: '/ops/overview?workbench=platform', viewport: { width: 1440, height: 1050 },
    fullPage: true, capturedAt: '2026-09-30T01:02:04.000Z',
  })
})

test('records only dirty paths and forbids an exact clean SHA claim for dirty source', async t => {
  const cwd = await repository(t)
  await writeFile(join(cwd, 'tracked.txt'), 'sensitive diff content must never appear')
  await mkdir(join(cwd, 'new-dir'))
  await writeFile(join(cwd, 'new-dir', 'untracked.txt'), 'untracked content must never appear')
  const evidenceDir = join(cwd, 'evidence')
  const evidence = await createScreenshotMatrixEvidence({ evidenceDir, matrixName: 'merchant', cwd })
  const page = { viewportSize: () => ({ width: 1440, height: 1050 }), url: () => 'http://127.0.0.1:8081/merchant/overview', screenshot: async ({ path }) => writeFile(path, 'png-test') }
  await evidence.capture(page, { filePath: join(evidenceDir, 'overview.png'), label: 'overview' })
  const manifest = await evidence.finalize()
  assert.equal(manifest.source.captureStart.status, 'dirty')
  assert.deepEqual(manifest.source.captureStart.dirtyPaths, ['new-dir/untracked.txt', 'tracked.txt'])
  assert.equal(manifest.source.exactCleanShaClaimable, false)
  assert.equal(manifest.source.claimStatus, 'dirty_or_changed_source_no_exact_clean_sha_claim')
  const serialized = await readFile(evidence.manifestPath, 'utf8')
  assert.doesNotMatch(serialized, /sensitive diff content|untracked content/)
  assert.match(serialized, /tracked\.txt/)
  assert.match(serialized, /new-dir\/untracked\.txt/)
})

test('rejects screenshots outside the private evidence root', async t => {
  const cwd = await repository(t)
  const evidenceDir = join(cwd, 'evidence')
  const evidence = await createScreenshotMatrixEvidence({ evidenceDir, matrixName: 'ops', cwd })
  const page = { viewportSize: () => ({ width: 1440, height: 1050 }), url: () => 'http://127.0.0.1/ops/overview', screenshot: async () => assert.fail('must reject before screenshot') }
  await assert.rejects(evidence.capture(page, { filePath: join(cwd, 'outside.png'), label: 'overview' }), /SCREENSHOT_MATRIX_CAPTURE_PATH_OUTSIDE_EVIDENCE_ROOT/u)
})
