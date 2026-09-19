import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MIGRATION_BASELINE_ACCEPTED_ENV,
  MIGRATION_BASELINE_CHECKSUMS_ENV,
  MigrationRunner,
  migrationChecksum,
  type Migration,
} from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

/**
 * Each case gets its own scratch database, provisioned through the shared
 * release fixture naming contract so a failed run still drains and drops it.
 */
async function withScratchDatabase(body: (database: Pool) => Promise<void>): Promise<void> {
  const base = new URL(databaseUrlValue!)
  const databaseName = `release_migration_integrity_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: base.toString() })
  let database: Pool | undefined
  let primaryFailure: unknown
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`)
    const isolated = new URL(base)
    isolated.pathname = `/${databaseName}`
    database = new Pool({ connectionString: isolated.toString() })
    await body(database)
  } catch (error) {
    primaryFailure = error
    throw error
  } finally {
    await withPostgresFixtureCleanup(async () => {
      await database?.end()
      await dropDrainedPostgresFixture(admin, databaseName)
    }, primaryFailure, [
      () => admin.end(),
    ])
  }
}

const legacyMigrations: Migration[] = [
  { version: 1, name: 'initial', sql: 'SELECT 1' },
  { version: 2, name: 'second', sql: 'SELECT 2' },
]

const BASELINE_ENV_KEYS = [MIGRATION_BASELINE_ACCEPTED_ENV, MIGRATION_BASELINE_CHECKSUMS_ENV] as const
let savedBaselineEnv: Array<[string, string | undefined]> = []

beforeEach(() => {
  savedBaselineEnv = BASELINE_ENV_KEYS.map(key => [key, process.env[key]])
})

afterEach(() => {
  for (const [key, value] of savedBaselineEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('migration name/checksum release verifier', () => {
  postgresIt('refuses to stamp a legacy row with no recorded checksum, then adopts it under an explicit release-anchored baseline', async () => {
    await withScratchDatabase(async (database) => {
      await database.query('CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())')
      await database.query("INSERT INTO schema_migrations (version, name) VALUES (1, 'initial')")

      // Fail closed: the row is unverifiable, so the deploy stops instead of
      // stamping the digest of whatever file is on disk.
      await expect(new MigrationRunner(database, legacyMigrations).run()).rejects.toMatchObject({
        code: 'MIGRATION_CHECKSUM_UNVERIFIED',
        version: 1,
      })
      const before = await database.query<{ checksum: string | null }>('SELECT checksum FROM schema_migrations WHERE version = 1')
      expect(before.rows[0]?.checksum).toBeNull()
      expect((await database.query('SELECT version FROM schema_migrations')).rowCount).toBe(1)

      // A baseline captured from a different artifact cannot unlock it either.
      process.env[MIGRATION_BASELINE_ACCEPTED_ENV] = 'true'
      process.env[MIGRATION_BASELINE_CHECKSUMS_ENV] = `1=${'0'.repeat(64)}`
      await expect(new MigrationRunner(database, legacyMigrations).run()).rejects.toMatchObject({
        code: 'MIGRATION_CHECKSUM_UNVERIFIED',
        version: 1,
      })

      // Pinned to the artifact actually being deployed, the operator's
      // approval is honoured and the row is adopted once.
      process.env[MIGRATION_BASELINE_CHECKSUMS_ENV] = `1=${migrationChecksum(legacyMigrations[0]!.sql)}`
      await expect(new MigrationRunner(database, legacyMigrations).run()).resolves.toEqual([2])
      const adopted = await database.query<{ version: number; checksum: string | null }>('SELECT version, checksum FROM schema_migrations ORDER BY version')
      expect(adopted.rows).toEqual([
        { version: 1, checksum: migrationChecksum(legacyMigrations[0]!.sql) },
        { version: 2, checksum: migrationChecksum(legacyMigrations[1]!.sql) },
      ])
    })
  }, 240_000)

  postgresIt('blocks checksum tampering of an already recorded migration', async () => {
    await withScratchDatabase(async (database) => {
      await database.query('CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())')
      await database.query("INSERT INTO schema_migrations (version, name) VALUES (1, 'initial')")
      process.env[MIGRATION_BASELINE_ACCEPTED_ENV] = 'true'
      process.env[MIGRATION_BASELINE_CHECKSUMS_ENV] = `1=${migrationChecksum(legacyMigrations[0]!.sql)}`
      await expect(new MigrationRunner(database, legacyMigrations).run()).resolves.toEqual([2])

      await database.query("UPDATE schema_migrations SET checksum = repeat('0', 64) WHERE version = 1")
      await expect(new MigrationRunner(database, legacyMigrations).run()).rejects.toMatchObject({ code: 'MIGRATION_CHECKSUM_MISMATCH', version: 1 })
    })
  }, 240_000)

  postgresIt('fails a non-transactional migration whose concurrent index build left an indisvalid index', async () => {
    const migrations: Migration[] = [
      { version: 1, name: 'initial', sql: 'CREATE TABLE cic_target (v integer)' },
      {
        version: 2,
        name: 'concurrent_index',
        sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS cic_target_v_idx ON cic_target (v)',
        transactional: false,
      },
    ]
    await withScratchDatabase(async (database) => {
      await expect(new MigrationRunner(database, [migrations[0]!]).run()).resolves.toEqual([1])

      // A concurrent build that died mid-flight leaves an indisvalid index
      // carrying the exact name migration 2 declares, so `IF NOT EXISTS` would
      // silently skip the rebuild on every later attempt.
      await database.query('CREATE TABLE cic_duplicate_source (v integer)')
      await database.query('INSERT INTO cic_duplicate_source VALUES (1), (1)')
      await expect(database.query('CREATE UNIQUE INDEX CONCURRENTLY cic_target_v_idx ON cic_duplicate_source (v)')).rejects.toThrow(/duplicated|unique/u)
      const planted = await database.query<{ indisvalid: boolean }>(
        'SELECT i.indisvalid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname = $1',
        ['cic_target_v_idx'],
      )
      expect(planted.rows[0]?.indisvalid).toBe(false)

      await expect(new MigrationRunner(database, migrations).run()).rejects.toMatchObject({
        code: 'MIGRATION_CONCURRENT_INDEX_INVALID',
        version: 2,
      })
      expect((await database.query('SELECT version FROM schema_migrations WHERE version = 2')).rowCount).toBe(0)
      const stillInvalid = await database.query<{ indisvalid: boolean }>(
        'SELECT i.indisvalid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname = $1',
        ['cic_target_v_idx'],
      )
      expect(stillInvalid.rows[0]?.indisvalid).toBe(false)

      // The documented repair: drop the invalid index and redeploy.
      await database.query('DROP TABLE cic_duplicate_source CASCADE')
      await expect(new MigrationRunner(database, migrations).run()).resolves.toEqual([2])
      const repaired = await database.query<{ indisvalid: boolean }>(
        'SELECT i.indisvalid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname = $1 AND pg_table_is_visible(c.oid)',
        ['cic_target_v_idx'],
      )
      expect(repaired.rows[0]?.indisvalid).toBe(true)
    })
  }, 240_000)
})
