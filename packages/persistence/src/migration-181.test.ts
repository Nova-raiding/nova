import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 181 commercial checkout resource', () => {
  it('persists only provider-shaped, tenant-scoped checkout resources', async () => {
    const sql = await readFile(new URL('./migrations/181_commercial_checkout_resource.sql', import.meta.url), 'utf8')
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS checkout_url TEXT')
    expect(sql).toContain('checkout_idempotency_key TEXT')
    expect(sql).toContain('UNIQUE INDEX IF NOT EXISTS commercial_orders_v2_checkout_idempotency_idx')
    expect(sql).toContain("checkout_url ~ '^(https://|weixin://|alipays://)'")
  })

  it('is registered in the migration chain', async () => {
    expect((await loadMigrations()).find(item => item.version === 181)).toMatchObject({ version: 181, name: 'commercial_checkout_resource' })
  })
})
