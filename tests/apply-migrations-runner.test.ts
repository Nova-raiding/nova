import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'

const fakePsql = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const stateFile = process.env.FAKE_PSQL_STATE
const lockFile = stateFile + '.lock'
const readState = () => fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { events: [], failUsed: false }
const writeState = state => fs.writeFileSync(stateFile, JSON.stringify(state))
const state = readState()
const sql = fs.readFileSync(0, 'utf8')
const args = process.argv.slice(2)
const event = value => { state.events.push(value); writeState(state) }
if (args.includes('-c')) process.exit(0)
let locked = false
if (sql.includes('pg_advisory_lock') || sql.includes('pg_advisory_xact_lock')) {
  try { fs.mkdirSync(lockFile); locked = true; event('lock-acquired') }
  catch { event('lock-contended'); process.stderr.write('advisory lock is already held\\n'); process.exit(1) }
  const release = reason => { if (locked && fs.existsSync(lockFile)) fs.rmdirSync(lockFile); event(reason) }
  if (process.env.FAKE_PSQL_MODE === 'unknown' && sql.includes('migration_version_unknown')) {
    process.stdout.write('MIGRATION_VERSION_UNKNOWN: database contains a version outside this release\\n')
    release('lock-released-after-unknown')
    process.exit(1)
  }
  if (process.env.FAKE_PSQL_MODE === 'checksum' && sql.includes('migration_checksum_mismatch')) {
    process.stdout.write('MIGRATION_CHECKSUM_MISMATCH version 1\\n')
    release('lock-released-after-checksum')
    process.exit(1)
  }
  if (process.env.FAKE_PSQL_FAIL_AFTER_LOCK === '1' && !state.failUsed) {
    state.failUsed = true
    writeState(state)
    release('lock-released-after-failure')
    process.stderr.write('advisory lock execution failure\\n')
    process.exit(1)
  }
  const holdMs = Number(process.env.FAKE_PSQL_HOLD_MS || 0)
  if (holdMs > 0) { const until = Date.now() + holdMs; while (Date.now() < until) {} }
  const included = sql.match(/\\\\i '([^']+)'/)
  if (included) event('applied:' + path.basename(included[1]))
  release('lock-released')
}
process.exit(0)
`

type Fixture = { root: string; runner: string; migrations: string; state: string; bin: string }

function fixture(files: Array<[string, string]>): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'apply-migrations-runner-'))
  const migrations = join(root, 'migrations')
  const bin = join(root, 'bin')
  mkdirSync(migrations)
  mkdirSync(bin)
  for (const [name, sql] of files) writeFileSync(join(migrations, name), sql)
  const source = readFileSync('infra/scripts/apply-migrations.sh', 'utf8')
  const runner = join(root, 'runner.sh')
  writeFileSync(runner, source.replaceAll('/migrations/', `${migrations}/`))
  chmodSync(runner, 0o755)
  const psql = join(bin, 'psql')
  writeFileSync(psql, fakePsql)
  chmodSync(psql, 0o755)
  const state = join(root, 'psql-state.json')
  writeFileSync(state, JSON.stringify({ events: [], failUsed: false }))
  return { root, runner, migrations, state, bin }
}

function environment(testFixture: Fixture, extra: Record<string, string> = {}) {
  return {
    ...process.env,
    PGDATABASE: 'merchant',
    PGUSER: 'merchant_app',
    PGPASSWORD: 'test-password',
    PATH: `${testFixture.bin}:${process.env.PATH ?? ''}`,
    FAKE_PSQL_STATE: testFixture.state,
    ...extra,
  }
}

function run(testFixture: Fixture, extra: Record<string, string> = {}) {
  return spawnSync('sh', [testFixture.runner], { encoding: 'utf8', env: environment(testFixture, extra), stdio: 'pipe' })
}

function stateOf(testFixture: Fixture): { events: string[]; failUsed: boolean } {
  return JSON.parse(readFileSync(testFixture.state, 'utf8')) as { events: string[]; failUsed: boolean }
}

function dispose(testFixture: Fixture) {
  rmSync(testFixture.root, { recursive: true, force: true })
}

function runAsync(testFixture: Fixture, extra: Record<string, string> = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('sh', [testFixture.runner], { env: environment(testFixture, extra), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', status => resolve({ status, stdout, stderr }))
  })
}

describe('apply-migrations.sh shell runner', () => {
  it('rejects a non-contiguous artifact chain before connecting to PostgreSQL', () => {
    const testFixture = fixture([['001_initial.sql', 'select 1;'], ['003_third.sql', 'select 3;']])
    try {
      const result = run(testFixture)
      expect(result.status).not.toBe(0)
      expect(`${result.stdout}${result.stderr}`).toContain('MIGRATION_ARTIFACT_CHAIN_GAP')
      expect(stateOf(testFixture).events).toEqual([])
    } finally { dispose(testFixture) }
  })

  it('fails closed for a database version outside the release chain', () => {
    const testFixture = fixture([['001_initial.sql', 'select 1;']])
    try {
      const result = run(testFixture, { FAKE_PSQL_MODE: 'unknown' })
      expect(result.status).not.toBe(0)
      expect(`${result.stdout}${result.stderr}`).toContain('MIGRATION_VERSION_UNKNOWN')
      expect(stateOf(testFixture).events).toContain('lock-released-after-unknown')
      expect(existsSync(`${testFixture.state}.lock`)).toBe(false)
    } finally { dispose(testFixture) }
  })

  it('rejects checksum drift and releases the session advisory lock', () => {
    const testFixture = fixture([['001_initial.sql', 'select 1;']])
    try {
      const result = run(testFixture, { FAKE_PSQL_MODE: 'checksum' })
      expect(result.status).not.toBe(0)
      expect(`${result.stdout}${result.stderr}`).toContain('MIGRATION_CHECKSUM_MISMATCH')
      expect(stateOf(testFixture).events).toContain('lock-released-after-checksum')
      expect(existsSync(`${testFixture.state}.lock`)).toBe(false)
    } finally { dispose(testFixture) }
  })

  it('releases an advisory lock after a failed invocation so the next run can proceed', () => {
    const testFixture = fixture([['001_initial.sql', 'select 1;']])
    try {
      const failed = run(testFixture, { FAKE_PSQL_FAIL_AFTER_LOCK: '1' })
      expect(failed.status).not.toBe(0)
      expect(stateOf(testFixture).events).toContain('lock-released-after-failure')
      expect(existsSync(`${testFixture.state}.lock`)).toBe(false)
      const retry = run(testFixture)
      expect(retry.status).toBe(0)
      expect(retry.stdout).toContain('migrations complete')
      expect(stateOf(testFixture).events).toContain('applied:001_initial.sql')
    } finally { dispose(testFixture) }
  })

  it('serializes concurrent runners and leaves no lock after contention', async () => {
    const testFixture = fixture([['001_initial.sql', 'select 1;']])
    try {
      const first = runAsync(testFixture, { FAKE_PSQL_HOLD_MS: '250' })
      await new Promise(resolve => setTimeout(resolve, 30))
      const second = await runAsync(testFixture)
      const firstResult = await first
      expect([firstResult.status, second.status].sort()).toEqual([0, 1])
      expect(`${second.stdout}${second.stderr}`).toContain('already held')
      expect(existsSync(`${testFixture.state}.lock`)).toBe(false)
    } finally { dispose(testFixture) }
  }, 10_000)
})
