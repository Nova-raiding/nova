import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { loadMigrations } from './migration.js'

describe('migration 093 runtime delete privilege hardening', () => {
  it('revokes destructive privileges from the merchant application role', async () => {
    const sql = await readFile(new URL('./migrations/093_runtime_delete_privilege_hardening.sql', import.meta.url), 'utf8')
    expect(sql).toContain('REVOKE DELETE, TRUNCATE')
    expect(sql).toContain('canonical_products')
    expect(sql).toContain('product_listings')
    expect(sql).toContain('image_generation_executions')
  })

  it('is registered in the executable migration chain', async () => {
    expect((await loadMigrations()).find(item => item.version === 93)).toMatchObject({ version: 93, name: 'runtime_delete_privilege_hardening' })
  })
})
