import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { MigrationRunner, migrationChecksum, type Migration } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

describe('migration name/checksum release verifier', () => {
  postgresIt('upgrades a legacy schema_migrations table and blocks checksum tampering', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_migration_integrity_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    const migrations: Migration[] = [
      { version: 1, name: 'initial', sql: 'SELECT 1' },
      { version: 2, name: 'second', sql: 'SELECT 2' },
    ]
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const isolated = new URL(base)
      isolated.pathname = `/${databaseName}`
      database = new Pool({ connectionString: isolated.toString() })
      await database.query('CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())')
      await database.query("INSERT INTO schema_migrations (version, name) VALUES (1, 'initial')")

      await expect(new MigrationRunner(database, migrations).run()).resolves.toEqual([2])
      expect((await database.query<{ checksum: string | null }>('SELECT checksum FROM schema_migrations WHERE version = 1')).rows[0]?.checksum).toBe(migrationChecksum(migrations[0]!.sql))
      expect((await database.query<{ checksum: string | null }>('SELECT checksum FROM schema_migrations WHERE version = 2')).rows[0]?.checksum).toBe(migrationChecksum(migrations[1]!.sql))

      await database.query("UPDATE schema_migrations SET checksum = repeat('0', 64) WHERE version = 1")
      await expect(new MigrationRunner(database, migrations).run()).rejects.toMatchObject({ code: 'MIGRATION_CHECKSUM_MISMATCH', version: 1 })
    } finally {
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
