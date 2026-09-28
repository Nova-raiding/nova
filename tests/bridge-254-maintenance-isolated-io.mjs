// Local-only Docker/PG17 I/O port for the Bridge 254 maintenance core.
// It cannot address production: one discovered local Unix socket, an internal
// Docker network, synthetic fixture credentials, and zero published ports.
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { createBridgeDockerClient } from './bridge-docker-target.mjs'
import { createIsolatedOpsFixture } from './isolated-ops-fixture.ts'
import { loadMigrations, migrationChecksum, MigrationRunner } from '../packages/persistence/src/migration.ts'

const run = promisify(execFile)
const sha = value => createHash('sha256').update(value).digest('hex')
const roles = ['sync', 'generation', 'publish', 'reconcile', 'automation', 'scan']
const inNetwork = (value, host, port) => { const url = new URL(value); url.hostname = host; url.port = String(port); return url.toString() }

export async function createIsolatedBridge254IO({ apiReference, workerReference, overlayTreeSha256, initialPrefix = 242 }) {
  if (!/^sha256:[a-f0-9]{64}$/u.test(overlayTreeSha256 ?? '') || !Number.isInteger(initialPrefix) || initialPrefix < 242 || initialPrefix > 254) throw new Error('isolated bridge identity/prefix invalid')
  const client = await createBridgeDockerClient()
  const marker = randomUUID(), project = `bridge254resume${marker.replaceAll('-', '')}`
  const network = `bridge-254-resume-${marker}`
  const dir = await mkdtemp(join(tmpdir(), 'bridge-254-resume-'))
  const composeFile = join(dir, 'compose.json')
  let fixture, pool, networkCreated = false, composeCreated = false, disposed = false
  const docker = async (...args) => {
    try { return (await run('docker', [...client.args, ...args], { env: client.environment, encoding: 'utf8', timeout: 90_000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim() }
    catch { throw new Error(`isolated Docker ${args[0] ?? 'command'} failed`) }
  }
  const compose = async (...args) => {
    try { return (await run('docker-compose', ['-p', project, '-f', composeFile, ...args], {
      env: { ...client.environment, DOCKER_HOST: `unix://${client.socket}`, DOCKER_CONFIG: client.configPath },
      encoding: 'utf8', timeout: 90_000, maxBuffer: 2 * 1024 * 1024,
    })).stdout.trim() }
    catch { throw new Error(`isolated Compose ${args[0] ?? 'command'} failed`) }
  }
  const imageId = async reference => {
    const body = JSON.parse(await docker('image', 'inspect', reference, '--format', '{{json .}}'))
    if (!/^sha256:[a-f0-9]{64}$/u.test(body.Id ?? '') || body.Config?.Labels?.['com.storenova.bridge-review.tree-sha256'] !== overlayTreeSha256) throw new Error('isolated bridge image differs from reviewed tree')
    return body.Id
  }
  async function service(name) {
    const id = await compose('ps', '-a', '-q', name)
    if (!/^[a-f0-9]{64}$/u.test(id)) return null
    const body = JSON.parse(await docker('inspect', '--format', '{{json .}}', id))
    if (body.Id !== id || body.Config?.Labels?.['com.docker.compose.project'] !== project || body.Config?.Labels?.['merchant.bridge-254-review'] !== marker) throw new Error('isolated Compose identity changed')
    return body
  }
  async function internal() {
    const body = JSON.parse(await docker('network', 'inspect', '--format', '{{json .}}', network))
    return body.Name === network && body.Internal === true
  }
  async function health(name) {
    const container = await service(name)
    if (!container?.State?.Running) return false
    try {
      const response = JSON.parse(await docker('exec', container.Id, 'wget', '-qO-', 'http://127.0.0.1:8787/healthz'))
      return response.data?.persistence?.ready === true
    } catch { return false }
  }
  try {
    const [apiImage, workerImage] = await Promise.all([imageId(apiReference), imageId(workerReference)])
    fixture = await createIsolatedOpsFixture({ evidenceDir: dir })
    pool = new Pool({ connectionString: fixture.acceptanceDatabaseUrls.legacyBackfill, max: 2 })
    const migrations = (await loadMigrations()).slice(0, 254)
    if (migrations.length !== 254) throw new Error('isolated bridge migration inventory is not 254')
    const prefixes = Object.fromEntries(Array.from({ length: 13 }, (_, index) => {
      const version = index + 242
      return [String(version), sha(migrations.slice(0, version).map(migration => `${migration.version}\t${migration.name}\t${migrationChecksum(migration.sql)}\n`).join(''))]
    }))
    await new MigrationRunner(pool, migrations.slice(0, initialPrefix)).run()
    const pg = fixture.containerEvidence.find(item => item.kind === 'postgres')
    const redis = fixture.containerEvidence.find(item => item.kind === 'redis')
    if (!pg || !redis) throw new Error('isolated fixture PG17/Redis missing')
    await docker('network', 'create', '--internal', network)
    networkCreated = true
    await docker('network', 'connect', '--alias', 'bridge-pg', network, pg.id)
    await docker('network', 'connect', '--alias', 'bridge-redis', network, redis.id)
    const databaseUrl = inNetwork(fixture.acceptanceDatabaseUrls.legacyBackfill, 'bridge-pg', 5432)
    const redisUrl = inNetwork(fixture.redisUrl, 'bridge-redis', 6379)
    const workerApiToken = randomBytes(32).toString('hex')
    const workerApiSigningSecret = randomBytes(32).toString('hex')
    const scannerApiToken = randomBytes(32).toString('hex')
    const scannerSigningSecret = randomBytes(32).toString('hex')
    const scannerReceiptPrivateKeyPem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const common = { NODE_ENV: 'development', DATABASE_URL: databaseUrl, REDIS_URL: redisUrl,
      BRIDGE_SCHEMA_COMPATIBILITY_MODE: 'prefix_242_or_254', RUN_MIGRATIONS_ON_STARTUP: 'false' }
    const services = {
      api: { image: apiImage, labels: { 'merchant.bridge-254-review': marker }, networks: [network], environment: { ...common, OPS_DATABASE_URL: databaseUrl, PORT: '8787', API_BIND_HOST: '0.0.0.0', PERSISTENCE_MODE: 'postgres', CONNECTOR_FIXTURE_MODE: 'false', WORKER_API_TOKEN: workerApiToken, ASSET_SCANNER_API_TOKEN: scannerApiToken, ASSET_SCANNER_WORKSPACE_SIGNING_SECRET: scannerSigningSecret } },
      'api-replica': { image: apiImage, labels: { 'merchant.bridge-254-review': marker }, networks: [network], environment: { ...common, OPS_DATABASE_URL: databaseUrl, PORT: '8787', API_BIND_HOST: '0.0.0.0', PERSISTENCE_MODE: 'postgres', CONNECTOR_FIXTURE_MODE: 'false', WORKER_API_TOKEN: workerApiToken, ASSET_SCANNER_API_TOKEN: scannerApiToken, ASSET_SCANNER_WORKSPACE_SIGNING_SECRET: scannerSigningSecret } },
      clamav: { image: 'clamav/clamav-debian@sha256:bcfc3d6117a6cfbeb6cd041c00164097916291b870c6183e06def6fed7fb740b', labels: { 'merchant.bridge-254-review': marker }, networks: [network], environment: { CLAMD_CONF_StreamMaxLength: '100M', CLAMD_CONF_MaxFileSize: '100M', CLAMD_CONF_MaxScanSize: '100M', CLAMD_CONF_AlertExceedsMax: 'yes' } },
    }
    for (const role of roles) services[`worker-${role}`] = { image: workerImage, labels: { 'merchant.bridge-254-review': marker }, networks: [network],
      environment: { ...common, WORKER_ROLE: role, WORKER_WORKSPACES: fixture.workspaceId, WORKER_API_BASE_URL: 'http://api:8787',
        WORKER_API_TOKEN: workerApiToken, WORKER_API_SIGNING_SECRET: workerApiSigningSecret,
        ...(role === 'scan' ? { CLAMAV_HOST: 'clamav', ASSET_SCANNER_API_TOKEN: scannerApiToken,
          ASSET_SCANNER_WORKSPACE_SIGNING_SECRET: scannerSigningSecret, ASSET_SCAN_RECEIPT_PRIVATE_KEY_PEM: scannerReceiptPrivateKeyPem,
          ASSET_SCAN_RECEIPT_KEY_ID: 'isolated-scanner-key' } : {}) } }
    const bridgeNames = ['api', 'api-replica', ...roles.map(role => `worker-${role}`)]
    writeFileSync(composeFile, JSON.stringify({ services, networks: { [network]: { external: true } } }), { mode: 0o600, flag: 'wx' })
    const port = {
      async assertProtectedLock() { if (disposed || !(await internal())) throw new Error('isolated lock/network unavailable') },
      async observeStoppedTraffic() {
        const running = await Promise.all(Object.keys(services).map(async name => (await service(name))?.State?.Running === true))
        const fenced = await internal()
        return { all_runtime_stopped: running.every(value => !value), ingress_fenced: fenced, callbacks_fenced: fenced }
      },
      async observePrefix() {
        const rows = (await pool.query('SELECT version,name,checksum FROM schema_migrations ORDER BY version')).rows
        const version = rows.length
        const history_sha256 = sha(rows.map(row => `${row.version}\t${row.name}\t${row.checksum}\n`).join(''))
        return { version, history_sha256, ops_version: version, ops_history_sha256: history_sha256 }
      },
      async applySingleMigration(version) {
        const before = await this.observePrefix()
        if (version !== before.version + 1) throw new Error('isolated migration must advance one prefix')
        await new MigrationRunner(pool, migrations.slice(0, version)).run()
      },
      async startBridgeAt254() {
        if ((await this.observePrefix()).version !== 254 || !(await internal())) throw new Error('isolated bridge requires PG17 prefix 254/internal network')
        composeCreated = true
        await compose('up', '-d', '--no-deps', '--pull', 'never')
        return { all_eight_running: (await Promise.all(bridgeNames.map(async name => (await service(name))?.State?.Running === true))).every(Boolean), ingress_fenced: true }
      },
      async verifyBridgeAt254() {
        for (let attempt = 0; attempt < 60; attempt += 1) {
          if (await health('api') && await health('api-replica')) break
          await new Promise(resolveWait => setTimeout(resolveWait, 500))
        }
        const api_ready = await health('api') && await health('api-replica')
        const workerStatus = async () => Promise.all(roles.map(async role => {
          const container = await service(`worker-${role}`)
          if (!container?.State?.Running) return { role, running: false, ready: false }
          const marker = await docker('exec', container.Id, 'sh', '-c', 'cat /tmp/merchant-worker-ready 2>/dev/null || true')
          let ready = false
          try {
            const state = JSON.parse(marker)
            ready = role === 'scan' ? state.state === 'ready' && state.heartbeat?.ready === true
              : typeof state.readyAt === 'string'
          } catch { /* absence or malformed marker is not ready */ }
          return { role, running: true, ready }
        }))
        let workers = await workerStatus()
        for (let attempt = 0; attempt < 60 && !workers.every(worker => worker.ready); attempt += 1) {
          await new Promise(resolveWait => setTimeout(resolveWait, 500))
          workers = await workerStatus()
        }
        const identity_verified = (await Promise.all(bridgeNames.map(async name => {
          const container = await service(name)
          return container?.Image === (name.startsWith('worker-') ? workerImage : apiImage)
        }))).every(Boolean)
        const diagnostics = await Promise.all(roles.map(async role => {
          const container = await service(`worker-${role}`)
          if (!container) return { role, log_sha256: null, reason: 'container_missing' }
          const result = await run('docker', [...client.args, 'logs', '--tail', '100', container.Id], {
            env: client.environment, encoding: 'utf8', timeout: 30_000, maxBuffer: 256 * 1024,
          })
          const logs = `${result.stdout}\n${result.stderr}`
          const events = logs.split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
          const latestScanner = role === 'scan' ? events.filter(event => event.message === 'scanner heartbeat published').at(-1) : null
          const scannerFailures = [...new Set(events.flatMap(event => Array.isArray(event.not_ready_reasons) ? event.not_ready_reasons.filter(value => typeof value === 'string') : []))].sort()
          const errorCodes = [...new Set(events.flatMap(event => typeof event.error?.code === 'string' ? [event.error.code]
            : typeof event.heartbeat?.failure?.code === 'string' ? [event.heartbeat.failure.code] : []))].sort()
          const reason = /WORKER_API_BASE_URL and WORKER_API_TOKEN are required/u.test(logs) ? 'worker_api_token_missing'
            : /CLAMAV|clamav|ClamAV/u.test(logs) ? 'clamav_dependency'
              : /scanner heartbeat published/u.test(logs) ? 'scanner_heartbeat_unready'
                : /worker poll failed/u.test(logs) ? 'worker_poll_failure'
                  : 'no_classified_error'
          return { role, log_sha256: sha(logs), reason, scanner_failures: scannerFailures, error_codes: errorCodes,
            ...(role === 'scan' ? { latest_scanner: latestScanner ? {
              ready: latestScanner.heartbeat?.ready === true,
              recovery_capable: latestScanner.heartbeat?.recoveryCapable === true,
              clamav_reachable: latestScanner.heartbeat?.clamav?.reachable === true,
              callback_configured: latestScanner.heartbeat?.callback?.configured === true,
              callback_capable: latestScanner.heartbeat?.callback?.capable === true,
              failure_code: latestScanner.heartbeat?.failure?.code ?? null,
              not_ready_reasons: latestScanner.not_ready_reasons ?? [],
            } : null } : {}) }
        }))
        return { identity_verified, api_ready, six_workers_ready: workers.every(worker => worker.ready),
          public_release_verified: false, observation_sha256: sha(JSON.stringify({ api_ready, workers, diagnostics })), workers, diagnostics }
      },
      async keepIngressFencedForForwardRecovery() {
        if (!(await internal())) throw new Error('isolated ingress fence lost')
      },
    }
    return { port, prefixes, marker, project, network, fixture, async dispose() {
      if (disposed) return
      disposed = true
      const failures = []
      if (composeCreated) try { await compose('down', '--remove-orphans', '--timeout', '60') } catch (error) { failures.push(error) }
      try { await pool.end() } catch (error) { failures.push(error) }
      if (networkCreated) {
        for (const item of fixture.containerEvidence) try { await docker('network', 'disconnect', network, item.id) } catch { /* fixture disposal can reclaim */ }
        try { await docker('network', 'rm', network) } catch (error) { failures.push(error) }
      }
      try { if ((await fixture.dispose()).leftRunning.length) failures.push(new Error('fixture cleanup incomplete')) } catch (error) { failures.push(error) }
      try { await client.dispose() } catch (error) { failures.push(error) }
      try { await rm(dir, { recursive: true }) } catch (error) { failures.push(error) }
      if (failures.length) throw new AggregateError(failures, 'isolated bridge I/O cleanup incomplete')
    } }
  } catch (error) {
    try { await pool?.end() } catch {}
    if (networkCreated) {
      for (const item of fixture?.containerEvidence ?? []) try { await docker('network', 'disconnect', network, item.id) } catch {}
      try { await docker('network', 'rm', network) } catch {}
    }
    try { await fixture?.dispose() } catch {}
    try { await client.dispose() } catch {}
    try { await rm(dir, { recursive: true }) } catch {}
    throw error
  }
}
