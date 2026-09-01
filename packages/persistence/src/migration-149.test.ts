import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('migration 149 object-storage orphan leases', () => {
  it('adds nullable lease columns for forward-compatible claims', async () => {
    const sql = await readFile(new URL('./migrations/149_object_storage_orphan_leases.sql', import.meta.url), 'utf8')

    expect(sql).toContain('ALTER TABLE object_storage_orphans')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS lease_token text')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS lease_until timestamptz')
    expect(sql).not.toMatch(/NOT NULL/iu)
  })

  it('adds the workspace-scoped claim lookup index in claim order', async () => {
    const sql = await readFile(new URL('./migrations/149_object_storage_orphan_leases.sql', import.meta.url), 'utf8')

    expect(sql).toContain('CREATE INDEX IF NOT EXISTS object_storage_orphans_claim_idx')
    expect(sql).toContain('(workspace_id, state, next_attempt_at, lease_until, created_at)')
  })
})
