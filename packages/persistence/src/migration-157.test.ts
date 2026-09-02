import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 157 service fulfillment audit evidence', () => {
  it('adds forward-only onboarding schedule actor/reason/evidence requirements', async () => {
    const sql = await readFile(new URL('./migrations/157_service_fulfillment_audit_evidence.sql', import.meta.url), 'utf8')
    expect(sql).toContain('ALTER TABLE onboarding_point_grant_schedules_v2')
    expect(sql).toContain('created_by_actor_id TEXT')
    expect(sql).toContain('creation_reason TEXT')
    expect(sql).toContain('creation_evidence JSONB')
    expect(sql).toContain('BEFORE INSERT ON onboarding_point_grant_schedules_v2')
    expect(sql).not.toContain('ALTER TABLE workspace_service_allocations')
  })

  it('keeps the deployed 154 bytes at the database-recorded checksum', async () => {
    const sql = await readFile(new URL('./migrations/154_service_fulfillment_and_onboarding_schedule.sql', import.meta.url), 'utf8')
    const { createHash } = await import('node:crypto')
    expect(createHash('sha256').update(sql).digest('hex')).toBe('bca300d3c3fee943d64013ff4e9d7e446f16655eaaedc54f08a23813aabd4f16')
  })

  it('is registered in the migration chain', async () => {
    expect((await loadMigrations()).find(item => item.version === 157)).toMatchObject({ version: 157, name: 'service_fulfillment_audit_evidence' })
  })
})
