import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 162 image generation constraint-name repair', () => {
  it('drops legacy constraint names and restores the canonical state fence', async () => {
    const sql = await readFile(new URL('./migrations/162_image_generation_execution_state_constraint_name_repair.sql', import.meta.url), 'utf8')
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS image_generation_executions_state_check')
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS image_generation_execution_state_check')
    expect(sql).toContain('ADD CONSTRAINT image_generation_execution_state_check CHECK')
  })

  it('is registered at version 162', async () => {
    expect((await loadMigrations()).find(item => item.version === 162)).toMatchObject({ version: 162, name: 'image_generation_execution_state_constraint_name_repair' })
  })
})
