import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MigrationRunner, loadMigrations } from './migration.js'
import { PostgresUsageRepository } from './usage-repository.js'

const source = process.env.PERSISTENCE_RELEASE_DATABASE_URL

describe.skipIf(!source)('workspace usage consume concurrency PostgreSQL acceptance', () => {
  let admin: Pool
  let app: Pool
  let workspaceId: string

  beforeAll(async () => {
    admin = new Pool({ connectionString: source!, max: 4 })
    await new MigrationRunner(admin, await loadMigrations()).run()
    await admin.query(await readFile(new URL('../../../infra/local/ensure-app-role.sql', import.meta.url), 'utf8'))
    const appUrl = new URL(source!)
    appUrl.username = 'merchant_app'
    appUrl.password = 'merchant_app_local_only'
    app = new Pool({ connectionString: appUrl.toString(), max: 4 })
    workspaceId = `ws_usage_race_${randomUUID()}`
    await admin.query("INSERT INTO workspaces(id,status) VALUES($1,'active')", [workspaceId])
  }, 60_000)

  afterAll(async () => {
    await app?.end()
    await admin?.end()
  })

  it('replays a concurrent same-key consume once without surfacing a unique violation', async () => {
    const repository = new PostgresUsageRepository(app)
    const input = { workspaceId, taskId: 'task_usage_race', idempotencyKey: 'usage-race-key', actorId: 'actor_usage_race' }

    const results = await Promise.all([repository.consume(input), repository.consume(input)])

    // `charged` reports the durable charge state, including an idempotent
    // replay; it is not a per-call "new charge created" flag.
    expect(results.map(result => result.charged)).toEqual([true, true])
    expect(results[0]!.snapshot.usedTasks).toBe(1)
    expect(results[1]!.snapshot.usedTasks).toBe(1)
    expect((await admin.query('SELECT count(*)::int AS count FROM workspace_usage_ledger WHERE workspace_id=$1 AND idempotency_key=$2', [workspaceId, input.idempotencyKey])).rows[0]!.count).toBe(1)
    await expect(repository.consume({ ...input, taskId: 'task_other' })).rejects.toMatchObject({ code: 'USAGE_IDEMPOTENCY_CONFLICT' })
  }, 30_000)
})
