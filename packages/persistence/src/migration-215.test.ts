import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('customer delivery account binding migration', () => {
  it('keeps history unbound and enforces immutable identity/workspace relationships', async () => {
    const migration = (await loadMigrations()).find(value => value.version === 215)
    expect(migration).toMatchObject({ name: 'customer_delivery_account_binding' })
    const sql = migration!.sql
    expect(sql).toContain('CHECK ((target_account_id IS NULL) = (target_identity_id IS NULL))')
    expect(sql).toContain('REFERENCES platform_password_accounts(id, identity_id) ON DELETE RESTRICT')
    expect(sql).toContain('REFERENCES workspace_members(workspace_id, identity_id) ON DELETE RESTRICT')
    expect(sql).toContain('UNIQUE (workspace_id, target_identity_id)')
    expect(sql).toContain('customer delivery account binding is immutable')
    expect(sql).not.toMatch(/\bUPDATE\s+(?:public\.)?(?:platform_password_accounts|platform_identities|workspace_members|workspaces)\s+SET\b/iu)
    expect(sql).not.toMatch(/\bUPDATE\s+workspace_customer_deliveries\s+SET\b/iu)
    expect(sql).not.toContain('ADD COLUMN target_account_login')
  })
  it('locks all exact eligibility rows through the least-privileged helper', async () => {
    const sql = (await loadMigrations()).find(value => value.version === 215)!.sql
    expect(sql).toContain('SECURITY DEFINER')
    expect(sql).toContain('SET search_path = pg_catalog, public')
    expect(sql).toContain("current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id")
    expect(sql).toContain("current_setting('app.platform_scope', true) IS DISTINCT FROM 'platform_ops'")
    expect(sql).toContain("a.account_type='merchant' AND a.status='active'")
    expect(sql).toContain("i.access_status='active' AND i.risk_decision='allow'")
    expect(sql).toContain("m.status='active' AND w.status='active'")
    expect(sql).toContain('p_workspace_id=ANY(a.workspace_ids)')
    expect(sql).toContain('FOR SHARE OF a,i,m,w')
    expect(sql).toContain('FROM PUBLIC, merchant_app')
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.lock_customer_delivery_account_target(TEXT,UUID) TO merchant_ops')
    expect(sql).not.toMatch(/GRANT\s+UPDATE[^;]*\bworkspaces\b/iu)
  })
})
