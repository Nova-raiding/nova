import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { loadMigrations } from './migration.js'

describe('migration 092 image generation executions', () => {
  it('defines tenant-scoped lease and provider identity constraints', async () => {
    const sql = await readFile(new URL('./migrations/092_image_generation_executions.sql', import.meta.url), 'utf8')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS image_generation_executions')
    expect(sql).toContain('FORCE ROW LEVEL SECURITY')
    expect(sql).toContain("state IN ('available','leased','provider_started','outcome_unknown','completed','failed')")
    expect(sql).toContain('image_generation_execution_provider_request_idx')
    expect(sql).toContain('REFERENCES image_generation_jobs(workspace_id,id)')
  })

  it('is the current executable migration tail', async () => {
    expect((await loadMigrations()).find(item => item.version === 92)).toMatchObject({ version: 92, name: 'image_generation_executions' })
  })

  it('registers the follow-up runtime privilege hardening migration', async () => {
    const sql = await readFile(new URL('./migrations/093_runtime_delete_privilege_hardening.sql', import.meta.url), 'utf8')
    expect(sql).toContain('REVOKE DELETE, TRUNCATE')
    expect(sql).toContain("canonical_products', 'product_listings', 'image_generation_executions")
    expect((await loadMigrations()).find(item => item.version === 95)).toMatchObject({ version: 95, name: 'runtime_append_only_privileges' })
    expect((await loadMigrations()).find(item => item.version === 96)).toMatchObject({ version: 96, name: 'reconciliation_evidence' })
    expect((await loadMigrations()).find(item => item.version === 97)).toMatchObject({ version: 97, name: 'reconciliation_evidence_unknown_errors' })
  })
})
