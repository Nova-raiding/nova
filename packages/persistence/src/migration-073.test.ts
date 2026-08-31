import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('migration 073 Ops data contracts', () => {
  it('keeps platform reads separate from tenant writes and exposes a read-only summary', async () => {
    const sql = await readFile(new URL('./migrations/073_ops_data_contracts.sql', import.meta.url), 'utf8')
    for (const relation of ['workspace_commercial_settings', 'workspace_subscriptions']) {
      expect(sql).toContain(`CREATE POLICY ${relation}_select_scope`)
      expect(sql).toContain(`CREATE POLICY ${relation}_insert_scope`)
      expect(sql).toContain(`CREATE POLICY ${relation}_update_scope`)
      expect(sql).toContain(`CREATE POLICY ${relation}_delete_scope`)
    }
    expect(sql).toContain("current_setting('app.platform_scope', true) = 'platform_ops'")
    expect(sql).toContain("WITH CHECK (workspace_id = current_setting('app.workspace_id', true))")
    expect(sql).toContain('WITH (security_barrier = true, security_invoker = true)')
    expect(sql).toContain('REVOKE ALL ON TABLE ops_workspace_summaries FROM PUBLIC')
    expect(sql).toContain('REVOKE ALL ON TABLE ops_workspace_summaries FROM merchant_ops')
    expect(sql).not.toMatch(/INSERT INTO (commercial_offers|commercial_addons|commercial_coupons|workspace_commercial_settings|workspace_subscriptions)/u)
  })
})
