import { describe, expect, it } from 'vitest'
import {
  assertConcurrentIndexesValid,
  concurrentIndexNames,
  MIGRATION_BASELINE_ACCEPTED_ENV,
  MIGRATION_BASELINE_CHECKSUMS_ENV,
  MigrationIntegrityError,
  MigrationRunner,
  loadMigrations,
  migrationChecksum,
  migrationChecksumBaseline,
  verifyBridgeMigrationPrefix,
  verifyAppliedMigrations,
  type AppliedMigration,
  type Migration,
} from './migration.js'
import type { SqlClient, SqlPool } from './repository.js'

const migrations: Migration[] = [
  { version: 1, name: 'initial', sql: 'CREATE TABLE first_table (id integer)' },
  { version: 2, name: 'second', sql: 'CREATE TABLE second_table (id integer)' },
]

/** The operator approval that turns a legacy identity into an accepted one. */
const approved = (...entries: Array<[number, string]>) => migrationChecksumBaseline({
  [MIGRATION_BASELINE_ACCEPTED_ENV]: 'true',
  [MIGRATION_BASELINE_CHECKSUMS_ENV]: entries.map(([version, checksum]) => `${version}=${checksum}`).join(','),
})

describe('bridge-only migration compatibility', () => {
  it('accepts exactly the checksummed 242 and 244 prefixes and rejects partial or altered history', async () => {
    // The verifier receives the current migration chain but accepts only the
    // two reviewed compatibility prefixes.
    const expected = await loadMigrations()
    const rows = expected.map(item => ({ version: item.version, name: item.name, checksum: migrationChecksum(item.sql) }))
    expect(verifyBridgeMigrationPrefix(rows.slice(0, 242), expected, 'prefix_242_or_244')).toBe(242)
    expect(verifyBridgeMigrationPrefix(rows.slice(0, 244), expected, 'prefix_242_or_244')).toBe(244)
    expect(() => verifyBridgeMigrationPrefix(rows.slice(0, 243), expected, 'prefix_242_or_244')).toThrow('exactly 242 or 244')
    expect(() => verifyBridgeMigrationPrefix(rows.slice(0, 245), expected, 'prefix_242_or_244')).toThrow('exactly 242 or 244')
    expect(() => verifyBridgeMigrationPrefix(rows.slice(0, 254), expected, 'prefix_242_or_244')).toThrow('exactly 242 or 244')
    expect(() => verifyBridgeMigrationPrefix(rows.slice(0, 242), expected, undefined)).toThrow('not enabled')
    expect(() => verifyBridgeMigrationPrefix([{ ...rows[0]!, checksum: '0'.repeat(64) }, ...rows.slice(1, 242)], expected, 'prefix_242_or_244')).toThrow('checksum mismatch')
    expect(() => verifyBridgeMigrationPrefix(rows.slice(0, 242), expected.slice(0, 243), 'prefix_242_or_244')).toThrow('complete migration chain through 244')
  })
})

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
  it('fails closed on a legacy row with no recorded checksum and detects name/checksum tampering', () => {
    expect(() => verifyAppliedMigrations([{ version: 1, name: 'initial' }], migrations)).toThrowError(
      expect.objectContaining({ code: 'MIGRATION_CHECKSUM_UNVERIFIED', version: 1 }),
    )
    expect(() => verifyAppliedMigrations([{ version: 1, name: 'renamed' }], migrations)).toThrowError(
      expect.objectContaining({ code: 'MIGRATION_NAME_MISMATCH', version: 1 }),
    )
    expect(() => verifyAppliedMigrations([{ version: 1, name: 'initial', checksum: 'tampered' }], migrations)).toThrowError(
      expect.objectContaining({ code: 'MIGRATION_CHECKSUM_MISMATCH', version: 1 }),
    )
  })

  it('adopts a null checksum only when the operator baseline pins the release artifact digest', () => {
    const release = migrationChecksum(migrations[0]!.sql)
    const row: AppliedMigration = { version: 1, name: 'initial', checksum: null }
    // Approved, but the baseline was captured from a different artifact: refuse.
    expect(() => verifyAppliedMigrations([row], migrations, approved([1, '0'.repeat(64)]))).toThrowError(
      expect.objectContaining({ code: 'MIGRATION_CHECKSUM_UNVERIFIED', version: 1 }),
    )
    // Approved and pinned to the artifact actually being deployed.
    expect(() => verifyAppliedMigrations([row], migrations, approved([1, release]))).not.toThrow()
    // The approval flag alone is not enough; an entry for the version is required.
    expect(() => verifyAppliedMigrations([row], migrations, migrationChecksumBaseline({
      [MIGRATION_BASELINE_ACCEPTED_ENV]: 'true',
    }))).toThrowError(expect.objectContaining({ code: 'MIGRATION_CHECKSUM_UNVERIFIED', version: 1 }))
  })

  it('does not honour the untraceable pre-consolidation digests unless the operator approves them', () => {
    // These three identities exist only as rows in local release databases:
    // no blob in the repository object database hashes to any of them, so the
    // release cannot attest them on its own. See the module comment on
    // UNVERIFIABLE_LEGACY_CHECKSUMS.
    const legacy = new Map<number, { name: string; sql: string; digest: string }>([
      [144, { name: 'creative_point_ledger', sql: 'SELECT 144', digest: '9519b2dbee21371a0bc7429c50e61ab3a677a4fd3965707328bd18489f2ad2e7' }],
      [168, { name: 'onboarding_grant_dispatch', sql: 'SELECT 168', digest: '37f633fb25a7d1536f65a644a1adee3611c36ed416ac9a1bf3a10a1e92ab1ef1' }],
      [191, { name: 'rule_pack_category', sql: 'SELECT 191', digest: '36f8c9669ba99a392a874a76fa8d28b658211376a0e7e3131281247926202ba2' }],
    ])
    for (const [version, entry] of legacy) {
      const expected: Migration[] = [{ version, name: entry.name, sql: entry.sql }]
      const recorded: AppliedMigration[] = [{ version, name: entry.name, checksum: entry.digest }]
      expect(() => verifyAppliedMigrations(recorded, expected)).toThrowError(
        expect.objectContaining({ code: 'MIGRATION_CHECKSUM_MISMATCH', version }),
      )
      expect(() => verifyAppliedMigrations(recorded, expected, migrationChecksumBaseline({ [MIGRATION_BASELINE_ACCEPTED_ENV]: 'true' }))).not.toThrow()
    }
  })

  it('reads the operator baseline from the deployment environment', () => {
    expect(migrationChecksumBaseline({})).toEqual({ accepted: false, checksums: new Map() })
    expect(migrationChecksumBaseline({ [MIGRATION_BASELINE_ACCEPTED_ENV]: ' TRUE ' }).accepted).toBe(true)
    const parsed = migrationChecksumBaseline({ [MIGRATION_BASELINE_ACCEPTED_ENV]: 'true', [MIGRATION_BASELINE_CHECKSUMS_ENV]: `7=${'a'.repeat(64)}` })
    expect(parsed.checksums.get(7)?.has('a'.repeat(64))).toBe(true)
    expect(() => migrationChecksumBaseline({ [MIGRATION_BASELINE_ACCEPTED_ENV]: 'true', [MIGRATION_BASELINE_CHECKSUMS_ENV]: 'not-a-checksum' })).toThrowError(
      /malformed entry/u,
    )
  })

  it('preserves the known historical name for migration 014 without certifying an unknown checksum', () => {
    const expected: Migration[] = [{ version: 14, name: 'store_aliases', sql: 'ALTER TABLE platform_accounts ADD COLUMN store_alias text' }]
    const alias: AppliedMigration = { version: 14, name: 'read_only_schedules', checksum: null }
    expect(() => verifyAppliedMigrations([alias], expected)).toThrowError(
      expect.objectContaining({ code: 'MIGRATION_CHECKSUM_UNVERIFIED', version: 14 }),
    )
    expect(() => verifyAppliedMigrations([alias], expected, migrationChecksumBaseline({ [MIGRATION_BASELINE_ACCEPTED_ENV]: 'true' }))).not.toThrow()
    expect(() => verifyAppliedMigrations([{ version: 14, name: 'read_only_schedules', checksum: '0'.repeat(64) }], expected)).toThrowError(
      expect.objectContaining({ code: 'MIGRATION_NAME_MISMATCH', version: 14 }),
    )
  })

  it('adopts an approved legacy row and records checksums for new versions', async () => {
    const client = new IntegrityClient([{ version: 1, name: 'initial', checksum: null }])
    const pool: SqlPool = { connect: async () => client }
    process.env[MIGRATION_BASELINE_ACCEPTED_ENV] = 'true'
    process.env[MIGRATION_BASELINE_CHECKSUMS_ENV] = `1=${migrationChecksum(migrations[0]!.sql)}`
    try {
      await expect(new MigrationRunner(pool, migrations).run()).resolves.toEqual([2])
    } finally {
      delete process.env[MIGRATION_BASELINE_ACCEPTED_ENV]
      delete process.env[MIGRATION_BASELINE_CHECKSUMS_ENV]
    }
    expect(client.calls).toContainEqual({
      text: 'UPDATE schema_migrations SET checksum = $1 WHERE version = $2 AND checksum IS NULL',
      values: [migrationChecksum(migrations[0]!.sql), 1],
    })
    expect(client.calls).toContainEqual({
      text: 'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
      values: [2, 'second', migrationChecksum(migrations[1]!.sql)],
    })
  })

  it('never stamps an unverified legacy row', async () => {
    const client = new IntegrityClient([{ version: 1, name: 'initial', checksum: null }])
    const pool: SqlPool = { connect: async () => client }
    await expect(new MigrationRunner(pool, migrations).run()).rejects.toMatchObject({ code: 'MIGRATION_CHECKSUM_UNVERIFIED', version: 1 })
    expect(client.calls.some(call => call.text.startsWith('UPDATE schema_migrations SET checksum'))).toBe(false)
    expect(client.calls.some(call => call.text === migrations[1]!.sql)).toBe(false)
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
    const third: Migration = { version: 3, name: 'third', sql: 'CREATE TABLE third_table (id integer)' }
    expect(() => verifyAppliedMigrations([
      { version: 1, name: 'initial', checksum: migrationChecksum(migrations[0]!.sql) },
      { version: 3, name: 'third', checksum: migrationChecksum(third.sql) },
    ], [...migrations, third])).toThrowError(expect.objectContaining({ code: 'MIGRATION_VERSION_UNKNOWN', version: 2 }))
  })
})

