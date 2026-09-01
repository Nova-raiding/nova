import { describe, expect, it } from 'vitest'
import { MigrationIntegrityError, MigrationRunner, loadMigrations, migrationChecksum, verifyAppliedMigrations, type AppliedMigration } from './migration.js'
import type { SqlClient, SqlPool } from './repository.js'

class AppliedHistoryClient implements SqlClient {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = []

  constructor(private readonly rows: readonly AppliedMigration[]) {}

  async query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, values })
    if (text.startsWith('SELECT version')) return { rows: this.rows as Row[] }
    return { rows: [] as Row[] }
  }

  release() {}
}

describe('migration release integrity gate', () => {
  it('ships one complete, ordered migration chain with unique names and stable checksums', async () => {
    const migrations = await loadMigrations()
    const versions = migrations.map(migration => migration.version)
    const names = migrations.map(migration => migration.name)
    const latestVersion = migrations.at(-1)?.version ?? 0

    expect(versions).toEqual(Array.from({ length: latestVersion }, (_, index) => index + 1))
    expect(new Set(versions).size).toBe(versions.length)
    expect(new Set(names).size).toBe(names.length)
    expect(migrations.every(migration => migration.name.trim() && migration.sql.trim())).toBe(true)
    expect(migrations.every(migration => /^[a-f0-9]{64}$/u.test(migrationChecksum(migration.sql)))).toBe(true)
  })

  it('is idempotent when the complete release history is already applied', async () => {
    const migrations = await loadMigrations()
    const rows = migrations.map(migration => ({
      version: migration.version,
      name: migration.name,
      checksum: migrationChecksum(migration.sql),
    }))
    const client = new AppliedHistoryClient(rows)
    const pool: SqlPool = { connect: async () => client }

    await expect(new MigrationRunner(pool, migrations).run()).resolves.toEqual([])
    expect(client.calls.some(call => call.text === 'BEGIN')).toBe(false)
    expect(client.calls.some(call => call.text.startsWith('INSERT INTO schema_migrations'))).toBe(false)
    expect(client.calls.some(call => migrations.some(migration => call.text === migration.sql))).toBe(false)
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid release version %s', (version) => {
    expect(() => verifyAppliedMigrations([], [{ version, name: 'invalid', sql: 'SELECT 1' }])).toThrowError(expect.objectContaining<Partial<MigrationIntegrityError>>({
      code: 'MIGRATION_VERSION_INVALID',
      version,
    }))
  })

  it('rejects invalid versions already recorded in migration history', () => {
    expect(() => verifyAppliedMigrations([{ version: 0, name: 'invalid', checksum: null }], [])).toThrowError(expect.objectContaining<Partial<MigrationIntegrityError>>({
      code: 'MIGRATION_VERSION_INVALID',
      version: 0,
    }))
  })

  it('rejects duplicate versions in the release migration set', () => {
    expect(() => verifyAppliedMigrations([], [
      { version: 1, name: 'initial', sql: 'SELECT 1' },
      { version: 1, name: 'initial-copy', sql: 'SELECT 1' },
    ])).toThrowError(expect.objectContaining<Partial<MigrationIntegrityError>>({
      code: 'MIGRATION_DUPLICATE_VERSION',
      version: 1,
    }))
  })

  it('rejects duplicate versions in recorded migration history', () => {
    expect(() => verifyAppliedMigrations([
      { version: 1, name: 'initial', checksum: null },
      { version: 1, name: 'initial', checksum: null },
    ], [{ version: 1, name: 'initial', sql: 'SELECT 1' }])).toThrowError(expect.objectContaining<Partial<MigrationIntegrityError>>({
      code: 'MIGRATION_DUPLICATE_VERSION',
      version: 1,
    }))
  })
})
