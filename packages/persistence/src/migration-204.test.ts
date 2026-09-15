import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('customer delivery atomic evidence migration', () => {
  it('registers a transactional, tenant-scoped evidence assertion boundary', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 204)
    expect(migration).toMatchObject({ name: 'customer_delivery_atomic_evidence' })
    expect(migration?.transactional).not.toBe(false)
    const sql = migration!.sql
    expect(sql).toContain('FUNCTION public.assert_customer_delivery_evidence_asset(')
    expect(sql).toContain('SECURITY DEFINER')
    expect(sql.match(/SET search_path = pg_catalog/gu)).toHaveLength(3)
    expect(sql).toContain('FROM public.asset_scan_receipts receipt')
    expect(sql).toContain("current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id")
    expect(sql).toContain("p_purpose NOT IN ('contract', 'payment', 'system_integration'")
    expect(sql).toContain('FOR SHARE')
    expect(sql).toContain('public.asset_snapshot_is_trusted_clean(')
    expect(sql).toContain("event.event_type = 'asset.customer_delivery_quarantined'")
    expect(sql).toContain("event.event_type = 'customer_delivery.asset.upload_reused'")
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.assert_customer_delivery_evidence_asset')
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.assert_customer_delivery_evidence_asset')
    expect(sql).toContain('FROM merchant_app')
    expect(sql).not.toMatch(/receipt[^\n]*expires_at|expires_at[^\n]*receipt/iu)
  })

  it('invalidates effectiveness without erasing historical completion facts', async () => {
    const sql = (await loadMigrations()).find(item => item.version === 204)!.sql
    expect(sql).toContain('FUNCTION public.invalidate_customer_delivery_effectiveness_for_asset()')
    expect(sql).toContain("OLD.entity_type <> 'asset'")
    expect(sql).toContain('candidate.effective_at IS NOT NULL')
    expect(sql).toContain('SET effective_at = NULL,')
    expect(sql).toContain('revision = revision + 1')
    expect(sql).toContain("'customer_delivery.evidence.invalidated'")
    expect(sql).toContain('AFTER UPDATE OF workspace_id, entity_type, entity_id, payload OR DELETE')
    expect(sql).not.toMatch(/SET\s+(?:payment_status|training_completed|system_integration_status|functional_acceptance_status|customer_profile_status)\s*=/iu)
    expect(sql).not.toMatch(/DELETE\s+FROM\s+public\.workspace_customer/iu)
  })

  it('invokes the database assertion from every PostgreSQL evidence writer transaction', async () => {
    const source = await readFile(new URL('./customer-delivery-repository.ts', import.meta.url), 'utf8')
    expect(source).toContain('SELECT public.assert_customer_delivery_evidence_asset($1,$2,$3,$4)')
    for (const purpose of ['contract', 'payment', 'system_integration', 'functional_acceptance', 'training', 'video']) {
      expect(source).toContain(`"${purpose}"`)
    }
    expect(source).toContain('await this.assertEvidenceAssets(')
  })
})
