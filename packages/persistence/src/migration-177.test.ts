import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('manual rule source reclassification migrations', () => {
  it('registers after the private trial benefits migration', async () => {
    const migrations = await loadMigrations()
    expect(migrations.at(-3)).toMatchObject({ version: 177, name: 'reclassify_manual_rule_sources' })
    expect(migrations.at(-2)).toMatchObject({ version: 178, name: 'reclassify_manual_rule_sources_again' })
    expect(migrations.at(-1)).toMatchObject({ version: 179, name: 'campaign_item_task_scope_integrity' })
  })

  it('only downgrades manual references from official to internal', async () => {
    const sql = await readFile(new URL('./migrations/177_reclassify_manual_rule_sources.sql', import.meta.url), 'utf8')
    expect(sql).toContain("SET source_kind = 'internal'")
    expect(sql).toContain("source_kind = 'official'")
    expect(sql).toContain("source_reference LIKE 'manual://%'")
  })
})
