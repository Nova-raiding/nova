import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 154 service fulfillment and onboarding schedule', () => {
  it('creates tenant-scoped allocations and immutable correction evidence', async () => {
    const sql = await readFile(new URL('./migrations/154_service_fulfillment_and_onboarding_schedule.sql', import.meta.url), 'utf8')
    expect(sql).toContain('CREATE TABLE workspace_service_allocations')
    expect(sql).toContain('CREATE TABLE workspace_service_fulfillment_events')
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY')
    expect(sql).toContain('FORCE ROW LEVEL SECURITY')
    expect(sql).toContain('WITH CHECK')
    expect(sql).toContain('before_state JSONB NOT NULL')
    expect(sql).toContain('after_state JSONB NOT NULL')
    expect(sql).toContain('workspace_service_fulfillment_events_append_only')
  })

  it('extends the single contract schedule while keeping dates unresolved', async () => {
    const sql = await readFile(new URL('./migrations/154_service_fulfillment_and_onboarding_schedule.sql', import.meta.url), 'utf8')
    expect(sql).toContain('ALTER TABLE onboarding_point_grant_schedules_v2')
    expect(sql).not.toContain('CREATE TABLE onboarding_point_grant_schedules (')
    expect(sql).toContain('ONBOARDING_GRANT_START_DATE_UNRESOLVED')
    expect(sql).toContain('ONBOARDING_GRANT_EXPIRY_RULE_UNRESOLVED')
  })

  it('remains registered before later recovery migrations', async () => {
    expect((await loadMigrations()).find(item => item.version === 154)).toMatchObject({ version: 154, name: 'service_fulfillment_and_onboarding_schedule' })
  })
})
