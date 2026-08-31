import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'

describe('migration 082 knowledge hydration revision repair', () => {
  it('defines an idempotent revision repair for the workspace snapshot table', async () => {
    const sql = await readFile(new URL('./migrations/082_knowledge_hydration_revision_repair.sql', import.meta.url), 'utf8')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS revision')
    expect(sql).toContain('knowledge_hydration_snapshots')
  })
})
