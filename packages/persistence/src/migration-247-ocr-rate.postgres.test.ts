import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'
import { loadMigrations, MigrationRunner } from './migration.js'
import { PostgresCommercialCatalogRepository } from './commercial-catalog-repository.js'
import { PostgresCreativePointRepository } from './creative-point-repository.js'
import { PostgresCreativePointLifecycleRepository } from './creative-point-lifecycle-repository.js'
import { decideOcrPointFinalization, OCR_COST_POINT_POLICY_VERSION, OCR_FREE_THRESHOLD_POINT_POLICY_VERSION } from '../../application/src/ocr-point-lifecycle.js'

const databaseUrl = process.env.PERSISTENCE_RELEASE_DATABASE_URL
  ?? 'postgres://merchant:merchant_local_only@127.0.0.1:54329/merchant'

describe('migration 248 OCR free threshold rate', () => {
  it('publishes v4 while preserving historical v3 OCR and fixed v2 rates', async () => {
    const admin = new Pool({ connectionString: databaseUrl })
    const databaseName = `release_fresh_${randomUUID().replaceAll('-', '')}`
    let database: Pool | undefined
    let app: Pool | undefined
    let primaryFailure: unknown
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const isolated = new URL(databaseUrl)
      isolated.pathname = `/${databaseName}`
      database = new Pool({ connectionString: isolated.toString() })
      await database.query(await readFile(new URL('../../../infra/local/ensure-app-role.sql', import.meta.url), 'utf8'))
      const migrations = await loadMigrations()
      expect(migrations.at(-1)?.version).toBeGreaterThanOrEqual(248)
      const applied = await new MigrationRunner(database, migrations).run()
      expect(applied.at(-1)).toBe(migrations.at(-1)?.version)

      const catalog = new PostgresCommercialCatalogRepository(database)
      const ocr = await catalog.resolveApprovedOcrCostRate()
      expect(ocr).toMatchObject({
        rateCardId: 'rate-card-ocr-free-threshold-v4', version: 4, actionCode: 'ocr.extract',
        pricingMode: 'variable', variableFormula: {
          kind: 'cost_cny_threshold_x2_ceil_v1', free_when_cost_cny_lte: 0.3,
          multiplier: 2, min_paid_points: 1,
        },
      })
      expect(await catalog.resolveApprovedRate('text.generate')).toMatchObject({ integerPoints: 1, version: 2 })
      for (const id of ['rate-card-ocr-cost-v3', 'rate-card-ocr-free-threshold-v4']) {
        const events = await database.query<{ count: number }>(`SELECT count(*)::int AS count FROM commercial_catalog_events_v2 WHERE aggregate_id=$1 AND event_type='published'`, [id])
        expect(events.rows[0]?.count).toBe(1)
      }
      const workspaceId = `ws_ocr_pg_${randomUUID().replaceAll('-', '')}`
      await database.query('INSERT INTO workspaces (id,status) VALUES ($1,$2)', [workspaceId, 'active'])
      const appUrl = new URL(isolated)
      appUrl.username = 'merchant_app'
      appUrl.password = 'merchant_app_local_only'
      app = new Pool({ connectionString: appUrl.toString() })
      const points = new PostgresCreativePointRepository(app)
      const lifecycle = new PostgresCreativePointLifecycleRepository(app)
      await points.grant({ workspaceId, idempotencyKey: 'ocr-pg-grant', sourceType: 'paid_order', sourceId: 'ocr-pg-order', points: 5 })

      const settleReceipt = async (actionKey: string, rateCardVersion: string, costCny: number, policyVersion: typeof OCR_COST_POINT_POLICY_VERSION | typeof OCR_FREE_THRESHOLD_POINT_POLICY_VERSION) => {
        const reservation = (await points.reserve({ workspaceId, actionKey, idempotencyKey: `reserve:${actionKey}`, points: 4, rateCardVersion })).value
        expect((await points.getBalance(workspaceId)).availablePoints).toBe(1)
        const providerRequestId = `relay-${actionKey}`
        const usage = { modality: 'ocr', model: 'vision-ocr', input_tokens: 172, output_tokens: 28, total_tokens: 200 }
        const cost = { currency: 'CNY', actual: costCny }
        const receiptHash = createHash('sha256').update(JSON.stringify({ providerRequestId, usage, cost, rateCardVersion })).digest('hex')
        await lifecycle.recordProviderReceipt({ workspaceId, operationId: reservation.operationId, provider: 'model-relay', providerRequestId, outcome: 'succeeded', usage, cost, receiptHash, verifiedAt: new Date().toISOString(), at: new Date().toISOString() })
        expect(await lifecycle.getProviderReceipt({ workspaceId, operationId: reservation.operationId, provider: 'model-relay', providerRequestId })).toMatchObject({ outcome: 'succeeded', usage, cost })
        const decision = decideOcrPointFinalization({ reservedPoints: 4, providerOutcome: 'succeeded', verifiedReceipt: true, actualCostCny: costCny, policyVersion })
        expect(decision.action).toBe('settle')
        if (decision.action !== 'settle') throw new Error('OCR receipt was not settleable')
        return points.settle({ workspaceId, reservationId: reservation.id, idempotencyKey: `settle:${actionKey}`, actualPoints: decision.actualPoints, metadata: { provider_request_id: providerRequestId, receipt_hash: receiptHash, cost_cny: costCny, rate_card_version: rateCardVersion } })
      }

      const free = await settleReceipt('ocr-v4-free', `${OCR_FREE_THRESHOLD_POINT_POLICY_VERSION}:${ocr.rateCardId}:${ocr.version}:${ocr.checksum}`, 0.3, OCR_FREE_THRESHOLD_POINT_POLICY_VERSION)
      expect(free.value).toMatchObject({ status: 'settled', points: 4, settledPoints: 0 })
      expect(free.balance).toMatchObject({ availablePoints: 5, reservedPoints: 0, settledPoints: 0 })
      const historicalRate = await database.query<{ checksum: string }>(`SELECT checksum FROM creative_point_rate_card_versions_v2 WHERE id='rate-card-ocr-cost-v3'`)
      const historical = await settleReceipt('ocr-v3-paid', `${OCR_COST_POINT_POLICY_VERSION}:rate-card-ocr-cost-v3:3:${historicalRate.rows[0]!.checksum}`, 0.1, OCR_COST_POINT_POLICY_VERSION)
      expect(historical.value).toMatchObject({ status: 'settled', points: 4, settledPoints: 1 })
      expect(historical.balance).toMatchObject({ availablePoints: 4, reservedPoints: 0, settledPoints: 1 })
      await expect(database.query(`UPDATE creative_point_rate_rules_v2 SET variable_formula='{}'::jsonb WHERE id='rate-ocr-extract-cost-v3'`)).rejects.toThrow()
      await expect(database.query(`INSERT INTO creative_point_rate_rules_v2 (id,rate_card_version_id,action_code,unit,integer_points,pricing_mode,variable_formula,executable,blockers) VALUES ('invalid-variable','rate-card-ocr-cost-v3','text.generate','request',NULL,'variable','{"kind":"cost_cny_x2_ceil_min1"}'::jsonb,true,'[]'::jsonb)`)).rejects.toThrow()
    } catch (error) {
      primaryFailure = error
      throw error
    } finally {
      await withPostgresFixtureCleanup(async () => {
        await app?.end()
        await database?.end()
        await dropDrainedPostgresFixture(admin, databaseName)
      }, primaryFailure, [() => admin.end()])
    }
  }, 240_000)
})
