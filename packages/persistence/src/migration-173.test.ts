import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 173 private trial invite events', () => {
  it('adds append-only, tenant-isolated redemption facts as a forward migration', async () => {
    const migrations = await loadMigrations()
    expect(migrations.findIndex((item) => item.version === 173)).toBe(
      migrations.findIndex((item) => item.version === 172) + 1,
    )
    const sql = await readFile(new URL('./migrations/173_private_trial_invite_events.sql', import.meta.url), 'utf8')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS private_trial_invite_events_v2')
    expect(sql).toContain('FORCE ROW LEVEL SECURITY')
    expect(sql).toContain('private_trial_invite_events_v2_append_only')
    expect(sql).toContain('private_trial_invite_events_v2_no_truncate')
    expect(sql).toContain('GRANT SELECT, INSERT ON private_trial_invite_events_v2 TO merchant_app')
  })
})
