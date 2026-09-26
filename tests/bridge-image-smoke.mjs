// Isolated image-level bridge smoke. This is not a production release gate:
// it uses generated PG/Redis credentials and a private Docker network.
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { createIsolatedOpsFixture } from './isolated-ops-fixture.ts'
import { loadMigrations, MigrationRunner } from '../packages/persistence/src/migration.ts'

const run = promisify(execFile)
const imageApi = process.env.BRIDGE_API_IMAGE
const imageWorker = process.env.BRIDGE_WORKER_IMAGE
if (!/^.+@sha256:[0-9a-f]{64}$/.test(imageApi ?? '') || !/^.+@sha256:[0-9a-f]{64}$/.test(imageWorker ?? '')) {
  throw new Error('exact bridge image digest references are required')
}
const marker = randomUUID()
const network = `merchant-bridge-image-${marker}`
const apiName = `merchant-bridge-api-${marker}`
const evidenceDir = await mkdtemp(join(tmpdir(), 'merchant-bridge-image-'))
let fixture
let networkCreated = false
let apiId
const workerIds = []
const docker = async (...args) => (await run('docker', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 })).stdout.trim()
const containerUrl = (value, host, port) => { const url = new URL(value); url.hostname = host; url.port = String(port); return url.toString() }

try {
  fixture = await createIsolatedOpsFixture({ evidenceDir })
  const databaseUrl = fixture.acceptanceDatabaseUrls.legacyBackfill
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  try {
    const migrations = await loadMigrations()
    if (migrations.length !== 244) throw new Error('B image source does not carry migration tail 244')
    await new MigrationRunner(pool, migrations.slice(0, 242)).run()
    const tail = await pool.query('SELECT max(version)::int AS version FROM schema_migrations')
    if (tail.rows[0]?.version !== 242) throw new Error('isolated PG17 did not reach exact schema 242')
  } finally { await pool.end() }

  await docker('network', 'create', network)
  networkCreated = true
  const pg = fixture.containerEvidence.find(value => value.kind === 'postgres')
  const redis = fixture.containerEvidence.find(value => value.kind === 'redis')
  await docker('network', 'connect', '--alias', 'bridge-pg', network, pg.id)
  await docker('network', 'connect', '--alias', 'bridge-redis', network, redis.id)
  const internalDb = containerUrl(databaseUrl, 'bridge-pg', 5432)
  const internalRedis = containerUrl(fixture.redisUrl, 'bridge-redis', 6379)
  apiId = await docker('run', '-d', '--pull=never', '--name', apiName, '--network', network,
    '--network-alias', 'bridge-api', '--label', `merchant.bridge-smoke=${marker}`,
    '-e', 'NODE_ENV=development', '-e', 'PORT=8787', '-e', 'API_BIND_HOST=0.0.0.0',
    '-e', `DATABASE_URL=${internalDb}`, '-e', `OPS_DATABASE_URL=${internalDb}`, '-e', `REDIS_URL=${internalRedis}`,
    '-e', 'PERSISTENCE_MODE=postgres', '-e', 'CONNECTOR_FIXTURE_MODE=false',
    '-e', 'RUN_MIGRATIONS_ON_STARTUP=false', '-e', 'BRIDGE_SCHEMA_COMPATIBILITY_MODE=prefix_242_or_244', imageApi)
  if (!/^[0-9a-f]{64}$/.test(apiId)) throw new Error('API container ID is invalid')
  let healthy = false
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const body = JSON.parse(await docker('exec', apiId, 'wget', '-qO-', 'http://127.0.0.1:8787/healthz'))
      if (body.data?.persistence?.ready === true) { healthy = true; break }
    } catch { /* bounded readiness retry */ }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  if (!healthy) throw new Error('fixed B API image did not become healthy against PG17 schema 242')
  const products = await docker('exec', apiId, 'sh', '-c', 'wget -qO /dev/null -S http://127.0.0.1:8787/v1/products 2>&1 || true')
  if (!/HTTP\/1\.1 (401|403)/.test(products)) throw new Error('B API product route did not enforce authentication')
  await docker('run', '--rm', '--pull=never', '--network', network, '--label', `merchant.bridge-smoke=${marker}`,
    '-e', 'NODE_ENV=development', '-e', `DATABASE_URL=${internalDb}`, '-e', `REDIS_URL=${internalRedis}`,
    '-e', 'WORKER_ROLE=sync', '-e', `WORKER_WORKSPACES=${fixture.workspaceId}`,
    '-e', 'WORKER_API_BASE_URL=http://bridge-api:8787', '-e', 'WORKER_ONCE=true',
    '-e', 'BRIDGE_SCHEMA_COMPATIBILITY_MODE=prefix_242_or_244', imageWorker)
  for (const role of ['sync', 'generation', 'publish', 'reconcile', 'automation', 'scan']) {
    const id = await docker('run', '-d', '--pull=never', '--name', `merchant-bridge-worker-${role}-${marker}`, '--network', network,
      '--label', `merchant.bridge-smoke=${marker}`, '-e', 'NODE_ENV=development', '-e', `DATABASE_URL=${internalDb}`,
      '-e', `REDIS_URL=${internalRedis}`, '-e', `WORKER_ROLE=${role}`, '-e', `WORKER_WORKSPACES=${fixture.workspaceId}`,
      '-e', 'WORKER_API_BASE_URL=http://bridge-api:8787', '-e', 'BRIDGE_SCHEMA_COMPATIBILITY_MODE=prefix_242_or_244', imageWorker)
    if (!/^[0-9a-f]{64}$/.test(id)) throw new Error(`fixed B ${role} worker ID is invalid`)
    workerIds.push(id)
  }
  await new Promise(resolve => setTimeout(resolve, 2500))
  for (const [index, id] of workerIds.entries()) {
    const running = await docker('inspect', '--format', '{{.State.Running}}', id)
    if (running !== 'true') throw new Error(`fixed B ${['sync', 'generation', 'publish', 'reconcile', 'automation', 'scan'][index]} worker exited on PG17 schema 242`)
  }
  console.log(`PASS: exact B API plus six persistent worker containers healthy on isolated PG17 schema 242; api=${imageApi} worker=${imageWorker}`)
} finally {
  for (const id of workerIds) {
    try { await docker('rm', '-f', id) } catch { console.error(`worker fixture cleanup requires inspection: ${id}`) }
  }
  if (apiId) {
    try { await docker('rm', '-f', apiId) } catch { console.error(`API fixture cleanup requires inspection: ${apiId}`) }
  }
  if (networkCreated) {
    for (const item of fixture?.containerEvidence ?? []) {
      try { await docker('network', 'disconnect', network, item.id) } catch { /* fixture disposal may already stop it */ }
    }
    try { await docker('network', 'rm', network) } catch { console.error(`network cleanup requires inspection: ${network}`) }
  }
  if (fixture) {
    const disposal = await fixture.dispose()
    if (disposal.leftRunning.length > 0) throw new Error('isolated PG/Redis fixture cleanup requires inspection')
  }
}
