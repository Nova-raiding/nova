import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'
import { PostgresCommercialReceiptRepository } from './commercial-receipt-repository.js'

const databaseUrl = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrl ? it : it.skip
const at = '2026-10-08T00:00:00.000Z'

describe('commercial receipt workspace read RLS regression', () => {
  postgresIt('scopes joined list and detail reads to the authenticated merchant workspace', async () => {
    // Regression: ISSUE-002 — no real merchant_app list/get read tested receipt+balance RLS across tenants.
    // Found by /qa on 2026-10-08.
    // Report: .gstack/qa-reports/qa-report-project-regression-2026-10-08.md
    const admin = new Pool({ connectionString: databaseUrl! })
    const name = `receipt_rls_${randomUUID().replaceAll('-', '')}`
    let migrationPool: Pool | undefined
    let merchant: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${name}"`)
      const connection = new URL(databaseUrl!)
      connection.pathname = `/${name}`
      migrationPool = new Pool({ connectionString: connection.toString() })
      await new MigrationRunner(migrationPool, await loadMigrations()).run()
      connection.username = 'merchant_app'
      connection.password = 'merchant_app_local_only'
      merchant = new Pool({ connectionString: connection.toString() })
      await migrationPool.query("INSERT INTO workspaces(id,status) VALUES('receipt-rls-a','active'),('receipt-rls-b','active')")

      const repository = new PostgresCommercialReceiptRepository(merchant)
      const record = (workspaceId: string, externalTradeId: string) => ({
        workspaceId,
        source: 'manual_transfer',
        receivingAccountRef: 'isolated-test-bank',
        externalTradeId,
        payerRef: `payer-${workspaceId}`,
        amountFen: 12345,
        currency: 'CNY' as const,
        receivedAt: at,
        verifiedAt: at,
        actorId: `finance-${workspaceId}`,
        evidence: { test_fixture: externalTradeId },
      })
      const receiptA = await repository.record(record('receipt-rls-a', 'rls-trade-a'))
      const receiptB = await repository.record(record('receipt-rls-b', 'rls-trade-b'))

      expect(await repository.list('receipt-rls-a')).toEqual([expect.objectContaining({ id: receiptA.id, workspaceId: 'receipt-rls-a' })])
      expect(await repository.list('receipt-rls-b')).toEqual([expect.objectContaining({ id: receiptB.id, workspaceId: 'receipt-rls-b' })])
      expect(await repository.get('receipt-rls-a', receiptA.id)).toMatchObject({ id: receiptA.id, workspaceId: 'receipt-rls-a' })
      expect(await repository.get('receipt-rls-b', receiptB.id)).toMatchObject({ id: receiptB.id, workspaceId: 'receipt-rls-b' })
      expect(await repository.get('receipt-rls-a', receiptB.id)).toBeNull()
      expect(await repository.get('receipt-rls-b', receiptA.id)).toBeNull()
    } finally {
      try {
        await merchant?.end()
        await migrationPool?.end()
        let active = 1
        for (let attempt = 0; attempt < 100 && active > 0; attempt += 1) {
          active = Number((await admin.query<{ count: string }>('SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=$1', [name])).rows[0]!.count)
          if (active > 0) await new Promise(resolve => setTimeout(resolve, 25))
        }
        expect(active, `owned database clients did not exit for ${name}`).toBe(0)
        await admin.query(`DROP DATABASE IF EXISTS "${name}"`)
      } finally {
        await admin.end()
      }
    }
  }, 60_000)
})
