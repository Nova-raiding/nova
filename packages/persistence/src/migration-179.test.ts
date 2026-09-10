import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 179 campaign item task scope integrity', () => {
  it('remains registered and installs a reciprocal task-scope guard', async () => {
    const migrations = await loadMigrations()
    expect(migrations.find(item => item.version === 179)).toMatchObject({ version: 179, name: 'campaign_item_task_scope_integrity' })
    const sql = await readFile(new URL('./migrations/179_campaign_item_task_scope_integrity.sql', import.meta.url), 'utf8')
    expect(sql).toContain('migration 179 blocked')
    expect(sql).toContain('task_scope.campaign_item_id IS DISTINCT FROM NEW.id')
    expect(sql).toContain('CREATE TRIGGER batch_campaign_items_task_scope_integrity')
  })
})
