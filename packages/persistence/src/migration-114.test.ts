import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 114 support SLA reporting', () => {
  it('registers immutable, tenant-isolated monthly reports and corrections', async () => {
    const sql = await readFile(new URL('./migrations/114_support_sla_reporting.sql', import.meta.url), 'utf8')
    const migrations = await loadMigrations()
    expect(migrations.find(item => item.version === 114)).toMatchObject({ version: 114, name: 'support_sla_reporting' })
    expect(sql).toContain('support_sla_reporting_runs')
    expect(sql).toContain('support_sla_reporting_results')
    expect(sql).toContain('support_sla_reporting_exclusions')
    expect(sql).toContain('support_sla_correction_runs')
    expect(sql).toContain('FORCE ROW LEVEL SECURITY')
    expect(sql).toContain('support SLA reporting evidence is immutable')
  })
})
