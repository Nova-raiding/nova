import { describe, expect, it } from 'vitest'
import { MigrationIntegrityError, verifyAppliedMigrations } from './migration.js'

describe('migration release integrity gate', () => {
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
