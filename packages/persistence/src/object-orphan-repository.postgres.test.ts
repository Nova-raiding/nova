import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { loadMigrations, MigrationRunner } from './migration.js'
import { PostgresObjectOrphanRepository } from './object-orphan-repository.js'
import type { SqlPool } from './repository.js'

const databaseUrl = process.env.OBJECT_ORPHAN_DATABASE_URL ?? process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrl ? it : it.skip

describe('PostgresObjectOrphanRepository', () => {
  it('qualifies the target projection when claiming through an UPDATE FROM CTE', async () => {
    const statements: string[] = []
    const pool: SqlPool = { connect: async () => ({
      async query<Row>(sql: string) {
        statements.push(sql)
        return { rows: sql.includes('UPDATE object_storage_orphans AS orphan') ? [{ id: 'orphan_1' }] as Row[] : [] }
      },
      release() {},
    }) }
    const repository = new PostgresObjectOrphanRepository(pool)

    await expect(repository.claimPending('ws_1')).resolves.toEqual([{ id: 'orphan_1' }])
    const claim = statements.find(sql => sql.includes('UPDATE object_storage_orphans AS orphan'))
    expect(claim).toContain('RETURNING orphan.id, orphan.workspace_id')
    expect(claim).not.toMatch(/RETURNING id,/u)
  })

  it('resets next_attempt_at when a duplicate orphan is re-enqueued', async () => {
    const statements: string[] = []
    const pool: SqlPool = { connect: async () => ({
      async query<Row>(sql: string) {
        statements.push(sql)
        return { rows: sql.includes('INSERT INTO object_storage_orphans') ? [{ id: 'orphan_1', workspaceId: 'ws_1', objectKey: 'clean/ws_1/asset.png', state: 'pending', attempts: 2, nextAttemptAt: '2026-09-02T00:00:00.000Z' }] as Row[] : [] }
      },
      release() {},
    }) }
    const repository = new PostgresObjectOrphanRepository(pool)

    await expect(repository.enqueue({ workspaceId: 'ws_1', objectKey: 'clean/ws_1/asset.png', reason: 'new cleanup signal', lastError: 'retry now' })).resolves.toMatchObject({ id: 'orphan_1', state: 'pending' })
    const enqueue = statements.find(sql => sql.includes('INSERT INTO object_storage_orphans'))
    expect(enqueue).toContain("state='pending'")
    expect(enqueue).toContain('next_attempt_at=now()')
  })

  postgresIt('serializes claims, fences expired workers, and preserves workspace isolation', async () => {
    const base = new URL(databaseUrl!)
    const databaseName = `orphan_149_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString(), max: 4 })
    let database: Pool | undefined
    let appA: Pool | undefined
    let appB: Pool | undefined
    const workspaceA = `ws_orphan_a_${randomUUID()}`
    const workspaceB = `ws_orphan_b_${randomUUID()}`
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const isolated = new URL(base)
      isolated.pathname = `/${databaseName}`
      database = new Pool({ connectionString: isolated.toString(), max: 4 })
      const migrations = (await loadMigrations()).filter(item => item.version <= 149)
      expect(migrations.at(-1)?.version).toBe(149)
      expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(item => item.version))
      expect(await new MigrationRunner(database, migrations).run()).toEqual([])
      await database.query('INSERT INTO workspaces (id,status) VALUES ($1,$2),($3,$2)', [workspaceA, 'active', workspaceB])

      const appUrl = new URL(isolated)
      appUrl.username = process.env.OBJECT_ORPHAN_APP_DATABASE_USER ?? 'merchant_app'
      appUrl.password = process.env.OBJECT_ORPHAN_APP_DATABASE_PASSWORD ?? 'merchant_app_local_only'
      appA = new Pool({ connectionString: appUrl.toString(), max: 4 })
      appB = new Pool({ connectionString: appUrl.toString(), max: 4 })
      const repositoryA = new PostgresObjectOrphanRepository(appA)
      const repositoryB = new PostgresObjectOrphanRepository(appB)
      const queued = await repositoryA.enqueue({ workspaceId: workspaceA, objectKey: `clean/${workspaceA}/asset/source.png`, reason: 'metadata write failed' })

      const claims = await Promise.all([
        repositoryA.claimPending(workspaceA, { limit: 1, leaseMs: 1_000 }),
        repositoryB.claimPending(workspaceA, { limit: 1, leaseMs: 1_000 }),
      ])
      expect(claims.filter(rows => rows.length === 1)).toHaveLength(1)
      const first = claims.find(rows => rows.length === 1)?.[0]
      expect(first).toMatchObject({ id: queued.id, workspaceId: workspaceA })
      if (!first?.leaseToken) throw new Error('expected a lease token')

      await new Promise(resolve => setTimeout(resolve, 1_200))
      const takeover = await repositoryB.claimPending(workspaceA, { limit: 1, leaseMs: 1_000 })
      expect(takeover).toHaveLength(1)
      expect(takeover[0]).toMatchObject({ id: queued.id })
      expect(takeover[0]?.leaseToken).not.toBe(first.leaseToken)
      await expect(repositoryA.markCleaned({ workspaceId: workspaceA, id: queued.id, leaseToken: first.leaseToken })).rejects.toThrow('ORPHAN_LEASE_LOST')
      await expect(repositoryB.markCleaned({ workspaceId: workspaceA, id: queued.id, leaseToken: takeover[0]!.leaseToken })).resolves.toBeUndefined()
      expect(await repositoryB.listPending(workspaceA)).toEqual([])

      const delayed = await repositoryA.enqueue({ workspaceId: workspaceA, objectKey: `clean/${workspaceA}/asset/delayed.png`, reason: 'retry later' })
      const delayedClaim = await repositoryA.claimPending(workspaceA, { now: delayed.nextAttemptAt, leaseMs: 1_000 })
      const delayedLease = delayedClaim.find(row => row.id === delayed.id)?.leaseToken
      if (!delayedLease) throw new Error('expected a delayed lease token')
      await repositoryA.markRetry({
        workspaceId: workspaceA,
        id: delayed.id,
        leaseToken: delayedLease,
        error: 'manual review first',
        nextAttemptAt: '2026-09-03T00:00:00.000Z',
        manualAttention: true,
      })
      const requeued = await repositoryA.enqueue({ workspaceId: workspaceA, objectKey: `clean/${workspaceA}/asset/delayed.png`, reason: 'fresh cleanup event', lastError: 'retry now' })
      expect(requeued).toMatchObject({ id: delayed.id, state: 'pending' })
      expect(await repositoryA.claimPending(workspaceA, { now: requeued.nextAttemptAt, leaseMs: 1_000 })).toContainEqual(expect.objectContaining({ id: delayed.id }))

      await repositoryA.enqueue({ workspaceId: workspaceB, objectKey: `clean/${workspaceB}/asset/source.png`, reason: 'other workspace' })
      expect(await repositoryA.listPending(workspaceA)).toEqual([])
      expect(await repositoryA.listPending(workspaceB)).toHaveLength(1)
      await expect(repositoryA.claimPending('')).rejects.toThrow('workspace scope is required')
    } finally {
      await appA?.end()
      await appB?.end()
      await database?.end()
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 120_000)
})
