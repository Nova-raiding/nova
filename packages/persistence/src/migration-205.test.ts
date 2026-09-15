import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('customer delivery evidence identity invalidation migration', () => {
  it('forward-repairs clean evidence replacement without changing migration 204', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 205)
    expect(migration).toMatchObject({ name: 'customer_delivery_evidence_identity_invalidation' })
    const sql = migration!.sql
    expect(sql).toContain('NEW.workspace_id = OLD.workspace_id')
    expect(sql).toContain('NEW.entity_id = OLD.entity_id')
    expect(sql).toMatch(/ROW\(\s*NEW\.payload->>'sourceRevision',[\s\S]*NEW\.payload->>'scanVerdict'[\s\S]*\) IS NOT DISTINCT FROM ROW\(/u)
    expect(sql).not.toContain('candidate.effective_at IS NOT NULL')
    expect(sql).toContain('revision = revision + 1')
    expect(sql).toContain("'customer_delivery.evidence.invalidated'")
    expect(sql).toContain('SET search_path = pg_catalog')
  })
})
