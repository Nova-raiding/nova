import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('customer delivery retention FK migration', () => {
  it('registers migration 199 and replaces the workspace cascade with RESTRICT', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 199)
    expect(migration?.name).toBe('customer_delivery_retention_fk')
    expect(migration?.sql).toContain('DROP CONSTRAINT IF EXISTS workspace_customer_deliveries_workspace_id_fkey')
    expect(migration?.sql).toMatch(/FOREIGN KEY\s*\(workspace_id\)[\s\S]*REFERENCES workspaces\(id\)[\s\S]*ON DELETE RESTRICT/u)
    expect(migration?.sql).not.toMatch(/workspace_customer_deliveries[\s\S]*REFERENCES workspaces\(id\)[\s\S]*ON DELETE CASCADE/u)
  })
})
