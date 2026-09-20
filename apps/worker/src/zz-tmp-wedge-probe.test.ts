import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Pool } from 'pg'

/**
 * SCRATCH PROBE (not part of the suite; deleted after the run).
 *
 * Question: with the queue socket blackholed (every Redis command never
 * answers) but the DB/API dependencies healthy, does the ready file stay
 * absent long enough for the probes to restart the pod - which is what
 * `redis-operation-budget.test.ts` and the `READY_FILE_HEARTBEAT_MS` comment
 * claim the Redis budget achieves?
 */
vi.mock('redis', () => {
  const never = () => new Promise(() => undefined)
  const client = Object.assign(Object.create(null), {
    on: () => client,
    connect: async () => undefined,
    close: async () => undefined,
    quit: async () => 'OK',
    destroy: () => undefined,
    eval: never,
    get: never,
    set: never,
    zAdd: never,
    lLen: never,
    zCard: never,
    hExists: never,
    multi: () => ({ set: () => undefined, exec: never }),
  })
  return { createClient: () => client }
})

describe('scratch: wedged queue vs ready-file probe', () => {
  it('samples the ready marker while the poll keeps failing on a blackholed redis socket', async () => {
    const { readWorkerConfig, runWorker } = await import('./main.js')
    const { loadMigrations } = await import('../../../packages/persistence/src/index.js')
    const directory = await mkdtemp(join(tmpdir(), 'wedge-probe-'))
    const readyFile = join(directory, 'ready')
    const migrations = await loadMigrations()
    const previous = { ready: process.env.WORKER_READY_FILE, redis: process.env.REDIS_URL }
    process.env.WORKER_READY_FILE = readyFile
    process.env.REDIS_URL = 'redis://127.0.0.1:6399'
    // Healthy dependencies: the migration inventory is complete, the API is not
    // configured (so no health fetch happens), and no queue work ever answers.
    const pool = {
      async query(sql: string) {
        if (/schema_migrations/u.test(sql)) return { rows: migrations.map(migration => ({ version: migration.version, name: migration.name })) }
        return { rows: [] }
      },
      async connect() {
        return { async query() { return { rows: [] } }, release: () => undefined }
      },
    } as unknown as Pool
    const config = readWorkerConfig({
      NODE_ENV: 'test', WORKER_ROLE: 'publish', WORKER_WORKSPACES: 'ws_a', WORKER_METRICS_PORT: '0',
      WORKER_POLL_INTERVAL_MS: '1000', WORKER_DEPENDENCY_CHECK_INTERVAL_MS: '1000',
      DATABASE_URL: 'postgres://worker@127.0.0.1:9/worker', REDIS_URL: process.env.REDIS_URL,
    })
    const running = runWorker(config, pool)
    const samples: Array<{ at: number; present: boolean; ageMs: number; document?: string }> = []
    const startedAt = Date.now()
    let bestAbsentRun = 0
    let currentAbsentRun = 0
    while (Date.now() - startedAt < 15_000) {
      const info = await stat(readyFile).then(value => ({ present: true, ageMs: Date.now() - value.mtimeMs }), () => ({ present: false, ageMs: Number.NaN }))
      const document = info.present ? await readFile(readyFile, 'utf8').catch(() => undefined) : undefined
      samples.push({ at: Date.now() - startedAt, ...info, ...(document !== undefined ? { document } : {}) })
      if (info.present) currentAbsentRun = 0
      else { currentAbsentRun += 250; bestAbsentRun = Math.max(bestAbsentRun, currentAbsentRun) }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    const documents = [...new Set(samples.filter(sample => sample.document !== undefined).map(sample => String(sample.document)))]
    // eslint-disable-next-line no-console
    console.log('DOCUMENTS OBSERVED ON DISK:', JSON.stringify(documents.slice(0, 3), null, 0))
    running.catch(() => undefined)
    const present = samples.filter(sample => sample.present).length
    const ratio = present / samples.length
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      samples: samples.length,
      present,
      presentRatio: Number(ratio.toFixed(3)),
      longestAbsentRunMs: bestAbsentRun,
      freshestAgeMs: Math.min(...samples.filter(sample => sample.present).map(sample => sample.ageMs)),
      timeline: samples.map(sample => `${sample.present ? 'E' : '.'}`).join(''),
    }))
    if (previous.ready === undefined) delete process.env.WORKER_READY_FILE
    else process.env.WORKER_READY_FILE = previous.ready
    if (previous.redis === undefined) delete process.env.REDIS_URL
    else process.env.REDIS_URL = previous.redis
    // Report-only: leave the observation visible in the run output.
    expect(present).toBeGreaterThan(-1)
  }, 60_000)
})
