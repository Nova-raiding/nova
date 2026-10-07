import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'
import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'
import { PostgresCatalogBatchImportIdempotencyRepository } from './catalog-batch-import-idempotency-repository.js'

const source = process.env.PERSISTENCE_RELEASE_DATABASE_URL
describe.skipIf(!source)('catalog batch import idempotency on isolated PostgreSQL', () => {
  const databaseName = `catalog_import_idem_${randomUUID().replaceAll('-', '')}`
  const workspaceA = `catalog-idem-a-${randomUUID()}`
  const workspaceB = `catalog-idem-b-${randomUUID()}`
  let admin: Pool | undefined
  let database: Pool | undefined
  let app: Pool | undefined
  let ops: Pool | undefined
  let repository: PostgresCatalogBatchImportIdempotencyRepository

  beforeAll(async () => {
    admin = new Pool({ connectionString: source!, connectionTimeoutMillis: 10000 })
    await admin.query(`CREATE DATABASE "${databaseName}"`)
    const url = new URL(source!); url.pathname = `/${databaseName}`
    database = new Pool({ connectionString: url.toString(), max: 6 })
    const roleSql = await readFile(new URL('../../../infra/local/ensure-app-role.sql', import.meta.url), 'utf8')
    await database.query(roleSql)
    await new MigrationRunner(database, await loadMigrations()).run()
    const appUrl = new URL(url); appUrl.username = 'merchant_app'; appUrl.password = 'merchant_app_local_only'
    app = new Pool({ connectionString: appUrl.toString(), max: 4 })
    const opsUrl = new URL(url); opsUrl.username = 'merchant_ops'; opsUrl.password = 'merchant_ops_local_only'
    ops = new Pool({ connectionString: opsUrl.toString(), max: 2 })
    repository = new PostgresCatalogBatchImportIdempotencyRepository(app)
    await database.query("INSERT INTO workspaces(id,status) VALUES($1,'active'),($2,'active')", [workspaceA, workspaceB])
  }, 120000)

  afterAll(async () => {
    await withPostgresFixtureCleanup(async () => {
      await app?.end(); await ops?.end(); await database?.end()
      if (admin) await dropDrainedPostgresFixture(admin, databaseName)
    }, undefined, [async () => { await admin?.end() }])
  }, 60000)

  it('serializes same-key claims, replays completed results, and isolates workspace and actor scopes', async () => {
    const base = { workspaceId: workspaceA, actorId: 'merchant-a', key: 'catalog-pg-replay-key', requestHash: 'a'.repeat(64) }
    const parallel = await Promise.all([repository.claim(base), repository.claim(base)])
    expect(parallel.map(result => result.kind).sort()).toEqual(['claimed', 'in_progress'])
    const owner = parallel.find(result => result.kind === 'claimed')!
    if (owner.kind !== 'claimed') throw new Error('expected one claim owner')
    await repository.start({ ...base, token: owner.token })
    await repository.complete({ ...base, token: owner.token, result: { batchId: 'pg-batch', count: 1 } })
    await expect(repository.claim(base)).resolves.toEqual({ kind: 'completed', result: { batchId: 'pg-batch', count: 1 } })
    await expect(repository.claim({ ...base, requestHash: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'PRODUCT_IMPORT_IDEMPOTENCY_CONFLICT' })
    expect((await repository.claim({ ...base, actorId: 'merchant-b' })).kind).toBe('claimed')
    expect((await repository.claim({ ...base, workspaceId: workspaceB })).kind).toBe('claimed')

    const recovery = { ...base, key: 'catalog-pg-recovery-key' }
    const staleOwner = await repository.claim(recovery)
    if (staleOwner.kind !== 'claimed') throw new Error('expected recovery claim')
    await repository.start({ ...recovery, token: staleOwner.token })
    await database!.query(`UPDATE catalog_batch_import_idempotency SET started_at=now()-interval '31 minutes' WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3`, [recovery.workspaceId, recovery.actorId, recovery.key])
    expect(await repository.claim(recovery)).toEqual({ kind: 'needs_reconciliation' })
    await repository.complete({ ...recovery, token: staleOwner.token, result: { batchId: 'recovered-pg-batch' } })
    expect(await repository.claim(recovery)).toEqual({ kind: 'completed', result: { batchId: 'recovered-pg-batch' } })

    const takeover = { ...base, key: 'catalog-pg-takeover-key' }
    const oldOwner = await repository.claim(takeover)
    if (oldOwner.kind !== 'claimed') throw new Error('expected takeover claim')
    await database!.query(`UPDATE catalog_batch_import_idempotency SET claim_expires_at=now()-interval '1 minute' WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3`, [takeover.workspaceId, takeover.actorId, takeover.key])
    const newOwner = await repository.claim(takeover)
    if (newOwner.kind !== 'claimed') throw new Error('expected expired claim takeover')
    await expect(repository.start({ ...takeover, token: oldOwner.token })).rejects.toMatchObject({ code: 'PRODUCT_IMPORT_IDEMPOTENCY_CLAIM_LOST' })
    await repository.start({ ...takeover, token: newOwner.token })
    await repository.markNeedsReconciliation({ ...takeover, token: newOwner.token })

    await expect(ops!.query('SELECT * FROM catalog_batch_import_idempotency')).rejects.toThrow()
    await expect(app!.query('SELECT * FROM catalog_batch_import_idempotency')).resolves.toMatchObject({ rows: [] })
  }, 90000)
})
