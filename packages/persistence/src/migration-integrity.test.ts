import { describe, expect, it } from 'vitest'
import { MigrationIntegrityError, MigrationRunner, migrationChecksum, verifyAppliedMigrations, type AppliedMigration, type Migration } from './migration.js'
import type { SqlClient, SqlPool } from './repository.js'

const migrations: Migration[] = [
  { version: 1, name: 'initial', sql: 'CREATE TABLE first_table (id integer)' },
  { version: 2, name: 'second', sql: 'CREATE TABLE second_table (id integer)' },
]

class IntegrityClient implements SqlClient {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = []
  constructor(private readonly rows: AppliedMigration[]) {}
  async query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, values })
    if (text.startsWith('SELECT version')) return { rows: this.rows as Row[] }
    return { rows: [] as Row[] }
  }
  release() {}
}

describe('migration release integrity verifier', () => {
  it('accepts legacy rows without checksum and detects name/checksum tampering', () => {
    expect(() => verifyAppliedMigrations([{ version: 1, name: 'initial' }], migrations)).not.toThrow()
    expect(() => verifyAppliedMigrations([{ version: 1, name: 'renamed' }], migrations)).toThrowError(
      expect.objectContaining({ code: 'MIGRATION_NAME_MISMATCH', version: 1 }),
    )
    expect(() => verifyAppliedMigrations([{ version: 1, name: 'initial', checksum: 'tampered' }], migrations)).toThrowError(
      expect.objectContaining({ code: 'MIGRATION_CHECKSUM_MISMATCH', version: 1 }),
    )
  })

  it('preserves the known historical name for migration 014 without certifying an unknown checksum', () => {
    const expected: Migration[] = [{ version: 14, name: 'store_aliases', sql: 'ALTER TABLE platform_accounts ADD COLUMN store_alias text' }]
    expect(() => verifyAppliedMigrations([{ version: 14, name: 'read_only_schedules', checksum: null }], expected)).not.toThrow()
    expect(() => verifyAppliedMigrations([{ version: 14, name: 'read_only_schedules', checksum: '0'.repeat(64) }], expected)).toThrowError(
      expect.objectContaining({ code: 'MIGRATION_NAME_MISMATCH', version: 14 }),
    )
  })

  it('backfills a legacy schema_migrations row and records checksums for new versions', async () => {
    const client = new IntegrityClient([{ version: 1, name: 'initial', checksum: null }])
    const pool: SqlPool = { connect: async () => client }
    await expect(new MigrationRunner(pool, migrations).run()).resolves.toEqual([2])
    expect(client.calls).toContainEqual({
      text: 'UPDATE schema_migrations SET checksum = $1 WHERE version = $2 AND checksum IS NULL',
      values: [migrationChecksum(migrations[0]!.sql), 1],
    })
    expect(client.calls).toContainEqual({
      text: 'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
      values: [2, 'second', migrationChecksum(migrations[1]!.sql)],
    })
  })

  it('fails before executing migration SQL when a recorded checksum is tampered', async () => {
    const client = new IntegrityClient([{ version: 1, name: 'initial', checksum: '0'.repeat(64) }])
    const pool: SqlPool = { connect: async () => client }
    const error = await new MigrationRunner(pool, migrations).run().catch(value => value as MigrationIntegrityError)
    expect(error).toMatchObject({ code: 'MIGRATION_CHECKSUM_MISMATCH', version: 1 })
    expect(client.calls.some(call => call.text === migrations[1]!.sql)).toBe(false)
  })

  it('rejects an unknown version during a complete release run but allows filtered upgrade fixtures', () => {
    expect(() => verifyAppliedMigrations([{ version: 99, name: 'future' }], migrations)).toThrowError(
      expect.objectContaining({ code: 'MIGRATION_VERSION_UNKNOWN', version: 99 }),
    )
    expect(() => verifyAppliedMigrations([{ version: 99, name: 'future' }], [migrations[1]!])).not.toThrow()
  })

  it('rejects a non-contiguous applied history during a complete release run', () => {
    expect(() => verifyAppliedMigrations([
      { version: 1, name: 'initial' },
      { version: 3, name: 'third' },
    ], [
      ...migrations,
      { version: 3, name: 'third', sql: 'CREATE TABLE third_table (id integer)' },
    ])).toThrowError(expect.objectContaining({ code: 'MIGRATION_VERSION_UNKNOWN', version: 2 }))
  })
})
