import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('MCP OAuth workspace RLS migration', () => {
  it('adds idempotent workspace policies without removing platform ops scope', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 211)
    expect(migration).toMatchObject({ name: 'mcp_oauth_workspace_rls' })
    expect(migration!.sql).toContain('mcp_oauth_authorization_codes_workspace_isolation')
    expect(migration!.sql).toContain('mcp_oauth_tokens_workspace_isolation')
    expect(migration!.sql).toContain("workspace_id = current_setting('app.workspace_id', true)")
    expect(migration!.sql).toContain('IF NOT EXISTS')
    expect(migration!.sql).not.toContain('DROP POLICY')
  })
})
