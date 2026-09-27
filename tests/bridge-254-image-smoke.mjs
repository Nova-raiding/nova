// Local, review-only runtime smoke for one B-derived API/worker image pair.
// Uses an owned PG17/Redis fixture and never contacts production or a registry.
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { Pool } from 'pg'
import { createIsolatedOpsFixture } from './isolated-ops-fixture.ts'
import { createBridgeDockerClient } from './bridge-docker-target.mjs'
import { loadMigrations, MigrationRunner } from '../packages/persistence/src/migration.ts'

const run = promisify(execFile)
const [overlay, apiReference, workerReference, output] = process.argv.slice(2)
if (!overlay || !apiReference || !workerReference || !output || process.argv.length !== 6) throw new Error('usage: node --import tsx tests/bridge-254-image-smoke.mjs <absolute overlay> <API image> <worker image> <new absolute output.json>')
if (![overlay, output].every(path => isAbsolute(path) && resolve(path) === path) || lstatSync(overlay).isSymbolicLink()) throw new Error('overlay and output paths must be canonical absolute paths')
if (existsSync(output)) throw new Error('review output path already exists')
const manifest = JSON.parse(readFileSync(join(overlay, 'overlay-manifest.json'), 'utf8'))
if (manifest.schema_version !== 'ecs-bridge-254-compatibility-overlay/1' || manifest.status !== 'review_only' || manifest.deployable !== false || manifest.runtime_verified !== false || !/^sha256:[a-f0-9]{64}$/u.test(manifest.overlay_tree_sha256 ?? '')) throw new Error('B-derived overlay must remain review-only')
const hash = value => createHash('sha256').update(value).digest('hex')
function inventory(directory, prefix = '') {
  const found = []
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name), relative = prefix ? `${prefix}/${name}` : name, stat = lstatSync(path)
    if (stat.isDirectory()) found.push(...inventory(path, relative))
    else if (stat.isFile()) found.push([relative, hash(readFileSync(path))])
    else throw new Error('overlay tree contains a link or special file')
  }
  return found
}
const sourceRoot = join(overlay, 'overlay-source')
if (`sha256:${hash(inventory(sourceRoot).map(([path, digest]) => `${path}\t${digest}\n`).join(''))}` !== manifest.overlay_tree_sha256) throw new Error('overlay source tree digest mismatch')
let dockerClient
const docker = async (...args) => {
  if (!dockerClient) throw new Error('isolated local Docker client was not initialized')
  try { return (await run('docker', [...dockerClient.args, ...args], { encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024, env: dockerClient.environment })).stdout.trim() }
  catch { throw new Error(`local review Docker command failed: ${args[0] ?? 'command'}`) }
}
async function imageId(reference) {
  const body = JSON.parse(await docker('image', 'inspect', reference, '--format', '{{json .}}'))
  if (!/^sha256:[a-f0-9]{64}$/u.test(body.Id ?? '') || body.Config?.Labels?.['com.storenova.bridge-review.tree-sha256'] !== manifest.overlay_tree_sha256) throw new Error('local image is not bound to this review overlay')
  return body.Id
}
const marker = randomUUID()
const network = `merchant-bridge-254-review-${marker}`
const evidenceDir = await mkdtemp(join(tmpdir(), 'merchant-bridge-254-image-'))
let fixture, networkCreated = false, pool
const owned = []
const containerUrl = (value, host, port) => { const url = new URL(value); url.hostname = host; url.port = String(port); return url.toString() }
async function ownedContainer(name, id) {
  const inspect = JSON.parse(await docker('inspect', '--format', '{{json .}}', id))
  if (inspect.Id !== id || inspect.Name !== `/${name}` || inspect.Config?.Labels?.['merchant.bridge-254-review'] !== marker) throw new Error('owned container identity changed')
  return inspect
}
async function start(name, image, environment, alias) {
  const id = await docker('run', '-d', '--rm', '--pull=never', '--name', name, '--network', network,
    ...(alias ? ['--network-alias', alias] : []), '--label', `merchant.bridge-254-review=${marker}`,
    ...Object.entries(environment).flatMap(([key, value]) => ['-e', `${key}=${value}`]), image)
  if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error('owned container ID is invalid')
  owned.push({ name, id })
  await ownedContainer(name, id)
  return id
}
async function stopOwned() {
  const failures = []
  for (const item of [...owned].reverse()) {
    try {
      await ownedContainer(item.name, item.id)
      await docker('stop', '--time', '10', item.id)
      owned.splice(owned.indexOf(item), 1)
    } catch { failures.push(item.id) }
  }
  if (failures.length) throw new Error(`owned bridge containers require cleanup review: ${failures.join(',')}`)
}
async function waitForApi(id, prefix) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = JSON.parse(await docker('exec', id, 'wget', '-qO-', 'http://127.0.0.1:8787/healthz'))
      if (response.data?.persistence?.ready === true) return
    } catch { /* bounded readiness polling */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 500))
  }
  throw new Error(`B-derived API did not become healthy on isolated prefix ${prefix}`)
}
const roles = ['sync', 'generation', 'publish', 'reconcile', 'automation', 'scan']
let apiImage, workerImage
try {
  dockerClient = await createBridgeDockerClient()
  const imageIds = await Promise.all([imageId(apiReference), imageId(workerReference)])
  apiImage = imageIds[0]
  workerImage = imageIds[1]
  fixture = await createIsolatedOpsFixture({ evidenceDir })
  pool = new Pool({ connectionString: fixture.acceptanceDatabaseUrls.legacyBackfill, max: 2 })
  const migrations = await loadMigrations()
  if (migrations.length !== 254) throw new Error('review source must carry migration tail 254')
  for (const migration of migrations) {
    const name = `${String(migration.version).padStart(3, '0')}_${migration.name}.sql`
    if (readFileSync(join(sourceRoot, 'packages/persistence/src/migrations', name), 'utf8') !== migration.sql) throw new Error(`local migration SQL differs from B-derived review source: ${name}`)
  }
  const pg = fixture.containerEvidence.find(value => value.kind === 'postgres')
  const redis = fixture.containerEvidence.find(value => value.kind === 'redis')
  if (!pg || !redis) throw new Error('owned fixture containers are incomplete')
  await docker('network', 'create', '--internal', network)
  networkCreated = true
  const networkInfo = JSON.parse(await docker('network', 'inspect', '--format', '{{json .}}', network))
  if (networkInfo.Name !== network || networkInfo.Internal !== true) throw new Error('review bridge network is not internal')
  await docker('network', 'connect', '--alias', 'bridge-pg', network, pg.id)
  await docker('network', 'connect', '--alias', 'bridge-redis', network, redis.id)
  const databaseUrl = containerUrl(fixture.acceptanceDatabaseUrls.legacyBackfill, 'bridge-pg', 5432)
  const redisUrl = containerUrl(fixture.redisUrl, 'bridge-redis', 6379)
  const observations = []
  for (const prefix of [242, 254]) {
    await new MigrationRunner(pool, migrations.slice(0, prefix)).run()
    const rows = (await pool.query('SELECT version, name, checksum FROM schema_migrations ORDER BY version')).rows
    if (rows.length !== prefix || rows.some((row, index) => row.version !== index + 1 || typeof row.checksum !== 'string')) throw new Error(`isolated migration history is not complete at ${prefix}`)
    await pool.query('INSERT INTO workspaces (id,status) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING', [fixture.workspaceId, 'active'])
    const common = { NODE_ENV: 'development', DATABASE_URL: databaseUrl, REDIS_URL: redisUrl, BRIDGE_SCHEMA_COMPATIBILITY_MODE: 'prefix_242_or_254', RUN_MIGRATIONS_ON_STARTUP: 'false' }
    const apiId = await start(`merchant-bridge-254-api-${prefix}-${marker}`, apiImage, { ...common, OPS_DATABASE_URL: databaseUrl, PORT: '8787', API_BIND_HOST: '0.0.0.0', PERSISTENCE_MODE: 'postgres', CONNECTOR_FIXTURE_MODE: 'false' }, 'bridge-api')
    await waitForApi(apiId, prefix)
    const products = await docker('exec', apiId, 'sh', '-c', 'wget -qO /dev/null -S http://127.0.0.1:8787/v1/products 2>&1 || true')
    if (!/HTTP\/1\.1 (401|403)/u.test(products)) throw new Error(`API authentication boundary failed at ${prefix}`)
    const workerIds = []
    for (const role of roles) workerIds.push(await start(`merchant-bridge-254-${role}-${prefix}-${marker}`, workerImage,
      { ...common, WORKER_ROLE: role, WORKER_WORKSPACES: fixture.workspaceId, WORKER_API_BASE_URL: 'http://bridge-api:8787' }))
    await new Promise(resolveWait => setTimeout(resolveWait, 2_500))
    for (const [index, id] of workerIds.entries()) {
      const inspect = await ownedContainer(`merchant-bridge-254-${roles[index]}-${prefix}-${marker}`, id)
      if (inspect.State?.Running !== true || inspect.Image !== workerImage) throw new Error(`worker ${roles[index]} is not running from reviewed image at ${prefix}`)
    }
    observations.push({ prefix, history_sha256: `sha256:${hash(rows.map(row => `${row.version}\t${row.name}\t${row.checksum}\n`).join(''))}`, api_container_id: apiId, worker_container_ids: workerIds })
    await stopOwned()
  }
  writeFileSync(output, `${JSON.stringify({ schema_version: 'bridge-254-image-smoke-review/1', status: 'review_only', deployable: false, production_evidence: false,
    bridge_base_commit: manifest.bridge_base_commit, migration_commit: manifest.migration_commit, overlay_tree_sha256: manifest.overlay_tree_sha256,
    api_image_id: apiImage, worker_image_id: workerImage, postgres_image: pg.image, observations }, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  process.stdout.write(`PASS review-only: B-derived API and six workers ran on isolated PG17 prefixes 242 and 254; output=${output}\n`)
} finally {
  const cleanupFailures = []
  try { await stopOwned() } catch (error) { cleanupFailures.push(error) }
  try { await pool?.end() } catch (error) { cleanupFailures.push(error) }
  if (networkCreated) {
    for (const item of fixture?.containerEvidence ?? []) {
      try { await docker('network', 'disconnect', network, item.id) } catch { /* fixture disposal can reclaim the connection */ }
    }
    try { await docker('network', 'rm', network) } catch (error) { cleanupFailures.push(error) }
  }
  if (fixture) {
    try {
      const result = await fixture.dispose()
      if (result.leftRunning.length) cleanupFailures.push(new Error('owned fixture cleanup requires inspection'))
    } catch (error) { cleanupFailures.push(error) }
  }
  try { await dockerClient?.dispose() } catch (error) { cleanupFailures.push(error) }
  if (cleanupFailures.length) throw new Error(`isolated bridge cleanup requires inspection: ${cleanupFailures.length} failure(s)`)
}
