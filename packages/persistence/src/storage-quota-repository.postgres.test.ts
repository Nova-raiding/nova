import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { loadMigrations, MigrationRunner } from './migration.js'
import { PostgresStorageQuotaRepository, StorageQuotaExceededError } from './storage-quota-repository.js'

const databaseUrl = process.env.STORAGE_QUOTA_DATABASE_URL ?? process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrl ? it : it.skip

describe('PostgresStorageQuotaRepository', () => {
  postgresIt('serializes workspace reservations and keeps settle replay idempotent', async () => {
    const admin = new Pool({ connectionString: databaseUrl, max: 4 })
    const appUrl = new URL(databaseUrl!)
    appUrl.username = process.env.STORAGE_QUOTA_APP_DATABASE_USER ?? 'merchant_app'
    appUrl.password = process.env.STORAGE_QUOTA_APP_DATABASE_PASSWORD ?? 'merchant_app_local_only'
    const pool = new Pool({ connectionString: appUrl.toString(), max: 4 })
    const workspaceId = `ws_storage_${randomUUID()}`
    try {
      await new MigrationRunner(admin, await loadMigrations()).run()
      await admin.query('INSERT INTO workspaces (id,status) VALUES ($1,$2)', [workspaceId, 'active'])
      const repository = new PostgresStorageQuotaRepository(pool)
      const common = { workspaceId, assetId: 'asset_1', bytes: 60, limitBytes: 100, at: '2026-08-29T01:00:00.000Z' }
      const outcomes = await Promise.allSettled([
        repository.reserve({ ...common, reservationKey: 'upload-a' }),
        repository.reserve({ ...common, reservationKey: 'upload-b' }),
      ])
      expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(outcomes.find(result => result.status === 'rejected')).toMatchObject({ status: 'rejected', reason: expect.any(StorageQuotaExceededError) })

      const winner = outcomes.find(result => result.status === 'fulfilled')
      if (!winner || winner.status !== 'fulfilled') throw new Error('expected one reservation winner')
      const settled = await repository.settle({ workspaceId, reservationKey: winner.value.reservation.reservationKey, actualBytes: 40, at: common.at })
      expect(settled).toMatchObject({ reservation: { status: 'settled', actualBytes: 40 }, snapshot: { usedBytes: 40, reservedBytes: 0 } })
      await expect(repository.settle({ workspaceId, reservationKey: winner.value.reservation.reservationKey, actualBytes: 40, at: common.at }))
        .resolves.toMatchObject({ reservation: { status: 'settled' }, snapshot: { usedBytes: 40, reservedBytes: 0 } })
      await expect(repository.release({ workspaceId, reservationKey: winner.value.reservation.reservationKey, at: common.at }))
        .rejects.toThrow('STORAGE_QUOTA_SETTLED_RELEASE_REQUIRES_PHYSICAL_DELETION')
      await expect(repository.releaseAfterPhysicalDeletion({ workspaceId, reservationKey: winner.value.reservation.reservationKey, receipt: { objectKey: `clean/${workspaceId}/asset_1.bin`, deletedAt: common.at, verification: 'delete_ack' }, at: common.at }))
        .resolves.toMatchObject({ status: 'released', reservedBytes: 0 })
      await expect(repository.reserve({ ...common, reservationKey: 'after-delete', assetId: 'asset-after-delete', bytes: 100 }))
        .resolves.toMatchObject({ reused: false, snapshot: { usedBytes: 0, reservedBytes: 0 } })
    } finally {
      await pool.end()
      await admin.end()
    }
  }, 60_000)
})
