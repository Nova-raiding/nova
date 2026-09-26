import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { createIsolatedOpsFixture } from './isolated-ops-fixture.ts'
import { loadMigrations, MigrationRunner } from '../packages/persistence/src/migration.ts'
import { assertWorkerReadinessDependencies } from '../apps/worker/src/main.ts'

const evidenceDir = await mkdtemp(join(tmpdir(), 'merchant-bridge-smoke-'))
let fixture
let api
const stopApi = async () => {
  if (!api || api.exitCode !== null) return
  api.kill('SIGTERM')
  await new Promise(resolve => api.once('exit', resolve))
}
const runWorkerOnce = async (databaseUrl, redisUrl, base, workspaceId, expectedVersion) => {
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    NODE_ENV: 'development',
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    WORKER_ROLE: 'sync',
    WORKER_WORKSPACES: workspaceId,
    WORKER_API_BASE_URL: base,
    WORKER_ONCE: 'true',
    WORKER_READY_FILE: join(evidenceDir, `worker-${expectedVersion}.ready`),
    BRIDGE_SCHEMA_COMPATIBILITY_MODE: 'prefix_242_or_244',
  }
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/worker/src/main.ts'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk.toString('utf8') })
  child.stderr.on('data', chunk => { output += chunk.toString('utf8') })
  const status = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('worker entrypoint timed out')) }, 20_000)
    child.once('exit', code => { clearTimeout(timer); resolve(code) })
  })
  if (status !== 0) throw new Error(`worker entrypoint failed at ${expectedVersion}: ${output.slice(-1000)}`)
}
const startApi = async (databaseUrl, redisUrl) => {
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    NODE_ENV: 'development',
    PORT: '0',
    API_BIND_HOST: '127.0.0.1',
    DATABASE_URL: databaseUrl,
    OPS_DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    PERSISTENCE_MODE: 'postgres',
    CONNECTOR_FIXTURE_MODE: 'false',
    RUN_MIGRATIONS_ON_STARTUP: 'false',
    BRIDGE_SCHEMA_COMPATIBILITY_MODE: 'prefix_242_or_244',
  }
  api = spawn(process.execPath, ['--import', 'tsx', 'apps/api/src/server.ts'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`API startup timed out: ${output.slice(-1000)}`)), 30_000)
    const onData = chunk => {
      output += chunk.toString('utf8')
      const match = /merchant API listening on \{[^\n]*"port":(\d+)\}/u.exec(output)
      if (match) { clearTimeout(timeout); resolve(Number(match[1])) }
    }
    api.stdout.on('data', onData)
    api.stderr.on('data', onData)
    api.once('exit', code => { clearTimeout(timeout); reject(new Error(`API exited ${code}: ${output.slice(-1000)}`)) })
  })
  return `http://127.0.0.1:${port}`
}

try {
  fixture = await createIsolatedOpsFixture({ evidenceDir })
  const admin = new URL(fixture.acceptanceDatabaseUrls.legacyBackfill)
  const databaseUrl = admin.toString()
  const pool = new Pool({ connectionString: databaseUrl, max: 3 })
  try {
    const migrations = await loadMigrations()
    if (migrations.length !== 244) throw new Error('bridge source migration tail is not 244')
    await new MigrationRunner(pool, migrations.slice(0, 242)).run()
    for (const expectedVersion of [242, 243, 244]) {
      if (expectedVersion === 243) await new MigrationRunner(pool, migrations.slice(0, 243)).run()
      if (expectedVersion === 244) await new MigrationRunner(pool, migrations).run()
      const base = await startApi(databaseUrl, fixture.redisUrl)
      const health = await fetch(`${base}/healthz`)
      const body = await health.json()
      if (expectedVersion === 243) {
        if (health.status !== 503 || body.error?.code !== 'DATABASE_UNAVAILABLE') throw new Error(`bridge API accepted partial migration 243: status=${health.status}`)
        await assertWorkerReadinessDependencies({ database: pool, apiBaseUrl: base, apiHealthPath: '/healthz', expectedMigrations: migrations, bridgeMode: 'prefix_242_or_244', bridgeMigrations: migrations })
          .then(() => { throw new Error('bridge worker accepted partial migration 243') }, error => {
            if (!String(error?.message).includes('exactly 242 or 244')) throw error
          })
        console.log('bridge runtime negative probe passed: migration=243 api_health=503 worker_rejected=true')
        await stopApi()
        continue
      }
      if (health.status !== 200 || body.data?.persistence?.ready !== true) throw new Error(`bridge API health failed at ${expectedVersion}: status=${health.status} code=${body.error?.code}`)
      const release = await fetch(`${base}/livez`)
      if (release.status !== 200) throw new Error(`bridge API livez failed at ${expectedVersion}`)
      const merchantProducts = await fetch(`${base}/v1/products`)
      if (merchantProducts.status !== 401 && merchantProducts.status !== 403) {
        throw new Error(`bridge API merchant product authorization failed at ${expectedVersion}: status=${merchantProducts.status}`)
      }
      const worker = await assertWorkerReadinessDependencies({ database: pool, apiBaseUrl: base, apiHealthPath: '/healthz', expectedMigrations: migrations, bridgeMode: 'prefix_242_or_244', bridgeMigrations: migrations })
      if (worker.migrationVersion !== expectedVersion || !worker.apiReady) throw new Error(`bridge worker dependency failed at ${expectedVersion}`)
      await runWorkerOnce(databaseUrl, fixture.redisUrl, base, fixture.workspaceId, expectedVersion)
      console.log(`bridge runtime smoke passed: migration=${expectedVersion} api_health=200 worker_api_ready=true`)
      await stopApi()
    }
    const tail = await pool.query('SELECT max(version)::int AS version FROM schema_migrations')
    if (tail.rows[0]?.version !== 244) throw new Error('bridge fixture did not finish at migration 244')
    const evidence = JSON.parse(await readFile(join(evidenceDir, `fixture-ready-${fixture.runId}.json`), 'utf8'))
    if (evidence.runId !== fixture.runId || evidence.fixtureOnly !== true) throw new Error('bridge fixture identity mismatch')
  } finally { await pool.end() }
} finally {
  await stopApi()
  if (fixture) {
    const disposal = await fixture.dispose()
    if (disposal.leftRunning.length !== 0) throw new Error('isolated bridge fixture container cleanup requires manual inspection')
  }
}
