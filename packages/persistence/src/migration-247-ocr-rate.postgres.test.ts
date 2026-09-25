import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'
import { loadMigrations, MigrationRunner } from './migration.js'
import { PostgresCommercialCatalogRepository } from './commercial-catalog-repository.js'

const databaseUrl = process.env.PERSISTENCE_RELEASE_DATABASE_URL
  ?? 'postgres://merchant:merchant_local_only@127.0.0.1:54329/merchant'

describe('migration 247 OCR cost rate', () => {
  it('publishes a separate immutable OCR formula and keeps fixed v2 rates executable', async () => {
    const admin = new Pool({ connectionString: databaseUrl })
    const databaseName = `release_fresh_${randomUUID().replaceAll('-', '')}`
    let database: Pool | undefined
    let failure: unknown
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const isolated = new URL(databaseUrl)
      isolated.pathname = `/${databaseName}`
      database = new Pool({ connectionString: isolated.toString() })
      await database.query(await readFile(new URL('../../../infra/local/ensure-app-role.sql', import.meta.url), 'utf8'))
      const migrations = await loadMigrations()
      expect(migrations.at(-1)?.version).toBeGreaterThanOrEqual(247)
      const applied = await new MigrationRunner(database, migrations).run()
      expect(applied.at(-1)).toBe(migrations.at(-1)?.version)

      const catalog = new PostgresCommercialCatalogRepository(database)
      const ocr = await catalog.resolveApprovedOcrCostRate()
      expect(ocr).toMatchObject({
        rateCardId: 'rate-card-ocr-cost-v3', version: 3, actionCode: 'ocr.extract',
        pricingMode: 'variable', variableFormula: { kind: 'cost_cny_x2_ceil_min1' },
      })
      expect(await catalog.resolveApprovedRate('text.generate')).toMatchObject({ integerPoints: 1, version: 2 })
      const events = await database.query<{ count: number }>(`SELECT count(*)::int AS count FROM commercial_catalog_events_v2 WHERE aggregate_id='rate-card-ocr-cost-v3' AND event_type='published'`)
      expect(events.rows[0]?.count).toBe(1)
      await expect(database.query(`UPDATE creative_point_rate_rules_v2 SET variable_formula='{}'::jsonb WHERE id='rate-ocr-extract-cost-v3'`)).rejects.toThrow()
      await expect(database.query(`INSERT INTO creative_point_rate_rules_v2 (id,rate_card_version_id,action_code,unit,integer_points,pricing_mode,variable_formula,executable,blockers) VALUES ('invalid-variable','rate-card-ocr-cost-v3','text.generate','request',NULL,'variable','{"kind":"cost_cny_x2_ceil_min1"}'::jsonb,true,'[]'::jsonb)`)).rejects.toThrow()
    } catch (error) {
      failure = error
      throw error
    } finally {
      await withPostgresFixtureCleanup(async () => {
        await database?.end()
        await dropDrainedPostgresFixture(admin, databaseName)
      }, failure, [() => admin.end()])
    }
  }, 240_000)
})
