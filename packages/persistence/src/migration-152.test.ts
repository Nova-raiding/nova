import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 152 authorization grant scope integrity', () => {
  it('installs an exact workspace scope trigger for inserts and updates', async () => {
    const sql = await readFile(new URL('./migrations/152_authorization_grant_scope_integrity.sql', import.meta.url), 'utf8')

    expect(sql).toContain("NEW.resource_scope->>'type' IS DISTINCT FROM 'workspace'")
    expect(sql).toContain("NEW.resource_scope->'ids'->>0 IS DISTINCT FROM NEW.workspace_id")
    expect(sql).toContain('BEFORE INSERT OR UPDATE OF workspace_id, resource_scope')
    expect(sql).toContain("RAISE EXCEPTION 'ops access grant scope is invalid'")
  })

  it('is registered in the migration chain', async () => {
    expect((await loadMigrations()).find(item => item.version === 152)).toMatchObject({
      version: 152,
      name: 'authorization_grant_scope_integrity',
    })
  })
})
