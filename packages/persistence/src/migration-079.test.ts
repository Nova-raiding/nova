import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('migration 079 knowledge hydration snapshots', () => {
  it('stores one workspace-scoped projection with an ordered cursor', async () => {
    const sql = await readFile(new URL('./migrations/079_knowledge_hydration_snapshots.sql', import.meta.url), 'utf8')
    expect(sql).toContain('workspace_id text PRIMARY KEY REFERENCES workspaces(id)')
    expect(sql).toContain('cursor_created_at timestamptz NOT NULL')
    expect(sql).toContain('cursor_event_id text NOT NULL')
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY')
    expect(sql).toContain('FORCE ROW LEVEL SECURITY')
  })
})
