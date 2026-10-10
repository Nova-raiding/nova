import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool } from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadMigrations } from '../../../packages/persistence/src/index.js'
import { readWorkerConfig, runWorker } from './main.js'

describe('scan worker entrypoint lifecycle', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('revokes the heartbeat marker, removes Redis evidence, and closes its queue on once-mode shutdown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scan-worker-entrypoint-'))
    const readyFile = join(directory, 'ready')
    const migrations = await loadMigrations()
    const heartbeats = new Map<string, unknown>()
    let migrationReadCount = 0
    let readyDuringLoop: string | undefined
    const publish = vi.fn(async (heartbeat: { instanceId: string }) => { heartbeats.set(heartbeat.instanceId, heartbeat) })
    const remove = vi.fn(async (instanceId: string) => { heartbeats.delete(instanceId) })
    const close = vi.fn(async () => undefined)
    const query = async (sql: string) => {
      if (/SELECT version, name FROM schema_migrations/u.test(sql)) {
        migrationReadCount += 1
        if (migrationReadCount === 2) readyDuringLoop = await readFile(readyFile, 'utf8')
        return { rows: migrations.map(migration => ({ version: migration.version, name: migration.name, checksum: createHash('sha256').update(migration.sql).digest('hex') })) }
      }
      if (/schema_migrations/u.test(sql)) {
        migrationReadCount += 1
        if (migrationReadCount === 2) readyDuringLoop = await readFile(readyFile, 'utf8')
        return { rows: migrations.map(migration => ({ version: migration.version, name: migration.name, checksum: createHash('sha256').update(migration.sql).digest('hex') })) }
      }
      if (/worker_active_workspace_catalog/u.test(sql)) return { rows: [] }
      if (/^\s*(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/u.test(sql)) return { rows: [] }
      return { rows: [] }
    }
    const pool = {
      query,
      connect: async () => ({ query, release: () => undefined }),
    } as unknown as Pool
    const config = readWorkerConfig({
      ...process.env,
      NODE_ENV: 'test',
      WORKER_ROLE: 'scan',
      WORKER_WORKSPACES: 'ws_fixture',
      WORKER_ONCE: 'true',
      WORKER_METRICS_PORT: '0',
      DATABASE_URL: 'postgres://fixture.invalid/worker',
      WORKER_API_BASE_URL: 'https://api.fixture.invalid',
      WORKER_API_TOKEN: 'fixture-worker-token',
      WORKER_API_SIGNING_SECRET: 'fixture-worker-secret',
    })

    vi.stubEnv('WORKER_READY_FILE', readyFile)
    vi.stubEnv('REDIS_URL', '')
    vi.stubEnv('HOSTNAME', 'scan-fixture')
    vi.stubEnv('ASSET_SCANNER_API_TOKEN', 'fixture-scanner-token')
    vi.stubEnv('ASSET_SCANNER_WORKSPACE_SIGNING_SECRET', 'fixture-scanner-secret')
    vi.stubEnv('ASSET_SCAN_RECEIPT_PRIVATE_KEY_PEM_B64', Buffer.from('fixture-private-key').toString('base64'))
    vi.stubEnv('ASSET_SCAN_RECEIPT_KEY_ID', 'fixture-key')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { persistence: { ready: true }, redis: { ready: true } } }), { status: 200, headers: { 'content-type': 'application/json' } })))

    try {
      await runWorker(config, pool, {
        redisQueueConnectionFactory: async () => ({
          transport: { push: async () => undefined, pop: async () => undefined },
          scannerHeartbeat: {
            publish,
            remove,
            lastCallbackAcceptedAt: async () => undefined,
            recordCallbackAccepted: async () => undefined,
          },
          close,
        }) as unknown as Awaited<ReturnType<NonNullable<NonNullable<Parameters<typeof runWorker>[2]>['redisQueueConnectionFactory']>>>,
        clamavScannerFactory: () => ({
          ping: async () => undefined,
          version: async () => 'ClamAV 1.4.2/28108/Oct 10 00:00:00 2026',
          scan: async () => ({ status: 'infected', target: 'stream', signature: 'Eicar-Test-Signature', raw: 'stream: Eicar-Test-Signature FOUND' }),
        }),
      })

      expect(publish).toHaveBeenCalled()
      expect(readyDuringLoop).toBeDefined()
      expect(JSON.parse(readyDuringLoop!)).toMatchObject({ role: 'scan', heartbeat: { recoveryCapable: true } })
      expect(heartbeats.size).toBe(0)
      expect(remove).toHaveBeenCalledWith('scan-fixture')
      expect(close).toHaveBeenCalledTimes(1)
      await expect(readFile(readyFile)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
})
