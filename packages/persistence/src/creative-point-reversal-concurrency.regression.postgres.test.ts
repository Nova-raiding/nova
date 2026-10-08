import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { PostgresCreativePointLifecycleRepository } from './creative-point-lifecycle-repository.js'
import { PostgresCreativePointRepository } from './creative-point-repository.js'
import { loadMigrations, MigrationRunner } from './migration.js'

const source = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = source ? it : it.skip

function databaseUrl(base: URL, name: string) {
  const url = new URL(base)
  url.pathname = `/${name}`
  return url.toString()
}

describe('creative-point reversal PostgreSQL concurrency regression', () => {
  postgresIt('serializes duplicate and competing reversals without over-refunding a settled reservation', async () => {
    const base = new URL(source!)
    const name = `point_reversal_race_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let db: Pool | undefined

    try {
      await admin.query(`CREATE DATABASE "${name}"`)
      db = new Pool({ connectionString: databaseUrl(base, name), max: 12 })
      await new MigrationRunner(db, await loadMigrations()).run()

      const workspaceId = `ws-${randomUUID()}`
      const reservationId = `reservation-${randomUUID()}`
      await db.query("INSERT INTO workspaces(id,status) VALUES($1,'active')", [workspaceId])
      const points = new PostgresCreativePointRepository(db)
      const lifecycle = new PostgresCreativePointLifecycleRepository(db)
      await points.grant({ workspaceId, idempotencyKey: `grant:${workspaceId}`, sourceType: 'test', sourceId: workspaceId, points: 20 })
      const reservation = (await points.reserve({
        workspaceId,
        idempotencyKey: `reserve:${workspaceId}`,
        actionKey: `image:${workspaceId}`,
        points: 10,
        rateCardVersion: 'test-v1',
      })).value
      expect(reservation.id).toBeTruthy()
      await points.settle({ workspaceId, reservationId: reservation.id, actualPoints: 10, idempotencyKey: `settle:${workspaceId}` })

      const reverse = (idempotencyKey: string, amount: number, reason: string) => lifecycle.reverseSettlement({
        workspaceId,
        reservationId: reservation.id,
        points: amount,
        kind: 'refund',
        idempotencyKey,
        actorId: 'finance-test',
        reason,
        evidence: { test_case: 'isolated-concurrent-reversal' },
        at: new Date().toISOString(),
      })

      const sameKey = await Promise.all([
        reverse('refund:same-key', 4, 'same-key replay'),
        reverse('refund:same-key', 4, 'same-key replay'),
      ])
      expect(sameKey[0]).toEqual(sameKey[1])
      expect(sameKey[0]).toMatchObject({ availablePoints: 14, settledPoints: 6 })

      const competing = await Promise.allSettled([
        reverse('refund:compete-a', 4, 'competing refund A'),
        reverse('refund:compete-b', 4, 'competing refund B'),
      ])
      expect(competing.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(competing.filter(result => result.status === 'rejected')).toHaveLength(1)
      const rejected = competing.find(result => result.status === 'rejected')
      expect(rejected).toMatchObject({ status: 'rejected', reason: { code: 'CREATIVE_POINT_INSUFFICIENT' } })
      expect(await points.getBalance(workspaceId)).toMatchObject({ availablePoints: 18, reservedPoints: 0, settledPoints: 2 })

      const reversals = await db.query<{ count: number; total: string }>(
        `SELECT count(*)::int AS count, sum(points)::text AS total
           FROM creative_point_reversals_v2
          WHERE workspace_id=$1 AND original_reservation_id=$2`,
        [workspaceId, reservation.id],
      )
      expect(reversals.rows[0]).toEqual({ count: 2, total: '8' })
    } finally {
      await db?.end()
      let active = 1
      for (let attempt = 0; attempt < 80 && active > 0; attempt += 1) {
        active = Number((await admin.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=$1', [name],
        )).rows[0]?.count ?? 0)
        if (active > 0) await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect(active, `isolated database clients did not close for ${name}`).toBe(0)
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`)
      await admin.end()
    }
  }, 180_000)
})
