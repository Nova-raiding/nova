import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 164 onboarding grant schedule activation', () => {
  it('registers immediately after migration 163 and preserves one immutable chain entry', async () => {
    const migrations = await loadMigrations()
    expect(migrations.find(item => item.version === 164)).toMatchObject({ version: 164, name: 'onboarding_grant_schedule_activation' })
    expect(migrations.findIndex(item => item.version === 164)).toBe(migrations.findIndex(item => item.version === 163) + 1)
    expect(migrations.filter(item => item.version === 164)).toHaveLength(1)
  })

  it('keeps unresolved rows blocked while constraining activated rows to the frozen policy', async () => {
    const sql = await readFile(new URL('./migrations/164_onboarding_grant_schedule_activation.sql', import.meta.url), 'utf8')
    expect(sql).toContain("status = 'blocked_policy_unresolved'")
    expect(sql).toContain("policy_ref = 'commercial.onboarding.v1'")
    expect(sql).toContain("blockers = '[]'::jsonb")
    expect(sql).toContain('REVOKE UPDATE, DELETE, TRUNCATE')
    expect(sql).toContain('onboarding_grant_schedule_due_idx')
  })
})
