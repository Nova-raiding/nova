import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'
import { loadMigrations, MigrationRunner, verifyBridgeMigrationPrefix } from './migration.js'
import { PostgresCommercialCatalogRepository } from './commercial-catalog-repository.js'

const databaseUrl = process.env.PERSISTENCE_RELEASE_DATABASE_URL

describe('242-to-254 forward migration SQL on isolated PostgreSQL', () => {
  it('applies real migration SQL one version at a time and keeps the bridge gate closed in intermediate states', async () => {
    const base = new URL(databaseUrl!)
    const name = `release_fresh_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString(), max: 2 })
    let database: Pool | undefined
    let primaryFailure: unknown
    try {
      await admin.query(`CREATE DATABASE "${name}"`)
      const isolated = new URL(base)
      isolated.pathname = `/${name}`
      database = new Pool({ connectionString: isolated.toString(), max: 2 })
      await database.query(await readFile(new URL('../../../infra/local/ensure-app-role.sql', import.meta.url), 'utf8'))

      const migrations = await loadMigrations()
      expect(migrations.map(item => item.version)).toHaveLength(254)
      expect(migrations.at(-1)?.version).toBe(254)

      const historyAt = async (version: number) => {
        const result = await database!.query<{ version: number; name: string; checksum: string }>(
          'SELECT version,name,checksum FROM public.schema_migrations ORDER BY version ASC',
        )
        expect(result.rows).toHaveLength(version)
        expect(result.rows[0]?.version).toBe(1)
        expect(result.rows.at(-1)?.version).toBe(version)
        expect(result.rows.every((row, index) => Number(row.version) === index + 1 && /^[a-f0-9]{64}$/u.test(row.checksum))).toBe(true)
        return result.rows
      }

      // Start from a real SQL-created 242 prefix, then commit each migration
      // separately so every possible interrupted prefix is observed.
      const initial = await new MigrationRunner(database, migrations.slice(0, 242)).run()
      expect(initial.at(-1)).toBe(242)
      expect(verifyBridgeMigrationPrefix(await historyAt(242), migrations, 'prefix_242_or_254')).toBe(242)

      for (let version = 243; version <= 254; version += 1) {
        const applied = await new MigrationRunner(database, migrations.slice(0, version)).run()
        expect(applied).toContain(version)
        const history = await historyAt(version)
        if (version < 254) {
          expect(() => verifyBridgeMigrationPrefix(history, migrations, 'prefix_242_or_254')).toThrow('exactly 242 or 254')
        } else {
          expect(verifyBridgeMigrationPrefix(history, migrations, 'prefix_242_or_254')).toBe(254)
        }
      }

      // Re-running a completed forward migration set is idempotent and never
      // changes schema_migrations backwards.
      expect(await new MigrationRunner(database, migrations).run()).toEqual([])
      expect((await historyAt(254)).at(-1)?.version).toBe(254)

      const functions = await database.query<{ v2: string | null; v3: string | null }>(`
        SELECT to_regprocedure('public.merchant_entitlement_snapshots_v2(integer)')::text AS v2,
               to_regprocedure('public.merchant_entitlement_snapshots_v3(integer,timestamp with time zone,text)')::text AS v3
      `)
      expect(functions.rows[0]?.v2).toBe('merchant_entitlement_snapshots_v2(integer)')
      expect(functions.rows[0]?.v3).toBe('merchant_entitlement_snapshots_v3(integer,timestamp with time zone,text)')

      const ocr = await new PostgresCommercialCatalogRepository(database).resolveApprovedOcrCostRate()
      expect(ocr).toMatchObject({
        version: 4,
        pricingMode: 'variable',
        variableFormula: { kind: 'cost_cny_threshold_x2_ceil_v1', free_when_cost_cny_lte: 0.3 },
      })
    } catch (error) {
      primaryFailure = error
      throw error
    } finally {
      await withPostgresFixtureCleanup(async () => {
        await database?.end()
        await dropDrainedPostgresFixture(admin, name)
      }, primaryFailure, [() => admin.end()])
    }
  }, 300_000)
})
