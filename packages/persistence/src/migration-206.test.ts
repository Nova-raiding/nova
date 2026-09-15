import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('customer delivery evidence invalidation lock-order migration', () => {
  it('locks every affected delivery deterministically and fails fast on contention', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 206)
    expect(migration).toMatchObject({ name: 'customer_delivery_evidence_invalidation_lock_order' })
    const sql = migration!.sql

    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.invalidate_customer_delivery_effectiveness_for_asset()')
    expect(sql).toMatch(/ORDER BY candidate\.id\s+FOR UPDATE OF candidate NOWAIT/u)
    expect(sql).not.toContain('SKIP LOCKED')
    expect(sql).toContain('NEW.workspace_id = OLD.workspace_id')
    expect(sql).toContain('NEW.entity_id = OLD.entity_id')
    expect(sql).toMatch(/ROW\(\s*NEW\.payload->>'sourceRevision',[\s\S]*NEW\.payload->>'scanVerdict'[\s\S]*\) IS NOT DISTINCT FROM ROW\(/u)
    expect(sql).not.toContain('candidate.effective_at IS NOT NULL')
    expect(sql).toContain('revision = revision + 1')
    expect(sql).toContain("'customer_delivery.evidence.invalidated'")
    expect(sql).toContain('SET search_path = pg_catalog')
  })
})
