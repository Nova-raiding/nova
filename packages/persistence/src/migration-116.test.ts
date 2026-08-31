import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 116 support SLA correction approvals', () => {
  it('registers immutable independent approval evidence', async () => {
    const sql = await readFile(new URL('./migrations/116_support_sla_correction_approvals.sql', import.meta.url), 'utf8')
    const migrations = await loadMigrations()
    expect(migrations.find(item => item.version === 116)).toMatchObject({ version: 116, name: 'support_sla_correction_approvals' })
    expect(migrations.find(item => item.version === 117)).toMatchObject({ version: 117, name: 'image_generation_provider_operation_reservation' })
    expect(sql).toContain('UNIQUE (workspace_id, correction_id, actor_id)')
    expect(sql).toContain('FORCE ROW LEVEL SECURITY')
    expect(sql).toContain('support SLA correction approvals are immutable')
  })
})
