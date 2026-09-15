import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('MCP OAuth identity migration', () => {
  it('stores only token digests behind forced RLS and the platform ops scope', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 210)
    expect(migration).toMatchObject({ name: 'mcp_oauth_identity' })
    const sql = migration!.sql
    expect(sql).toContain('code_hash CHAR(64) NOT NULL UNIQUE')
    expect(sql).toContain('token_hash CHAR(64) NOT NULL UNIQUE')
    expect(sql).not.toMatch(/\b(?:access_token|refresh_token)\s+TEXT\b/iu)
    expect(sql).toContain('UNIQUE (id, identity_id)')
    expect(sql).toContain('UNIQUE (workspace_id, identity_id)')
    expect(sql.match(/FOREIGN KEY \(account_id, identity_id\)/g)).toHaveLength(2)
    expect(sql.match(/FOREIGN KEY \(workspace_id, identity_id\)/g)).toHaveLength(2)
    expect(sql).toContain('ALTER TABLE mcp_oauth_authorization_codes FORCE ROW LEVEL SECURITY')
    expect(sql).toContain('ALTER TABLE mcp_oauth_tokens FORCE ROW LEVEL SECURITY')
    expect(sql).toContain("current_setting('app.platform_scope', true) = 'platform_ops'")
    expect(sql).toContain('REVOKE ALL ON mcp_oauth_authorization_codes, mcp_oauth_tokens FROM PUBLIC, merchant_app')
    expect(sql).toContain('REVOKE DELETE, TRUNCATE ON mcp_oauth_authorization_codes, mcp_oauth_tokens FROM merchant_ops')
  })
})
