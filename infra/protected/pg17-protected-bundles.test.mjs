import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { assertLocalDockerTarget, backupAttemptDirectoryName, inspectProductionPostgres, validateProductionPostgresInspection } from './attest-pg17-backup-baseline.mjs'

const entries = [
  ['attest-pg17-frozen-plan', 'PG17 frozen plan rejected'],
  ['attest-pg17-backup-baseline', 'PG17 baseline backup rejected'],
]
const banner = 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'

test('backup attempt path meets the installed isolated restore runner contract', () => {
  assert.equal(backupAttemptDirectoryName('release-39fc097d-review', '20260927t1200z'), 'release-39fc097d-review-attempt-20260927t1200z')
  assert.throws(() => backupAttemptDirectoryName('release-39fc097d-review', '../escape'), /identity invalid/u)
})

function productionPostgresInspection() {
  return {
    Id: 'a'.repeat(64), Name: '/merchant-production-postgres-1', State: { Running: true },
    Config: {
      Image: 'postgres:16-alpine',
      Labels: { 'com.docker.compose.project': 'merchant-production', 'com.docker.compose.service': 'postgres' },
      Env: ['POSTGRES_DB=merchant', 'POSTGRES_USER=merchant', 'POSTGRES_PASSWORD=secret'],
    },
    NetworkSettings: { Networks: { 'merchant-production_default': { IPAddress: '172.20.0.4' } } },
  }
}

test('PG17 baseline Docker target rejects ambient remote contexts and hosts', () => {
  assertLocalDockerTarget({})
  assertLocalDockerTarget({ DOCKER_HOST: 'unix:///var/run/docker.sock' })
  assert.throws(() => assertLocalDockerTarget({ DOCKER_CONTEXT: 'production' }), /Docker target is forbidden/u)
  assert.throws(() => assertLocalDockerTarget({ DOCKER_HOST: 'tcp://docker.example:2376' }), /Docker target is forbidden/u)
  assert.throws(() => assertLocalDockerTarget({ DOCKER_CONFIG: '/tmp/attacker-config' }), /Docker target is forbidden/u)
})

test('PG17 baseline Docker inspection pins the local socket and rejects wrong production container identity', () => {
  const inspection = productionPostgresInspection()
  let invocation
  const source = inspectProductionPostgres({
    environment: {},
    run: (...args) => { invocation = args; return JSON.stringify([inspection]) },
  })
  assert.equal(source.networkHost, '172.20.0.4')
  assert.equal(invocation[0], '/usr/bin/docker')
  assert.deepEqual(invocation[1], ['--host', 'unix:///var/run/docker.sock', 'inspect', 'merchant-production-postgres-1'])
  assert.deepEqual(invocation[2].env, { PATH: '/usr/bin:/bin', HOME: '/nonexistent', DOCKER_HOST: 'unix:///var/run/docker.sock' })

  for (const mutate of [
    value => { value.Name = '/attacker-postgres-1' },
    value => { value.Config.Labels['com.docker.compose.project'] = 'candidate' },
    value => { value.Config.Labels['com.docker.compose.service'] = 'postgres-copy' },
  ]) {
    const incorrect = structuredClone(inspection)
    mutate(incorrect)
    assert.throws(() => validateProductionPostgresInspection(incorrect), /identity mismatch/u)
  }
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
