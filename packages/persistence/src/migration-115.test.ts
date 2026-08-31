import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 115 support SLA correction decisions', () => {
  it('registers an immutable, workspace-scoped one-decision record', async () => {
    const sql = await readFile(new URL('./migrations/115_support_sla_correction_decisions.sql', import.meta.url), 'utf8')
    const migrations = await loadMigrations()
    expect(migrations.find(item => item.version === 115)).toMatchObject({ version: 115, name: 'support_sla_correction_decisions' })
    expect(sql).toContain('support_sla_correction_decisions')
    expect(sql).toContain('UNIQUE (workspace_id, correction_id)')
    expect(sql).toContain('FORCE ROW LEVEL SECURITY')
    expect(sql).toContain('support SLA correction decisions are immutable')
  })
})
