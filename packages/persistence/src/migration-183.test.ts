import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 183 knowledge persistence', () => {
  it('registers durable documents/chunks/embeddings, bindings, lifecycle evidence and forced workspace RLS', async () => {
    const migrations = await loadMigrations()
    expect(migrations.find(item => item.version === 183)).toMatchObject({ name: 'knowledge_persistence' })
    const sql = await readFile(new URL('./migrations/183_knowledge_persistence.sql', import.meta.url), 'utf8')
    for (const table of ['knowledge_assets', 'knowledge_documents', 'knowledge_chunks', 'knowledge_embeddings', 'knowledge_asset_bindings', 'knowledge_index_events', 'knowledge_deletion_proofs']) expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
    expect(sql).toContain('FORCE ROW LEVEL SECURITY')
    expect(sql).toContain("current_setting(''app.workspace_id'', true)")
    for (const state of ['queued', 'indexing', 'ready', 'stale', 'failed', 'deleted']) expect(sql).toContain(`'${state}'`)
  })
})
