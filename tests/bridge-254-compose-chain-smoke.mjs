// Review-only runtime proof: B-derived API and six workers across every
// isolated PG17 migration prefix from 242 through 254. No host ports or volumes.
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { Pool } from 'pg'
import { createIsolatedOpsFixture } from './isolated-ops-fixture.ts'
import { createBridgeDockerClient } from './bridge-docker-target.mjs'
import { loadMigrations, MigrationRunner } from '../packages/persistence/src/migration.ts'

const run = promisify(execFile)
const [overlay, apiReference, workerReference, output] = process.argv.slice(2)
if (process.argv.length !== 6 || !overlay || !apiReference || !workerReference || !output) throw new Error('usage: node --import tsx tests/bridge-254-compose-chain-smoke.mjs <absolute overlay> <API image> <worker image> <new absolute output.json>')
if (![overlay, output].every(path => isAbsolute(path) && resolve(path) === path) || lstatSync(overlay).isSymbolicLink() || existsSync(output)) throw new Error('overlay/output paths must be canonical, and output must be new')
const manifest = JSON.parse(readFileSync(join(overlay, 'overlay-manifest.json'), 'utf8'))
if (manifest.schema_version !== 'ecs-bridge-254-compatibility-overlay/1' || manifest.status !== 'review_only' || manifest.deployable !== false || manifest.runtime_verified !== false || !/^sha256:[a-f0-9]{64}$/u.test(manifest.overlay_tree_sha256 ?? '')) throw new Error('overlay must be review-only')
const sha = value => createHash('sha256').update(value).digest('hex')
function inventory(directory, prefix = '') {
  const found = []
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name), relative = prefix ? `${prefix}/${name}` : name, stat = lstatSync(path)
    if (stat.isDirectory()) found.push(...inventory(path, relative))
    else if (stat.isFile()) found.push([relative, sha(readFileSync(path))])
    else throw new Error('overlay contains a link or special file')
  }
  return found
}
const source = join(overlay, 'overlay-source')
if (`sha256:${sha(inventory(source).map(([path, digest]) => `${path}\t${digest}\n`).join(''))}` !== manifest.overlay_tree_sha256) throw new Error('overlay tree digest mismatch')
let dockerClient
const docker = async (...args) => {
  if (!dockerClient) throw new Error('isolated local Docker client was not initialized')
  try { return (await run('docker', [...dockerClient.args, ...args], { encoding: 'utf8', timeout: 90_000, maxBuffer: 2 * 1024 * 1024, env: dockerClient.environment })).stdout.trim() }
  catch { throw new Error(`local review Docker command failed: ${args[0] ?? 'command'}`) }
}
async function imageId(reference) {
  const body = JSON.parse(await docker('image', 'inspect', reference, '--format', '{{json .}}'))
  if (!/^sha256:[a-f0-9]{64}$/u.test(body.Id ?? '') || body.Config?.Labels?.['com.storenova.bridge-review.tree-sha256'] !== manifest.overlay_tree_sha256) throw new Error('image is not bound to the B-derived overlay')
  return body.Id
}
let apiImage, workerImage
const marker = randomUUID(), project = `bridge254${marker.replaceAll('-', '')}`
const network = `merchant-bridge-254-compose-${marker}`
const evidenceDir = await mkdtemp(join(tmpdir(), 'bridge-254-compose-chain-'))
const composeFile = join(evidenceDir, 'compose.json')
const roles = ['sync', 'generation', 'publish', 'reconcile', 'automation', 'scan']
let fixture, pool, networkCreated = false, composeCreated = false
const inNetwork = (value, host, port) => { const url = new URL(value); url.hostname = host; url.port = String(port); return url.toString() }
const compose = async (...args) => {
  if (!dockerClient) throw new Error('isolated local Docker client was not initialized')
  try {
    return (await run('docker-compose', ['-p', project, '-f', composeFile, ...args], {
      encoding: 'utf8', timeout: 90_000, maxBuffer: 2 * 1024 * 1024,
      env: { ...dockerClient.environment, DOCKER_HOST: `unix://${dockerClient.socket}`, DOCKER_CONFIG: dockerClient.configPath },
    })).stdout.trim()
  } catch { throw new Error(`local review Compose command failed: ${args[0] ?? 'command'}`) }
}
async function serviceContainer(service) {
  const id = await compose('ps', '-a', '-q', service)
  if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error(`missing owned Compose service ${service}`)
  const body = JSON.parse(await docker('inspect', '--format', '{{json .}}', id))
  if (body.Id !== id || body.Config?.Labels?.['com.docker.compose.project'] !== project || body.Config?.Labels?.['com.docker.compose.service'] !== service || body.Config?.Labels?.['merchant.bridge-254-review'] !== marker) throw new Error(`Compose service identity mismatch: ${service}`)
  return body
}
async function apiProbe() {
  const api = await serviceContainer('api')
  if (!api.State?.Running) return { ready: false, state: api.State?.Status ?? 'unknown' }
  try {
    const response = JSON.parse(await docker('exec', api.Id, 'wget', '-qO-', 'http://127.0.0.1:8787/healthz'))
    return { ready: response.data?.persistence?.ready === true, state: api.State.Status }
  } catch { return { ready: false, state: api.State.Status } }
}
async function waitForApiReady() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if ((await apiProbe()).ready) return
    await new Promise(resolveWait => setTimeout(resolveWait, 500))
  }
  throw new Error('B-derived API did not become ready at valid prefix')
}
try {
  dockerClient = await createBridgeDockerClient()
  const imageIds = await Promise.all([imageId(apiReference), imageId(workerReference)])
  apiImage = imageIds[0]
  workerImage = imageIds[1]
  fixture = await createIsolatedOpsFixture({ evidenceDir })
  pool = new Pool({ connectionString: fixture.acceptanceDatabaseUrls.legacyBackfill, max: 2 })
  const migrations = await loadMigrations()
  if (migrations.length !== 254) throw new Error('source must contain migrations 1..254')
  for (const migration of migrations) {
    const name = `${String(migration.version).padStart(3, '0')}_${migration.name}.sql`
    if (readFileSync(join(source, 'packages/persistence/src/migrations', name), 'utf8') !== migration.sql) throw new Error(`review image migration differs from source: ${name}`)
  }
  const pg = fixture.containerEvidence.find(value => value.kind === 'postgres')
  const redis = fixture.containerEvidence.find(value => value.kind === 'redis')
  if (!pg || !redis) throw new Error('fixture PG17/Redis missing')
  await docker('network', 'create', '--internal', network)
  networkCreated = true
  const networkInfo = JSON.parse(await docker('network', 'inspect', '--format', '{{json .}}', network))
  if (networkInfo.Name !== network || networkInfo.Internal !== true) throw new Error('review bridge network is not internal')
  await docker('network', 'connect', '--alias', 'bridge-pg', network, pg.id)
  await docker('network', 'connect', '--alias', 'bridge-redis', network, redis.id)
  const databaseUrl = inNetwork(fixture.acceptanceDatabaseUrls.legacyBackfill, 'bridge-pg', 5432)
  const redisUrl = inNetwork(fixture.redisUrl, 'bridge-redis', 6379)
  const common = { NODE_ENV: 'development', DATABASE_URL: databaseUrl, REDIS_URL: redisUrl, BRIDGE_SCHEMA_COMPATIBILITY_MODE: 'prefix_242_or_254', RUN_MIGRATIONS_ON_STARTUP: 'false' }
  const services = {
    api: { image: apiImage, environment: { ...common, OPS_DATABASE_URL: databaseUrl, PORT: '8787', API_BIND_HOST: '0.0.0.0', PERSISTENCE_MODE: 'postgres', CONNECTOR_FIXTURE_MODE: 'false' }, labels: { 'merchant.bridge-254-review': marker }, networks: [network] },
  }
  for (const role of roles) services[`worker-${role}`] = { image: workerImage, environment: { ...common, WORKER_ROLE: role, WORKER_WORKSPACES: fixture.workspaceId, WORKER_API_BASE_URL: 'http://api:8787' }, labels: { 'merchant.bridge-254-review': marker }, networks: [network] }
  writeFileSync(composeFile, JSON.stringify({ services, networks: { [network]: { external: true } } }), { mode: 0o600, flag: 'wx' })
  const observations = []
  let backupRestore = null
  for (let prefix = 242; prefix <= 254; prefix += 1) {
    await new MigrationRunner(pool, migrations.slice(0, prefix)).run()
    const rows = (await pool.query('SELECT version, name, checksum FROM schema_migrations ORDER BY version')).rows
    if (rows.length !== prefix || rows.some((row, index) => row.version !== index + 1 || typeof row.checksum !== 'string')) throw new Error(`migration history incomplete at ${prefix}`)
    await pool.query('INSERT INTO workspaces (id,status) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING', [fixture.workspaceId, 'active'])
    composeCreated = true
    await compose('up', '-d', '--no-deps', '--pull', 'never')
    let api, workers
    if (prefix === 242 || prefix === 254) {
      await waitForApiReady()
      api = await apiProbe()
      workers = []
      for (const role of roles) {
        const container = await serviceContainer(`worker-${role}`)
        if (container.Image !== workerImage || !container.State?.Running) throw new Error(`worker ${role} failed at valid prefix ${prefix}`)
        workers.push({ role, running: true })
      }
    } else {
      // The API remains live but health/readiness fails closed on the schema
      // check. Workers stay running but withhold their ready markers.
      for (let attempt = 0; attempt < 30; attempt += 1) {
        api = await apiProbe()
        if (api.state === 'running') break
        await new Promise(resolveWait => setTimeout(resolveWait, 500))
      }
      if (api?.ready || api?.state !== 'running') throw new Error(`API state invalid at intermediate prefix ${prefix}: ${JSON.stringify(api)}`)
      const apiContainer = await serviceContainer('api')
      let response = ''
      for (let attempt = 0; attempt < 30; attempt += 1) {
        response = await docker('exec', apiContainer.Id, 'sh', '-c', 'wget -qO- -S http://127.0.0.1:8787/healthz 2>&1 || true')
        if (/HTTP\/1\.1 [0-9]{3}/u.test(response)) break
        await new Promise(resolveWait => setTimeout(resolveWait, 500))
      }
      if (!/HTTP\/1\.1 503/u.test(response)) throw new Error(`API health did not fail closed at ${prefix}: ${response.slice(0, 200)}`)
      await new Promise(resolveWait => setTimeout(resolveWait, 2_500))
      workers = []
      for (const role of roles) {
        const container = await serviceContainer(`worker-${role}`)
        if (container.Image !== workerImage) throw new Error(`worker ${role} image changed at ${prefix}`)
        const ready = container.State?.Running && (await docker('exec', container.Id, 'sh', '-c', 'test -e /tmp/merchant-worker-ready && echo READY || echo BLOCKED')) === 'READY'
        if (ready) throw new Error(`worker ${role} admitted intermediate prefix ${prefix}`)
        const logs = await compose('logs', '--no-color', `worker-${role}`)
        if (!logs.includes('242-to-254 bridge database prefix must be exactly 242 or 254')) throw new Error(`worker ${role} lacked schema rejection at ${prefix}: ${logs.slice(-500)}`)
        workers.push({ role, ready: false })
      }
    }
    observations.push({ prefix, history_sha256: `sha256:${sha(rows.map(row => `${row.version}\t${row.name}\t${row.checksum}\n`).join(''))}`, api, workers })
    process.stdout.write(`review prefix ${prefix}: ${api.ready ? 'ready' : 'blocked'}\n`)
    await compose('down', '--remove-orphans', '--timeout', '10')
    composeCreated = false
    if (prefix === 242) {
      // After all owned runtime containers are stopped, prove this exact
      // synthetic 242 snapshot can be restored to a second isolated PG17 DB.
      const archive = join(evidenceDir, 'prefix-242.dump')
      const sourceUrl = fixture.acceptanceDatabaseUrls.legacyBackfill
      const targetUrl = fixture.acceptanceDatabaseUrls.workspaceCatalog
      const pgBin = ['/opt/homebrew/opt/postgresql@17/bin', '/usr/local/opt/postgresql@17/bin', '/usr/lib/postgresql/17/bin'].find(path => existsSync(join(path, 'pg_dump')) && existsSync(join(path, 'pg_restore')))
      if (!pgBin) throw new Error('isolated backup requires explicit PostgreSQL 17 client binaries')
      const version = (await run(join(pgBin, 'pg_dump'), ['--version'], { encoding: 'utf8' })).stdout
      if (!/PostgreSQL\) 17\./u.test(version)) throw new Error('isolated backup requires pg_dump 17')
      await run(join(pgBin, 'pg_dump'), ['--format=custom', '--file', archive, sourceUrl], { timeout: 120_000, maxBuffer: 1024 * 1024 })
      if (!statSync(archive).isFile() || statSync(archive).size <= 0) throw new Error('isolated 242 archive is empty')
      await run(join(pgBin, 'pg_restore'), ['--exit-on-error', '--no-owner', '--no-privileges', '--dbname', targetUrl, archive], { timeout: 120_000, maxBuffer: 1024 * 1024 })
      const restored = new Pool({ connectionString: targetUrl, max: 1 })
      try {
        const restoredRows = (await restored.query('SELECT version, name, checksum FROM schema_migrations ORDER BY version')).rows
        const restoredHistory = `sha256:${sha(restoredRows.map(row => `${row.version}\t${row.name}\t${row.checksum}\n`).join(''))}`
        if (restoredRows.length !== 242 || restoredHistory !== observations[0].history_sha256) throw new Error('isolated 242 restore history differs from backup source')
        backupRestore = { archive_sha256: `sha256:${sha(readFileSync(archive))}`, archive_bytes: statSync(archive).size, restored_history_sha256: restoredHistory }
      } finally { await restored.end() }
    }
  }
  writeFileSync(output, `${JSON.stringify({ schema_version: 'bridge-254-compose-chain-review/1', status: 'review_only', deployable: false, production_evidence: false, ingress_fenced: false, task_drain_verified: false, bridge_base_commit: manifest.bridge_base_commit, migration_commit: manifest.migration_commit, overlay_tree_sha256: manifest.overlay_tree_sha256, api_image_id: apiImage, worker_image_id: workerImage, postgres_image: pg.image, backup_restore: backupRestore, observations }, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  process.stdout.write(`PASS review-only isolated Compose bridge 242..254; output=${output}\n`)
} finally {
  const failures = []
  if (composeCreated) try { await compose('down', '--remove-orphans', '--timeout', '10') } catch (error) { failures.push(error) }
  try { await pool?.end() } catch (error) { failures.push(error) }
  if (networkCreated) {
    for (const item of fixture?.containerEvidence ?? []) try { await docker('network', 'disconnect', network, item.id) } catch { /* fixture disposal reclaims it */ }
    try { await docker('network', 'rm', network) } catch (error) { failures.push(error) }
  }
  if (fixture) try { if ((await fixture.dispose()).leftRunning.length) failures.push(new Error('fixture containers require cleanup review')) } catch (error) { failures.push(error) }
  try { await dockerClient?.dispose() } catch (error) { failures.push(error) }
  if (failures.length) throw new Error(`bridge Compose cleanup requires inspection: ${failures.map(error => error.message).join('; ')}`)
}
