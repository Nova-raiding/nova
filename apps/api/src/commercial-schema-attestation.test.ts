import { describe, expect, it } from 'vitest'
import { commercialSchemaAttestationDigest } from './commercial-schema-attestation.js'
import { EMPTY_MIGRATION_CHECKSUM_BASELINE, migrationChecksum } from '../../../packages/persistence/src/migration.js'

const expected = [{ version: 1, name: 'first', sql: 'SELECT 1' }, { version: 2, name: 'second', sql: 'SELECT 2' }]
const observed = () => expected.map(row => ({ version: row.version, name: row.name, checksum: migrationChecksum(row.sql) }))
const digest = (rows: ReturnType<typeof observed>) => commercialSchemaAttestationDigest(rows, expected, EMPTY_MIGRATION_CHECKSUM_BASELINE)

describe('complete commercial schema attestation', () => {
  it('uses stable ordered observed version and checksum identities', () => {
    expect(digest(observed())).toMatch(/^[a-f0-9]{64}$/)
    expect(digest(observed().reverse())).toBe(digest(observed()))
  })
  it('rejects missing earlier history even when the tail matches', () => {
    expect(() => digest(observed().slice(1))).toThrow('incomplete')
  })
  it('rejects duplicate versions, name drift and syntactically valid checksum drift', () => {
    const duplicate = observed(); duplicate[0]!.version = 2
    expect(() => digest(duplicate)).toThrow()
    const renamed = observed(); renamed[0]!.name = 'unreviewed'
    expect(() => digest(renamed)).toThrow()
    const changed = observed(); changed[0]!.checksum = 'a'.repeat(64)
    expect(() => digest(changed)).toThrow()
  })
})
