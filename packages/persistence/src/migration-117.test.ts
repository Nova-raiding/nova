import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 117 image generation provider operation reservation', () => {
  it('adds a tenant-scoped durable operation key before provider dispatch', async () => {
    const sql = await readFile(new URL('./migrations/117_image_generation_provider_operation_reservation.sql', import.meta.url), 'utf8')
    const migrations = await loadMigrations()
    expect(migrations.find(item => item.version === 117)).toMatchObject({ version: 117, name: 'image_generation_provider_operation_reservation' })
    expect(sql).toContain('provider_operation_key')
    expect(sql).toContain('UNIQUE INDEX')
    expect(sql).toContain('length(provider_operation_key) <= 255')
    expect(sql).toContain("state IN ('provider_reserved','provider_dispatching')")
    expect(sql).toContain('image_generation_execution_dispatch_recovery_idx')
  })
})