describe('concurrent index build assertion', () => {
  it('extracts the indexes a non-transactional migration declares', () => {
    expect(concurrentIndexNames(`
      -- migrate:no-transaction
      -- A comment mentioning CREATE INDEX CONCURRENTLY must not be parsed.
      CREATE INDEX CONCURRENTLY IF NOT EXISTS first_idx ON first_table (id);
      CREATE UNIQUE INDEX CONCURRENTLY "quoted_idx" ON first_table (id);
      CREATE INDEX CONCURRENTLY second_idx ON public.second_table (id);
      DROP INDEX CONCURRENTLY IF EXISTS stale_idx;
      CREATE INDEX plain_idx ON first_table (id);
    `)).toEqual(['first_idx', 'quoted_idx', 'second_idx'])
  })

  it('reports the indexes a migration declared but did not materialise', async () => {
    const migration: Migration = { version: 60, name: 'indexes', sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS missing_idx ON t (id);', transactional: false }
    const client = new IntegrityClient([])
    const probing = { ...client, query: async <Row = Record<string, unknown>>(text: string, values?: readonly unknown[]) => { client.calls.push({ text, values }); return { rows: [{ name: 'missing_idx' }] as Row[] } } }
    await expect(assertConcurrentIndexesValid(probing as SqlClient, migration)).rejects.toMatchObject({
      code: 'MIGRATION_CONCURRENT_INDEX_INVALID',
      version: 60,
    })
    expect(client.calls[0]?.values).toEqual([['missing_idx']])
    expect(client.calls[0]?.text).toContain('NOT i.indisvalid')
  })

  it('accepts a migration whose indexes are all valid and probes nothing when none are declared', async () => {
    const valid: Migration = { version: 60, name: 'indexes', sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS ok_idx ON t (id);', transactional: false }
    const client = new IntegrityClient([])
    await expect(assertConcurrentIndexesValid(client, valid)).resolves.toBeUndefined()
    const cleanup: Migration = { version: 62, name: 'cleanup', sql: 'DROP INDEX CONCURRENTLY IF EXISTS stale_idx;', transactional: false }
    const empty = new IntegrityClient([])
    await expect(assertConcurrentIndexesValid(empty, cleanup)).resolves.toBeUndefined()
    expect(empty.calls).toHaveLength(0)
  })
})
