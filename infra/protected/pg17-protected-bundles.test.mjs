import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { backupAttemptDirectoryName } from './attest-pg17-backup-baseline.mjs'

const entries = [
  ['attest-pg17-frozen-plan', 'PG17 frozen plan rejected'],
  ['attest-pg17-backup-baseline', 'PG17 baseline backup rejected'],
]
const banner = 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'

test('backup attempt path meets the installed isolated restore runner contract', () => {
  assert.equal(backupAttemptDirectoryName('release-39fc097d-review', '20260927t1200z'), 'release-39fc097d-review-attempt-20260927t1200z')
  assert.throws(() => backupAttemptDirectoryName('release-39fc097d-review', '../escape'), /identity invalid/u)
})

for (const [name, rejection] of entries) test(`${name} bundles reproducibly and enters only its protected CLI`, async () => {
  const entryPoints = [`infra/protected/${name}.mjs`]
  const buildOnce = async () => (await build({ entryPoints, bundle: true, platform: 'node', format: 'esm', banner: { js: banner }, write: false, logLevel: 'silent' })).outputFiles[0].contents
  const first = await buildOnce(), second = await buildOnce()
  assert.deepEqual(first, second)
  assert.equal(Buffer.from(first).toString('utf8').startsWith('#!/usr/bin/env node\n'), true)
  const directory = mkdtempSync(join(tmpdir(), 'pg17-protected-control-'))
  try {
    const executable = join(directory, name)
    writeFileSync(executable, first, { mode: 0o700 })
    const result = spawnSync(process.execPath, [executable], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
    assert.equal(result.status, 1)
    assert.match(result.stderr, new RegExp(rejection, 'u'))
    assert.doesNotMatch(result.stderr, /backup attestation rejected/u)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
