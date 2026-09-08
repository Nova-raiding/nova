import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 168 onboarding grant dispatch', () => {
  it('registers after private-trial closure and uses append-only dispatch facts', async () => {
    const migrations = await loadMigrations()
    expect(migrations.find(item => item.version === 168)).toMatchObject({ version: 168, name: 'onboarding_grant_dispatch' })
    expect(migrations.findIndex(item => item.version === 168)).toBe(migrations.findIndex(item => item.version === 167) + 1)
    const sql = await readFile(new URL('./migrations/168_onboarding_grant_dispatch.sql', import.meta.url), 'utf8')
    expect(sql).toContain('CREATE TABLE onboarding_point_grant_dispatches_v2')
    expect(sql).toContain('UNIQUE (workspace_id, schedule_id)')
    expect(sql).toContain('CREATE TABLE onboarding_point_grant_expirations_v2')
    expect(sql).toContain("policy_ref = 'commercial.onboarding.v2'")
    expect(sql).toContain('BEFORE UPDATE OR DELETE OR TRUNCATE')
  })

  it('does not dispatch a schedule whose expiry window has elapsed', async () => {
    const repository = await readFile(new URL('./onboarding-grant-dispatch-repository.ts', import.meta.url), 'utf8')
    expect(repository).toContain("AND due_at <= $2::timestamptz AND expires_at > $2::timestamptz")
    expect(repository).toContain("s.expires_at <= $2::timestamptz")
  })
})
