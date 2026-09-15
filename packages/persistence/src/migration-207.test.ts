import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('customer delivery evidence receipt identity migration', () => {
  it('binds trusted snapshots to receipt MIME, digest and byte size', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 207)
    expect(migration).toMatchObject({ name: 'customer_delivery_evidence_receipt_identity' })
    const sql = migration!.sql

    expect(sql).toContain("receipt.receipt->'subject'->>'mime_type' = p_payload->>'mimeType'")
    expect(sql).toContain("receipt.receipt->'subject'->>'sha256' = p_payload->>'sha256'")
    expect(sql).toContain("receipt.receipt->'subject'->>'size_bytes' = p_payload->>'sizeBytes'")
    expect(sql).toMatch(/ROW\(\s*NEW\.payload->>'sourceRevision',[\s\S]*NEW\.payload->>'mimeType',[\s\S]*NEW\.payload->>'sha256',[\s\S]*NEW\.payload->>'sizeBytes'/u)
    expect(sql).toMatch(/ORDER BY candidate\.id\s+FOR UPDATE OF candidate NOWAIT/u)
    expect(sql).not.toContain('SKIP LOCKED')
    expect(sql.match(/SET search_path = pg_catalog/gu)).toHaveLength(2)
    expect(sql).toContain('SECURITY DEFINER')
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.invalidate_customer_delivery_effectiveness_for_asset() FROM PUBLIC')
    expect(sql).toContain('customer_delivery_evidence_identity_mismatch_207')
    expect(sql).toContain("snapshot.payload, '{scanStatus}', '\"blocked\"'::jsonb")
    expect(sql).toContain("'customer_delivery.evidence.invalidated'")
  })
})
