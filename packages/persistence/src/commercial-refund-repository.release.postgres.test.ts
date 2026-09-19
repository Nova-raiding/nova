import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { PostgresCommercialRefundRepository } from './commercial-refund-repository.js'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip
const connection = (base: URL, database: string): string => { const value = new URL(base); value.pathname = `/${database}`; return value.toString() }

const workspaceId = 'ws-refund-db'
const refundEvidence = JSON.stringify({ supplement_agreement_ref: 'SUP-DB-1' })

describe('commercial refund PostgreSQL cumulative bound', () => {
  postgresIt('never pays out more than the customer paid, in the repository and at the database', async () => {
    const base = new URL(databaseUrlValue!)
    const name = `commercial_refund_bound_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${name}"`)
      database = new Pool({ connectionString: connection(base, name) })
      await new MigrationRunner(database, await loadMigrations()).run()
      await database.query(`INSERT INTO workspaces(id,status) VALUES ($1,'active')`, [workspaceId])
      await database.query(`INSERT INTO commercial_catalog_skus(id,code,kind,visibility) VALUES ('sku-refund-db','refund_db','monthly','public')`)
      await database.query(`INSERT INTO commercial_catalog_sku_versions(id,sku_id,version,lifecycle,executable,price_fen,currency,price_mode,payload,checksum,effective_at) VALUES ('sku-refund-db-v1','sku-refund-db',1,'approved',true,500000,'CNY','fixed','{}'::jsonb,$1,'2026-09-01T00:00:00.000Z')`, ['a'.repeat(64)])
      for (const orderId of ['order-refund-a', 'order-refund-b', 'order-refund-c', 'order-refund-d']) {
        await database.query(`INSERT INTO commercial_orders_v2(id,workspace_id,sku_id,sku_version_id,amount_fen,currency,payment_provider,status,idempotency_key,request_hash,created_by_actor_id,paid_at) VALUES ($1,$2,'sku-refund-db','sku-refund-db-v1',500000,'CNY','alipay','paid',$3,$4,'actor-1',now())`, [orderId, workspaceId, `key-${orderId}`, 'b'.repeat(64)])
      }

      const repository = new PostgresCommercialRefundRepository(database)
      const chain = (requestId: string, orderId: string, amountFen = 500000) => ({
        request: { workspaceId, orderId, requestId, refundKind: 'monthly_unused_points' as const, amountFen, pointsToRevoke: 0, reason: '未使用月费点数', actorId: 'maker', evidence: JSON.parse(refundEvidence) as Record<string, unknown>, at: '2026-09-08T00:00:00.000Z' },
        approve: { workspaceId, requestId, actorId: 'finance', reason: 'approved', policyApproval: { legal_review_ref: 'LAW-DB-1' }, at: '2026-09-08T00:01:00.000Z' },
        complete: { workspaceId, requestId, actorId: 'finance', reason: 'external transfer confirmed', externalRefundId: `bank-${requestId}`, evidence: { provider: 'manual_transfer', receipt: 'R-DB-1' }, at: '2026-09-08T00:02:00.000Z' },
      })
      const first = chain('refund-a', 'order-refund-a')
      await expect(repository.request(first.request)).resolves.toMatchObject({ eventType: 'requested' })
      await expect(repository.approve(first.approve)).resolves.toMatchObject({ eventType: 'approved' })
      await expect(repository.complete(first.complete)).resolves.toMatchObject({ eventType: 'completed' })
      expect((await database.query<{ status: string }>(`SELECT status FROM commercial_orders_v2 WHERE id='order-refund-a'`)).rows[0]).toEqual({ status: 'refunded' })

      // Second chain for the same order: refused while the order is no longer payable.
      const second = chain('refund-b', 'order-refund-a')
      await expect(repository.request(second.request)).rejects.toMatchObject({ code: 'COMMERCIAL_REFUND_STATE_INVALID' })
      await expect(repository.complete(second.complete)).rejects.toMatchObject({ code: 'COMMERCIAL_REFUND_STATE_INVALID' })
      expect((await database.query<{ completed: number }>(`SELECT COALESCE(SUM(amount_fen),0)::int AS completed FROM commercial_refund_events_v2 WHERE workspace_id=$1 AND event_type='completed'`, [workspaceId])).rows[0]).toEqual({ completed: 500000 })

      // Two legal partial refunds on one paid order: 300000 + 200000 = 500000.
      // The first completion must leave the order 'paid' so the second approved
      // chain can still be completed; only the cumulative amount moves it to
      // the 'refunded' terminal state.
      const splitA = chain('refund-split-a', 'order-refund-c', 300000)
      const splitB = chain('refund-split-b', 'order-refund-c', 200000)
      await expect(repository.request(splitA.request)).resolves.toMatchObject({ eventType: 'requested' })
      await expect(repository.approve(splitA.approve)).resolves.toMatchObject({ eventType: 'approved' })
      await expect(repository.request(splitB.request)).resolves.toMatchObject({ eventType: 'requested' })
      await expect(repository.approve(splitB.approve)).resolves.toMatchObject({ eventType: 'approved' })
      await expect(repository.complete(splitA.complete)).resolves.toMatchObject({ eventType: 'completed' })
      expect((await database.query<{ status: string }>(`SELECT status FROM commercial_orders_v2 WHERE id='order-refund-c'`)).rows[0]).toEqual({ status: 'paid' })
      await expect(repository.complete(splitB.complete)).resolves.toMatchObject({ eventType: 'completed' })
      expect((await database.query<{ status: string }>(`SELECT status FROM commercial_orders_v2 WHERE id='order-refund-c'`)).rows[0]).toEqual({ status: 'refunded' })
      expect((await database.query<{ completed: number }>(`SELECT COALESCE(SUM(amount_fen),0)::int AS completed FROM commercial_refund_events_v2 WHERE workspace_id=$1 AND order_id='order-refund-c' AND event_type='completed'`, [workspaceId])).rows[0]).toEqual({ completed: 500000 })

      // Database backstop: a writer that bypasses the repository still cannot
      // approve a second chain past the paid amount of one order.
      // `pg`'s typed `query` overload requires a mutable array; a `readonly
      // unknown[]` parameter made the compiler pick the callback overload.
      const insertEvent = (values: unknown[]) => database!.query(
        `INSERT INTO commercial_refund_events_v2 (id,workspace_id,order_id,request_id,revision,event_type,refund_kind,amount_fen,points_to_revoke,reason,actor_id,evidence,external_refund_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'monthly_unused_points',$7,0,'未使用月费点数','maker',$8::jsonb,$9,'2026-09-08T00:03:00.000Z')`,
        values,
      )
      await insertEvent(['cre-db-c1', workspaceId, 'order-refund-b', 'refund-c', 1, 'requested', 300000, refundEvidence, null])
      await insertEvent(['cre-db-c2', workspaceId, 'order-refund-b', 'refund-c', 2, 'approved', 300000, JSON.stringify({ supplement_agreement_ref: 'SUP-DB-1', policy_approval: { legal_review_ref: 'LAW-DB-1' } }), null])
      await insertEvent(['cre-db-d1', workspaceId, 'order-refund-b', 'refund-d', 1, 'requested', 300000, refundEvidence, null])
      await expect(insertEvent(['cre-db-d2', workspaceId, 'order-refund-b', 'refund-d', 2, 'approved', 300000, JSON.stringify({ supplement_agreement_ref: 'SUP-DB-1', policy_approval: { legal_review_ref: 'LAW-DB-1' } }), null])).rejects.toMatchObject({ code: '23514' })

      // Completing the first chain is still allowed: its own approved revision
      // is not counted twice, and the order is still paid.
      await expect(insertEvent(['cre-db-c3', workspaceId, 'order-refund-b', 'refund-c', 3, 'completed', 300000, JSON.stringify({ supplement_agreement_ref: 'SUP-DB-1', policy_approval: { legal_review_ref: 'LAW-DB-1' }, completion: { provider: 'manual_transfer' } }), 'bank-db-c'])).resolves.toBeDefined()

      // A completed refund against an order that already left 'paid' is refused as well.
      await expect(insertEvent(['cre-db-e3', workspaceId, 'order-refund-a', 'refund-e', 3, 'completed', 1, JSON.stringify({ supplement_agreement_ref: 'SUP-DB-1', policy_approval: { legal_review_ref: 'LAW-DB-1' }, completion: { provider: 'manual_transfer' } }), 'bank-db-e'])).rejects.toMatchObject({ code: '23514' })

      // The bypass 220 allowed: appending a cheaper non-money revision to an
      // approved request used to erase that request's money from the bound, so
      // a second full-amount chain could be approved and paid out too
      // (paid = 500000 while completed = 1000000). The bound is now the largest
      // amount each request was ever approved/completed for, which an
      // append-only table can only raise.
      const committedOrderD = async () => (await database!.query<{ committed: number }>(
        `SELECT COALESCE(SUM(chain.amount_fen),0)::int AS committed
           FROM (SELECT request_id, MAX(amount_fen) AS amount_fen FROM commercial_refund_events_v2
                  WHERE workspace_id=$1 AND order_id='order-refund-d' AND event_type IN ('approved','completed')
                  GROUP BY request_id) chain`,
        [workspaceId],
      )).rows[0]!.committed
      await insertEvent(['cre-db-f1', workspaceId, 'order-refund-d', 'refund-f', 1, 'requested', 500000, refundEvidence, null])
      await insertEvent(['cre-db-f2', workspaceId, 'order-refund-d', 'refund-f', 2, 'approved', 500000, JSON.stringify({ supplement_agreement_ref: 'SUP-DB-1', policy_approval: { legal_review_ref: 'LAW-DB-1' } }), null])
      await expect(insertEvent(['cre-db-f3', workspaceId, 'order-refund-d', 'refund-f', 3, 'requested', 1, refundEvidence, null])).resolves.toBeDefined()
      await expect(insertEvent(['cre-db-f4', workspaceId, 'order-refund-d', 'refund-f', 4, 'completed', 500000, JSON.stringify({ supplement_agreement_ref: 'SUP-DB-1', completion: { provider: 'manual_transfer' } }), 'bank-db-f'])).resolves.toBeDefined()
      await expect(insertEvent(['cre-db-f5', workspaceId, 'order-refund-d', 'refund-f', 5, 'requested', 1, refundEvidence, null])).resolves.toBeDefined()
      // The approved 500000 of chain f survives every later non-money revision.
      expect(await committedOrderD()).toBe(500000)
      await insertEvent(['cre-db-g1', workspaceId, 'order-refund-d', 'refund-g', 1, 'requested', 500000, refundEvidence, null])
      await expect(insertEvent(['cre-db-g2', workspaceId, 'order-refund-d', 'refund-g', 2, 'approved', 500000, JSON.stringify({ supplement_agreement_ref: 'SUP-DB-1', policy_approval: { legal_review_ref: 'LAW-DB-1' } }), null])).rejects.toMatchObject({ code: '23514' })
      expect(await committedOrderD()).toBe(500000)
      expect((await database.query<{ completed: number }>(`SELECT COALESCE(SUM(amount_fen),0)::int AS completed FROM commercial_refund_events_v2 WHERE workspace_id=$1 AND order_id='order-refund-d' AND event_type='completed'`, [workspaceId])).rows[0]).toEqual({ completed: 500000 })

      // One row per request at its highest revision: the completed chain is
      // not counted a second time next to its own approved revision.
      const committed = (await database.query<{ committed: number }>(
        `SELECT COALESCE(SUM(latest.amount_fen),0)::int AS committed
           FROM (SELECT DISTINCT ON (request_id) request_id,event_type,amount_fen FROM commercial_refund_events_v2 WHERE workspace_id=$1 AND order_id='order-refund-b' ORDER BY request_id, revision DESC) latest
          WHERE latest.event_type IN ('approved','completed')`,
        [workspaceId],
      )).rows[0]!.committed
      expect(committed).toBe(300000)
    } finally {
      await database?.end()
      let active = 1
      for (let attempt = 0; attempt < 80 && active > 0; attempt += 1) {
        active = Number((await admin.query<{ count: string }>('SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=$1', [name])).rows[0]?.count ?? 0)
        if (active > 0) await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect(active, `database clients did not close for ${name}`).toBe(0)
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`)
      await admin.end()
    }
  }, 240_000)
})
