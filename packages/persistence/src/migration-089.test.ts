import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 089 merchant intent snapshots', () => {
  it('allows the durable merchant intent entity without weakening tenant scope', async () => {
    const sql = await readFile(new URL('./migrations/089_merchant_intent_snapshots.sql', import.meta.url), 'utf8')
    const migrations = await loadMigrations()
    expect(migrations.find(item => item.version === 89)).toMatchObject({ version: 89, name: 'merchant_intent_snapshots' })
    const latestVersion = Math.max(...migrations.map(item => item.version))
    expect(migrations.map(item => item.version)).toEqual(Array.from({ length: latestVersion }, (_, index) => index + 1))
    expect(sql).toContain("'merchant_intent'")
    expect(sql).toContain('business_entity_snapshots_entity_type_supported_check')
  })
})
