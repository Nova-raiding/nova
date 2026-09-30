import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner, verifyAppliedMigrations } from '../packages/persistence/src/migration.js'
import { verifyWorkerRequestProof } from '../packages/security/src/worker-request-proof.js'
import { assertBridgeStartupMigrationVersion, assertWorkerReadinessDependencies } from '../apps/worker/src/main.js'
import { createIsolatedOpsFixture } from './isolated-ops-fixture.js'

const automationToken = 'isolated-worker-automation-token'
const automationSecret = 'isolated-worker-automation-signing-secret'
type WorkerRole = 'sync' | 'automation'
type StubRequest = { method: string; target: string; body: string; headers: IncomingMessage['headers'] }

async function startAutomationApiStub(): Promise<{ url: string; requests: StubRequest[]; close: () => Promise<void> }> {
  const requests: StubRequest[] = []
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks).toString('utf8')
    const target = request.url ?? '/'
    if (request.method === 'GET' && target === '/readyz') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: { persistence: { ready: true }, redis: { ready: true } } }))
      return
    }
    requests.push({ method: request.method ?? 'GET', target, body, headers: request.headers })
    const payload = target === '/v1/internal/automation/tick'
      ? { data: { result: { executed: [] } } }
      : target === '/v1/internal/storage/orphans/cleanup'
        ? { data: { cleaned: 0 } }
        : target === '/v1/internal/assets/lifecycle/purge'
          ? { data: { purged: 0 } }
          : { error: { code: 'ISOLATED_STUB_ROUTE_NOT_FOUND' } }
    response.writeHead('error' in payload ? 404 : 200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(payload))
  })
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('isolated automation API stub did not bind a TCP port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())),
  }
}

async function runWorkerOnce(input: { databaseUrl: string; redisUrl: string; workspaceId: string; evidenceDir: string; expectedVersion: number | null; bridgeMode?: string; role?: WorkerRole; apiBaseUrl?: string }): Promise<Record<string, unknown> | undefined> {
  const role = input.role ?? 'sync'
  const env: NodeJS.ProcessEnv = {
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C.UTF-8',
    NODE_ENV: 'development', DATABASE_URL: input.databaseUrl, REDIS_URL: input.redisUrl,
    WORKER_ROLE: role, WORKER_WORKSPACES: input.workspaceId, WORKER_ONCE: 'true',
    WORKER_METRICS_PORT: '0', WORKER_READY_FILE: resolve(input.evidenceDir, `worker-${input.expectedVersion ?? 'partial'}-${role}.ready`),
    BRIDGE_SCHEMA_COMPATIBILITY_MODE: input.bridgeMode ?? 'prefix_254_or_255',
    ...(role === 'automation' ? {
      WORKER_API_BASE_URL: input.apiBaseUrl,
      WORKER_API_TOKEN: automationToken,
      WORKER_API_SIGNING_SECRET: automationSecret,
    } : {}),
  }
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/worker/src/main.ts'], {
    cwd: resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const append = (chunk: Buffer) => {
    output = `${output}${chunk.toString('utf8')}`.slice(-8_000)
  }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  const exit = await new Promise<number | null>((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`isolated worker timed out at ${input.expectedVersion}`))
    }, 30_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); resolveExit(code) })
  })
  const diagnostics = output.replaceAll(input.databaseUrl, '[database]').replaceAll(input.redisUrl, '[redis]')
    .replaceAll(automationToken, '[worker-token]').replaceAll(automationSecret, '[worker-secret]')
  if (input.expectedVersion === null) {
    expect(exit, `worker unexpectedly accepted an incomplete migration prefix: ${diagnostics}`).not.toBe(0)
    expect(diagnostics).toContain('exactly 254 or 255')
    return
  }
  expect(exit, `worker failed at ${input.expectedVersion}: ${diagnostics}`).toBe(0)
  expect(diagnostics).toContain('"message":"worker poll completed"')
  const readiness = JSON.parse(await readFile(env.WORKER_READY_FILE!, 'utf8')) as Record<string, unknown>
  expect(readiness).toMatchObject({ role, workspaces: 1 })
  return readiness
}

