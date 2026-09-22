import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('apply-migrations baseline alias authorization', () => {
  it('requires explicit baseline approval for the legacy 014 name in both runner branches', () => {
    const source = readFileSync('infra/scripts/apply-migrations.sh', 'utf8')
    const clauses = [...source.matchAll(/migration_version = 14 AND :'applied_name' = 'read_only_schedules'[^)]*/g)].map(match => match[0])
    expect(clauses).toHaveLength(6)
    for (const clause of clauses) expect(clause).toContain(":'baseline_accepted' = '1'")
    const nameChecks = [...source.matchAll(/SELECT \(:'applied_name' <> :'migration_name'[^\n]+/g)].map(match => match[0])
    expect(nameChecks).toHaveLength(2)
    for (const check of nameChecks) expect(check).toContain(":'applied_checksum' = ''")
  })

  it('does not create an unapproved checksum exception while synchronizing a null checksum', () => {
    const source = readFileSync('infra/scripts/apply-migrations.sh', 'utf8')
    const updates = [...source.matchAll(/UPDATE schema_migrations SET checksum[^\n]+/g)].map(match => match[0])
    expect(updates).toHaveLength(2)
    for (const update of updates) {
      expect(update).toContain("'read_only_schedules' AND :'baseline_accepted' = '1'")
      expect(update).not.toContain("AND NOT (:migration_version = 14 AND :'applied_name' = 'read_only_schedules');")
    }
  })

})
