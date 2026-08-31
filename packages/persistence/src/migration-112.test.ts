import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 112 support SLA snapshot', () => {
  it('adds an auditable, tenant-scoped SLA snapshot projection to support tickets', async () => {
    const sql = await readFile(new URL('./migrations/112_support_sla_snapshot.sql', import.meta.url), 'utf8')
    const migrations = await loadMigrations()
    expect(migrations.find(item => item.version === 112)).toMatchObject({ version: 112, name: 'support_sla_snapshot' })
    expect(migrations.find(item => item.version === 113)).toMatchObject({ version: 113, name: 'support_sla_events' })
    expect(migrations.find(item => item.version === 114)).toMatchObject({ version: 114, name: 'support_sla_reporting' })
    expect(migrations.find(item => item.version === 115)).toMatchObject({ version: 115, name: 'support_sla_correction_decisions' })
    expect(migrations.find(item => item.version === 116)).toMatchObject({ version: 116, name: 'support_sla_correction_approvals' })
    expect(migrations.find(item => item.version === 117)).toMatchObject({ version: 117, name: 'image_generation_provider_operation_reservation' })
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS sla_snapshot_json JSONB')
    expect(sql).toContain('jsonb_typeof(sla_snapshot_json) = \'object\'')
    expect(sql).toContain('support SLA snapshots are immutable')
    expect(sql).toContain('workspace_support_tickets_sla_due_idx')
  })
})
