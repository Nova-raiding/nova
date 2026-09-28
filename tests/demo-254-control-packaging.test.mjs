import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { packageDemo254Controls } from '../infra/scripts/prepare-demo-254-backup-bundles.mjs'
import { runDemo254InstallSteps, validateDemo254InstallManifest } from '../infra/protected/install-demo-254-backup-controls.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
test('exact commit sources yield standalone plan, backup and nonce control manifest', () => {
  const parent = mkdtempSync(join(tmpdir(), 'demo254-package-test-'))
  const output = join(parent, 'bundle')
  const commit = 'a'.repeat(40)
  const result = packageDemo254Controls({ commit, output, readCommit: (_, path) => readFileSync(resolve(path)) })
  const plan = readFileSync(join(output, 'attest-demo-254-frozen-plan'))
  const backup = readFileSync(join(output, 'attest-demo-254-backup'))
  const nonce = readFileSync(join(output, 'consume-production-evidence-nonce'))
  assert.equal(result.manifest.source_commit, commit)
  assert.equal(result.manifest_sha256, sha(readFileSync(join(output, 'manifest.json'))))
  assert.equal(validateDemo254InstallManifest(result.manifest, { plan, backup, nonce }), true)
  assert.throws(() => validateDemo254InstallManifest(result.manifest, { plan, backup: Buffer.from('tampered'), nonce }), /checksum mismatch/u)
  assert.throws(() => packageDemo254Controls({ commit, output, readCommit: (_, path) => readFileSync(resolve(path)) }), /EEXIST/u)
})

test('install order is plan then backup then nonce; failure restores prior controls', () => {
  const order = []
  runDemo254InstallSteps([() => order.push('plan'), () => order.push('backup'), () => order.push('nonce')], () => order.push('recover'))
  assert.deepEqual(order, ['plan', 'backup', 'nonce'])
  const failed = []
  assert.throws(() => runDemo254InstallSteps([() => failed.push('plan'), () => { throw new Error('backup install failed') }, () => failed.push('nonce')],
    () => failed.push('recover')), /prior controls restored/u)
  assert.deepEqual(failed, ['plan', 'recover'])
  assert.throws(() => runDemo254InstallSteps([() => { throw new Error('plan failed') }, () => {}, () => {}],
    () => { throw new Error('recovery failed') }), /recovery journal remains/u)
})
