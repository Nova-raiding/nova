import { createHash } from 'node:crypto'
import { migrationChecksumBaseline, verifyAppliedMigrations, type AppliedMigration, type Migration, type MigrationChecksumBaseline } from '../../../packages/persistence/src/migration.js'

/** Attest the complete observed history, including release-bound names and SQL
 * checksums. A matching tail version alone does not prove migration integrity. */
export function commercialSchemaAttestationDigest(rows: readonly AppliedMigration[], expected: readonly Migration[], baseline: MigrationChecksumBaseline = migrationChecksumBaseline()): string {
  if (!expected.length || rows.length !== expected.length) throw new Error('commercial schema history is incomplete')
  const ordered = [...rows].sort((a, b) => a.version - b.version)
  if (ordered.some((row, index) => row.version !== expected[index]?.version || !/^[a-f0-9]{64}$/.test(row.checksum ?? ''))) throw new Error('commercial schema history is invalid')
  verifyAppliedMigrations(ordered, [...expected], baseline)
  return createHash('sha256').update(JSON.stringify(ordered.map(row => [row.version, row.checksum]))).digest('hex')
}
