import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 144 creative point ledger', () => {
  it('registers the next migration and installs tenant, append-only, and concurrency boundaries', async () => {
    const sql = await readFile(new URL('./migrations/144_creative_point_ledger.sql', import.meta.url), 'utf8')
    expect((await loadMigrations()).find(item => item.version === 144)).toMatchObject({ version: 144, name: 'creative_point_ledger' })
    for (const table of ['creative_point_access_state', 'creative_point_operations', 'creative_point_grants', 'creative_point_reservations', 'creative_point_allocations', 'creative_point_ledger_events']) expect(sql).toContain(table)
    expect(sql).toContain('FORCE ROW LEVEL SECURITY')
    expect(sql).toContain("current_setting(''app.workspace_id'', true)")
    expect(sql).toContain('WITH CHECK')
    expect(sql).toContain('reject_creative_point_fact_mutation')
    expect(sql).toContain("allocation_type IN ('reserve', 'release', 'settle_adjustment')")
    expect(sql).not.toContain('rate_card_version')
    expect(sql).not.toContain('validate_creative_point_allocation')
    expect(sql).toContain('REVOKE UPDATE, DELETE, TRUNCATE')
    expect(sql).toContain('FOREIGN KEY (workspace_id, grant_id)')
    expect(sql).not.toMatch(/(?:FROM|JOIN|INSERT INTO|UPDATE)\s+(?:included_tasks|monthly_tasks_used|wallet|commercial_addons)\b/i)
  })
})
