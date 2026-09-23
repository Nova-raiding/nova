import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createIsolatedOpsFixture } from './isolated-ops-fixture.ts'
import { loadMigrations, MigrationRunner } from '../packages/persistence/src/migration.ts'
import { assertWorkerReadinessDependencies } from '../apps/worker/src/main.ts'

const fixture = await createIsolatedOpsFixture({ evidenceDir: await mkdtemp(join(tmpdir(), 'reverse-bridge-')) })
const admin = new Pool({ connectionString: fixture.acceptanceDatabaseUrls.legacyBackfill })
let server
let persistence
const execFileAsync = promisify(execFile)
try {
  const migrations = await loadMigrations()
  await new MigrationRunner(admin, migrations.slice(0, 242)).run()
  Object.assign(process.env, {
    NODE_ENV: 'development', CONNECTOR_FIXTURE_MODE: 'false', PERSISTENCE_MODE: 'postgres',
    DATABASE_URL: fixture.acceptanceDatabaseUrls.legacyBackfill,
    OPS_DATABASE_URL: fixture.opsDatabaseUrl, REDIS_URL: fixture.redisUrl,
    RUN_MIGRATIONS_ON_STARTUP: 'false', BRIDGE_SCHEMA_COMPATIBILITY_MODE: 'prefix_242_or_244',
    PORT: '0', API_BIND_HOST: '127.0.0.1',
  })
  const api = await import('../apps/api/src/server.ts')
  server = api.server
  persistence = await api.persistenceReady
  if (!server.listening) await new Promise((resolve, reject) => { server.once('error', reject); server.once('listening', resolve) })
  const base = `http://127.0.0.1:${server.address().port}`
  const runWorkerRole = async (version, role, ready) => {
    const workerEnv = {
      PATH: process.env.PATH, NODE_ENV: 'development', DATABASE_URL: fixture.acceptanceDatabaseUrls.legacyBackfill,
      REDIS_URL: fixture.redisUrl, BRIDGE_SCHEMA_COMPATIBILITY_MODE: 'prefix_242_or_244',
      WORKER_ROLE: role, WORKER_WORKSPACES: 'auto', WORKER_ONCE: 'true',
      WORKER_API_BASE_URL: base, WORKER_API_TOKEN: 'isolated-unused', WORKER_API_SIGNING_SECRET: 'isolated-unused',
      WORKER_METRICS_PORT: '0', WORKER_READY_FILE: join(await mkdtemp(join(tmpdir(), `reverse-worker-${role}-`)), 'ready.json'),
      CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: '9', CLAMAV_TIMEOUT_MS: '1000',
    }
    try {
      const result = await execFileAsync(process.execPath, ['--import', 'tsx', 'apps/worker/src/main.ts'], { env: workerEnv, timeout: 30_000, maxBuffer: 1024 * 1024 })
      const pollCompleted = result.stdout.includes('"message":"worker poll completed"')
      process.stdout.write(JSON.stringify({ version, role, exit: 0, pollCompleted }) + '\n')
      assert.equal(ready, true, `${role} must reject DB ${version}`)
      assert.equal(pollCompleted, true, `${role} exited without completing a poll on DB ${version}`)
    } catch (error) {
      const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}`
      process.stdout.write(JSON.stringify({ version, role, exit: error.code ?? 'timeout', schemaRejected: output.includes('bridge database migration prefix must be exactly 242 or 244'), scannerDependency: output.includes('clamav') }) + '\n')
      if (ready) throw new Error(`worker ${role} failed on DB ${version}`)
      assert.match(output, /bridge database migration prefix must be exactly 242 or 244/u)
    }
  }
  const probe = async (version, ready) => {
    const response = await fetch(`${base}/healthz`)
    const body = await response.json()
    process.stdout.write(JSON.stringify({ version, status: response.status, error: body.error?.code ?? null }) + '\n')
    assert.equal(response.status, ready ? 200 : 503)
    const worker = assertWorkerReadinessDependencies({ database: admin, bridgeMode: 'prefix_242_or_244', bridgeMigrations: migrations, apiBaseUrl: base, apiHealthPath: '/healthz' })
    if (ready) assert.equal((await worker).migrationVersion, version)
    else await assert.rejects(worker, /exactly 242 or 244/u)
    for (const role of ['sync', 'generation', 'publish', 'reconcile', 'automation', 'scan']) await runWorkerRole(version, role, ready)
  }
  await probe(242, true)
  const blocked = await fetch(`${base}/v1/auth/local-plugin/connect-requests`, { method: 'POST' })
  assert.equal(blocked.status, 503)
  assert.equal((await blocked.json()).error.code, 'LOCAL_PLUGIN_BRIDGE_UNAVAILABLE')
  await new MigrationRunner(admin, [migrations[242]]).run()
  await probe(243, false)
  await new MigrationRunner(admin, [migrations[243]]).run()
  await probe(244, true)
  process.stdout.write('PASS: cloud-v2 API+worker prefix bridge on isolated PG17 242/243/244\n')
} catch (error) {
  process.stderr.write(`SMOKE_FAIL: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  await persistence?.close?.()
  await admin.end()
  const disposal = await fixture.dispose()
  process.stdout.write(JSON.stringify({ fixture_cleanup: disposal }) + '\n')
}
// The API module owns long-lived Redis clients. The fixture and database have
// been explicitly closed above; end this dedicated smoke process now.
process.exit(process.exitCode ?? 0)
