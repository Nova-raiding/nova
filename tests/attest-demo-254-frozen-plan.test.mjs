import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { buildSync } from 'esbuild'
import { candidateDemo254Migrations } from '../infra/protected/attest-demo-254-frozen-plan.mjs'
import { CONTROLS, prepareControlBytes } from '../infra/scripts/install-ecs-release-controls.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const names = Array.from({ length: 254 }, (_, i) => `${String(i + 1).padStart(3, '0')}_migration_${i + 1}.sql`)

test('candidate plan binds contiguous 1..254 SQL names and byte checksums', () => {
  const rows = candidateDemo254Migrations('/protected/migrations', path => Buffer.from(`SQL ${path}`), () => names)
  assert.equal(rows.length, 254)
  assert.deepEqual(rows[0], { version: 1, name: 'migration_1', checksum: sha('SQL /protected/migrations/001_migration_1.sql') })
  assert.equal(rows[253].version, 254)
  assert.equal(candidateDemo254Migrations('/protected/migrations', path => Buffer.from(`SQL ${path}`),
    () => [...names, '255_future.sql']).length, 254)
  assert.throws(() => candidateDemo254Migrations('/protected/migrations', () => Buffer.from('SQL'), () => names.slice(0, 242)), /CANDIDATE_MIGRATION_COUNT_INVALID/u)
  const bad = [...names]; bad[253] = '255_wrong.sql'
  assert.throws(() => candidateDemo254Migrations('/protected/migrations', () => Buffer.from('SQL'), () => bad), /CANDIDATE_MIGRATION_NAME_INVALID/u)
})

test('plan signer builds as fixed-install standalone reviewed control', () => {
  const bundled = Buffer.from(buildSync({ entryPoints: ['infra/protected/attest-demo-254-frozen-plan.mjs'], bundle: true,
    platform: 'node', format: 'esm', target: 'node22', write: false }).outputFiles[0].contents)
  const installed = prepareControlBytes('demo254Plan', bundled, sha(bundled),
    '/usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node')
  assert.equal(CONTROLS.demo254Plan.executable, 'attest-demo-254-frozen-plan')
  assert.match(installed.toString(), /^#!\/usr\/local\/libexec\/merchant\/runtime\/node-v22\.23\.2-linux-x64\/bin\/node\n/u)
})
