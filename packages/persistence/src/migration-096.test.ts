import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { loadMigrations } from './migration.js'

describe('migration 096 reconciliation evidence', () => {
  it('creates an RLS-protected append-only evidence table with idempotency', async () => {
    const sql = await readFile(new URL('./migrations/096_reconciliation_evidence.sql', import.meta.url), 'utf8')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS reconciliation_evidence')
    expect(sql).toContain('UNIQUE (workspace_id,idempotency_key)')
    expect(sql).toContain('FOREIGN KEY (workspace_id,job_id) REFERENCES image_generation_jobs(workspace_id,id)')
    expect(sql).toContain("provider_state = 'failed'")
    expect(sql).toContain('ALTER TABLE reconciliation_evidence FORCE ROW LEVEL SECURITY')
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON reconciliation_evidence')
    expect(sql).toContain('GRANT SELECT,INSERT ON TABLE reconciliation_evidence TO merchant_app')
    expect((await loadMigrations()).find(item => item.version === 96)).toMatchObject({ version: 96, name: 'reconciliation_evidence' })
    expect((await loadMigrations()).find(item => item.version === 97)).toMatchObject({ version: 97, name: 'reconciliation_evidence_unknown_errors' })
  })
})
