import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 083 billing actor attribution', () => {
  it('registers immutable ownership columns and actor indexes without guessing legacy ownership', async () => {
    const sql = await readFile(new URL('./migrations/083_billing_actor_attribution.sql', import.meta.url), 'utf8')
    const migrations = await loadMigrations()
    expect(migrations.find(migration => migration.version === 83)).toMatchObject({ version: 83, name: 'billing_actor_attribution', sql })
    expect(sql).toContain('billing_orders')
    expect(sql).toContain('billing_transactions')
    expect(sql).toContain('workspace_subscription_orders')
    expect(sql).toContain('created_by_actor_id')
    expect(sql).toContain('actor_id')
    expect(sql).not.toMatch(/UPDATE\s+(billing_orders|billing_transactions|workspace_subscription_orders)/iu)
  })
})
