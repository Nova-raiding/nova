import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 209 alert receiver role isolation', () => {
  it('fails closed on role drift and exposes only guarded security-definer functions', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 209)
    expect(migration).toMatchObject({ name: 'isolate_alert_webhook_receiver_role' })
    const sql = migration!.sql
    expect(sql).toContain("rolname = 'merchant_alert_receiver'")
    expect(sql).toContain('role must be provisioned before migration 209')
    expect(sql).toContain('receiver_role.rolsuper')
    expect(sql).toContain('receiver_role.rolbypassrls')
    expect(sql).toContain('receiver_role.rolinherit')
    expect(sql).toContain('pg_catalog.pg_auth_members')
    expect(sql).toContain('REVOKE ALL PRIVILEGES ON TABLE public.alert_webhook_receipts FROM merchant_app')
    expect(sql).toContain('REVOKE ALL PRIVILEGES ON TABLE public.alert_webhook_receipts FROM merchant_ops')
    expect(sql).toContain('REVOKE ALL PRIVILEGES ON TABLE public.alert_webhook_receipts FROM merchant_alert_receiver')
    expect(sql).not.toContain('GRANT SELECT')
    expect(sql).not.toContain('GRANT INSERT')
    expect(sql).toContain('public.append_alert_webhook_receipt(')
    expect(sql).toContain('public.alert_webhook_receipts_ready()')
    expect(sql.match(/SECURITY DEFINER/g)).toHaveLength(2)
    expect(sql.match(/SET search_path = pg_catalog/g)).toHaveLength(2)
    expect(sql.match(/SESSION_USER <> 'merchant_alert_receiver'/g)).toHaveLength(2)
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.append_alert_webhook_receipt(text,text,timestamptz,timestamptz,text,jsonb) TO merchant_alert_receiver')
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.alert_webhook_receipts_ready() TO merchant_alert_receiver')
  })
})
