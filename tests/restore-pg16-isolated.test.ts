import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('infra/scripts/restore-pg16-isolated.sh', 'utf8')

describe('isolated PG16 restore executor', () => {
  it('requires explicit immutable backup, source, migration, and image inputs', () => {
    for (const key of ['BACKUP_FILE', 'EXPECTED_BACKUP_SHA256', 'EXPECTED_SOURCE_DATABASE_ID_SHA256', 'EXPECTED_MIGRATION_VERSION', 'POSTGRES_IMAGE_REF', 'VERIFY_PREVIEW_INPUTS']) expect(source).toContain('${' + key + ':?')
    expect(source).toContain('production database variables are forbidden')
    expect(source).toContain('postgres@sha256:')
  })

  it('uses an internal isolated compose network and verifies the restored migration tail', () => {
    expect(source).toContain('internal: true')
    expect(source).toContain('pg_restore')
    expect(source).toContain('select max(version)::int from schema_migrations')
    expect(source).toContain('does not match expected')
  })
})