describe('254/255 worker bridge on an owned PostgreSQL 17 fixture', () => {
  it('checks both prefixes through the production app role and requires a worker restart after migration', async () => {
    const evidenceDir = resolve('artifacts/bridge-254-255-worker-isolation', randomUUID())
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
    const fixture = await createIsolatedOpsFixture({ evidenceDir })
    const databaseUrl = fixture.acceptanceDatabaseUrls?.legacyBackfill
    if (!databaseUrl) throw new Error('isolated empty PostgreSQL database unavailable')

    const databaseName = new URL(databaseUrl).pathname.slice(1)
    const appUrl = new URL(fixture.databaseUrl)
    appUrl.pathname = `/${databaseName}`
    const admin = new Pool({ connectionString: databaseUrl })
    const app = new Pool({ connectionString: appUrl.toString() })
    try {
      const migrations = await loadMigrations()
      expect(migrations.at(-1)?.version).toBe(257)
      const roleSql = await readFile(new URL('../infra/local/ensure-app-role.sql', import.meta.url), 'utf8')
      const databaseGrant = /ON DATABASE merchant\b/gu
      expect([...roleSql.matchAll(databaseGrant)]).toHaveLength(3)
      const isolatedRoleSql = roleSql.replace(databaseGrant, `ON DATABASE "${databaseName}"`)

      await admin.query(isolatedRoleSql)
      await new MigrationRunner(admin, migrations.slice(0, 253)).run()
      await runWorkerOnce({ databaseUrl: appUrl.toString(), redisUrl: fixture.redisUrl,
        workspaceId: fixture.workspaceId, evidenceDir, expectedVersion: null })
      await new MigrationRunner(admin, migrations.slice(0, 254)).run()
      await admin.query(isolatedRoleSql)

      const bridgeMigrations = migrations
      const ready254 = await assertWorkerReadinessDependencies({
        database: app,
        expectedMigrations: migrations,
        bridgeMigrations,
        bridgeMode: 'prefix_254_or_255',
      })
      expect(ready254).toEqual({ migrationVersion: 254, apiReady: false })
      expect(() => assertBridgeStartupMigrationVersion(ready254.migrationVersion, 254)).not.toThrow()
      await runWorkerOnce({ databaseUrl: appUrl.toString(), redisUrl: fixture.redisUrl,
        workspaceId: fixture.workspaceId, evidenceDir, expectedVersion: 254 })

      expect(await new MigrationRunner(admin, migrations.slice(0, 255)).run()).toEqual([255])
      await admin.query(isolatedRoleSql)
      const history = (await admin.query<{ version: number; name: string; checksum: string }>(
        'SELECT version,name,checksum FROM schema_migrations ORDER BY version',
      )).rows
      expect(history).toHaveLength(255)
      expect(() => verifyAppliedMigrations(history, migrations.slice(0, 255))).not.toThrow()

      const ready255 = await assertWorkerReadinessDependencies({
        database: app,
        expectedMigrations: migrations,
        bridgeMigrations,
        bridgeMode: 'prefix_254_or_255',
      })
      expect(ready255).toEqual({ migrationVersion: 255, apiReady: false })
      expect(() => assertBridgeStartupMigrationVersion(ready254.migrationVersion, ready255.migrationVersion))
        .toThrow('bridge database migration prefix changed; restart the worker before processing tasks')
      expect(() => assertBridgeStartupMigrationVersion(ready255.migrationVersion, ready255.migrationVersion)).not.toThrow()
      await runWorkerOnce({ databaseUrl: appUrl.toString(), redisUrl: fixture.redisUrl,
        workspaceId: fixture.workspaceId, evidenceDir, expectedVersion: 255 })

      const ready255OnNewBridge = await assertWorkerReadinessDependencies({
        database: app, expectedMigrations: migrations, bridgeMigrations: migrations, bridgeMode: 'prefix_255_or_256',
      })
      expect(ready255OnNewBridge).toEqual({ migrationVersion: 255, apiReady: false })
      expect(() => assertBridgeStartupMigrationVersion(ready255OnNewBridge.migrationVersion, 256))
        .toThrow('bridge database migration prefix changed; restart the worker before processing tasks')

      // Exercise the actual automation process while the DB is still at 255.
      // Routine maintenance remains available, but the 256-only lifecycle
      // purge callback must not be issued by this bridge process.
      const automation255 = await startAutomationApiStub()
      try {
        await runWorkerOnce({ databaseUrl: appUrl.toString(), redisUrl: fixture.redisUrl,
          workspaceId: fixture.workspaceId, evidenceDir, expectedVersion: 255,
          bridgeMode: 'prefix_255_or_256', role: 'automation', apiBaseUrl: automation255.url })
        expect(automation255.requests.map(request => request.target)).toEqual([
          '/v1/internal/automation/tick', '/v1/internal/storage/orphans/cleanup',
        ])
        expect(automation255.requests.every(request => request.headers.authorization === `Bearer ${automationToken}`)).toBe(true)
        expect(automation255.requests.every(request => request.headers['x-workspace-id'] === fixture.workspaceId)).toBe(true)
      } finally {
        await automation255.close()
      }

      expect(await new MigrationRunner(admin, migrations.slice(0, 256)).run()).toEqual([256])
      const ready256 = await assertWorkerReadinessDependencies({
        database: app, expectedMigrations: migrations, bridgeMigrations: migrations, bridgeMode: 'prefix_255_or_256',
      })
      expect(ready256).toEqual({ migrationVersion: 256, apiReady: false })
      expect(() => assertBridgeStartupMigrationVersion(ready256.migrationVersion, 256)).not.toThrow()
      await runWorkerOnce({ databaseUrl: appUrl.toString(), redisUrl: fixture.redisUrl,
        workspaceId: fixture.workspaceId, evidenceDir, expectedVersion: 256, bridgeMode: 'prefix_255_or_256' })

      // After migration 256, a restarted real automation process is allowed to
      // issue the purge callback. Verify scope, request body, bearer token, and
      // cryptographic automation proof at the loopback-only receiver.
      const automation256 = await startAutomationApiStub()
      try {
        await runWorkerOnce({ databaseUrl: appUrl.toString(), redisUrl: fixture.redisUrl,
          workspaceId: fixture.workspaceId, evidenceDir, expectedVersion: 256,
          bridgeMode: 'prefix_255_or_256', role: 'automation', apiBaseUrl: automation256.url })
        const purgeRequests = automation256.requests.filter(request => request.target === '/v1/internal/assets/lifecycle/purge')
        expect(purgeRequests).toHaveLength(1)
        const purge = purgeRequests[0]!
        expect(purge.method).toBe('POST')
        expect(purge.headers.authorization).toBe(`Bearer ${automationToken}`)
        expect(purge.headers['x-workspace-id']).toBe(fixture.workspaceId)
        expect(JSON.parse(purge.body)).toEqual({ workspace_id: fixture.workspaceId, limit: 25 })
        const header = (name: string) => {
          const value = purge.headers[name]
          return Array.isArray(value) ? value[0] : value
        }
        expect(header('x-worker-role')).toBe('automation')
        expect(verifyWorkerRequestProof({
          secret: automationSecret,
          role: 'automation',
          workerId: header('x-worker-id'),
          method: purge.method,
          requestTarget: purge.target,
          workspaceId: fixture.workspaceId,
          body: purge.body,
          timestamp: header('x-worker-timestamp') ?? '',
          nonce: header('x-worker-nonce') ?? '',
          bodySha256: header('x-worker-body-sha256') ?? '',
          signature: header('x-worker-workspace-signature') ?? '',
        })).toBe(true)
      } finally {
        await automation256.close()
      }

      // A 256-to-257 bridge starts safely on 256, but must keep the new
      // lifecycle callback fenced until the database has reached 257.
      const automation256On257Bridge = await startAutomationApiStub()
      try {
        await runWorkerOnce({ databaseUrl: appUrl.toString(), redisUrl: fixture.redisUrl,
          workspaceId: fixture.workspaceId, evidenceDir, expectedVersion: 256,
          bridgeMode: 'prefix_256_or_257', role: 'automation', apiBaseUrl: automation256On257Bridge.url })
        expect(automation256On257Bridge.requests.map(request => request.target)).toEqual([
          '/v1/internal/automation/tick', '/v1/internal/storage/orphans/cleanup',
        ])
        expect(automation256On257Bridge.requests.every(request => request.headers['x-workspace-id'] === fixture.workspaceId)).toBe(true)
      } finally {
        await automation256On257Bridge.close()
      }

      const ready256OnNewBridge = await assertWorkerReadinessDependencies({
        database: app, expectedMigrations: migrations, bridgeMigrations: migrations, bridgeMode: 'prefix_256_or_257',
      })
      expect(ready256OnNewBridge).toEqual({ migrationVersion: 256, apiReady: false })
      expect(() => assertBridgeStartupMigrationVersion(ready256OnNewBridge.migrationVersion, 257))
        .toThrow('bridge database migration prefix changed; restart the worker before processing tasks')

      expect(await new MigrationRunner(admin, migrations.slice(0, 257)).run()).toEqual([257])
      await admin.query(isolatedRoleSql)
      const history257 = (await admin.query<{ version: number; name: string; checksum: string }>(
        'SELECT version,name,checksum FROM schema_migrations ORDER BY version',
      )).rows
      expect(history257).toHaveLength(257)
      expect(() => verifyAppliedMigrations(history257, migrations.slice(0, 257))).not.toThrow()

      const ready257 = await assertWorkerReadinessDependencies({
        database: app, expectedMigrations: migrations, bridgeMigrations: migrations, bridgeMode: 'prefix_256_or_257',
      })
      expect(ready257).toEqual({ migrationVersion: 257, apiReady: false })
      expect(() => assertBridgeStartupMigrationVersion(ready256OnNewBridge.migrationVersion, ready257.migrationVersion))
        .toThrow('bridge database migration prefix changed; restart the worker before processing tasks')
      expect(() => assertBridgeStartupMigrationVersion(ready257.migrationVersion, ready257.migrationVersion)).not.toThrow()

      // Once the 257 schema is present, a restarted worker on the matching
      // bridge enables purge and signs the request with its automation proof.
      const automation257 = await startAutomationApiStub()
      try {
        await runWorkerOnce({ databaseUrl: appUrl.toString(), redisUrl: fixture.redisUrl,
          workspaceId: fixture.workspaceId, evidenceDir, expectedVersion: 257,
          bridgeMode: 'prefix_256_or_257', role: 'automation', apiBaseUrl: automation257.url })
        const requests257 = automation257.requests.map(request => request.target)
        expect(requests257).toEqual([
          '/v1/internal/automation/tick', '/v1/internal/storage/orphans/cleanup',
          '/v1/internal/assets/lifecycle/purge',
        ])
        const purge = automation257.requests.find(request => request.target === '/v1/internal/assets/lifecycle/purge')!
        expect(purge.method).toBe('POST')
        expect(purge.headers.authorization).toBe(`Bearer ${automationToken}`)
        expect(purge.headers['x-workspace-id']).toBe(fixture.workspaceId)
        expect(JSON.parse(purge.body)).toEqual({ workspace_id: fixture.workspaceId, limit: 25 })
        const header = (name: string) => {
          const value = purge.headers[name]
          return Array.isArray(value) ? value[0] : value
        }
        expect(header('x-worker-role')).toBe('automation')
        expect(verifyWorkerRequestProof({
          secret: automationSecret,
          role: 'automation',
          workerId: header('x-worker-id'),
          method: purge.method,
          requestTarget: purge.target,
          workspaceId: fixture.workspaceId,
          body: purge.body,
          timestamp: header('x-worker-timestamp') ?? '',
          nonce: header('x-worker-nonce') ?? '',
          bodySha256: header('x-worker-body-sha256') ?? '',
          signature: header('x-worker-workspace-signature') ?? '',
        })).toBe(true)
      } finally {
        await automation257.close()
      }
    } finally {
      await app.end()
      await admin.end()
      await fixture.dispose()
    }
  }, 120_000)
})
