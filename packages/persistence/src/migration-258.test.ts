import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 258 knowledge claim usage evidence', () => {
  it('adds an evidence-aware claim transition without rewriting the prior fence migration', async () => {
    const migrations = await loadMigrations()
    expect(migrations[249]).toMatchObject({ version: 250, name: 'knowledge_generation_claim_fence' })
    expect(migrations[257]).toMatchObject({ version: 258, name: 'knowledge_generation_claim_usage_evidence' })

    const sql = migrations[257]!.sql
    expect(sql).toContain('p_provider_request_id text')
    expect(sql).toContain("c.state='outcome_unknown' AND p_to_state='completed'")
    expect(sql).toContain("m.settlement_status='settled'")
    expect(sql).toContain('m.cost_cny IS NOT NULL')
    expect(sql).toContain("m.metadata->>'provider_attempt_id'=c.provider_attempt_id")
    expect(sql).toContain('p_provider_request_id IS NULL OR m.provider_request_id=p_provider_request_id')
    expect(sql).toContain('REVOKE ALL ON FUNCTION settle_knowledge_generation_claim(text,text,text,text,text,text,text,text) FROM PUBLIC')
    expect(sql).not.toMatch(/DROP\s+TABLE|TRUNCATE/iu)

    // The seven-argument function remains in the already-published migration;
    // old binaries can continue to call it while the new overload is applied.
    expect(migrations[249]!.sql).toContain('p_to_state text\n) RETURNS TABLE')
  })
})
