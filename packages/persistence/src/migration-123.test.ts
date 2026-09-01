import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 123 commercial order snapshots', () => {
  it('registers an immutable, tenant-scoped snapshot table and backfills safely', async () => {
    const migrations = await loadMigrations()
    expect(migrations.find(item => item.version === 123)).toMatchObject({ version: 123, name: 'commercial_order_snapshots' })
    const sql = await readFile(new URL('./migrations/123_commercial_order_snapshots.sql', import.meta.url), 'utf8')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS commercial_order_snapshots')
    expect(sql).toContain('UNIQUE REFERENCES workspace_subscription_orders')
    expect(sql).toContain('FORCE ROW LEVEL SECURITY')
    expect(sql).toContain('commercial_order_snapshots_immutable')
    expect(sql).toContain('INSERT INTO commercial_order_snapshots')
    expect(sql).not.toMatch(/DELETE\s+FROM\s+workspace_subscription_orders|UPDATE\s+workspace_subscription_orders/iu)
  })
})
