import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 059 ops audit center integration', () => {
  it('registers migration 059 after a strictly contiguous 001-059 prefix', async () => {
    const migrations = await loadMigrations()
    const throughAuditCenter = migrations.filter(migration => migration.version <= 59)

    expect(throughAuditCenter.map(migration => migration.version)).toEqual(
      Array.from({ length: 59 }, (_, index) => index + 1),
    )
    expect(throughAuditCenter.at(-1)).toMatchObject({
      version: 59,
      name: 'ops_audit_center',
    })
  })

  it('keeps the projection caller-scoped and its operation facts append-only', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 59)

    expect(migration?.sql).toContain('CREATE OR REPLACE VIEW ops_audit_center')
    expect(migration?.sql).toContain('security_barrier = true')
    expect(migration?.sql).toContain('security_invoker = true')
    expect(migration?.sql).toContain('BEFORE UPDATE OR DELETE ON workspace_operation_audit')
    expect(migration?.sql).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON workspace_operation_audit FROM PUBLIC')
    expect(migration?.sql).toContain('REVOKE ALL ON ops_audit_center FROM PUBLIC')
    expect(migration?.sql).not.toMatch(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?ops_audit_center/i)
  })

  it('projects only from backing facts that enforce workspace RLS', async () => {
    const backingMigrations = await Promise.all([
      readFile(new URL('./migrations/020_operation_audit.sql', import.meta.url), 'utf8'),
      readFile(new URL('./migrations/008_rule_center.sql', import.meta.url), 'utf8'),
      readFile(new URL('./migrations/056_incidents.sql', import.meta.url), 'utf8'),
      readFile(new URL('./migrations/055_support_crm.sql', import.meta.url), 'utf8'),
    ])
    const backingTables = [
      'workspace_operation_audit',
      'rule_audit_events',
      'ops_incident_timeline',
      'workspace_support_ticket_events',
    ]

    backingTables.forEach((table, index) => {
      const sql = backingMigrations[index]
      expect(sql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)
      expect(sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`)
      expect(sql).toMatch(new RegExp(`CREATE POLICY [^\\n]+ ON ${table}`))
      expect(sql).toContain("current_setting('app.workspace_id', true)")
    })
  })
})
