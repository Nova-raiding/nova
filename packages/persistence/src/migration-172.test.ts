import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 172 private trial invites', () => {
  it('adds hashed, tenant-isolated private trial invites after migration 171', async () => {
    const migrations = await loadMigrations()
    expect(migrations.findIndex((item) => item.version === 172)).toBe(
      migrations.findIndex((item) => item.version === 171) + 1,
    )

    const sql = await readFile(
      new URL('./migrations/172_private_trial_invites.sql', import.meta.url),
      'utf8',
    )
    expect(sql).toContain('CREATE TABLE private_trial_invites_v2')
    expect(sql).toContain('invite_code_hash TEXT NOT NULL')
    expect(sql).toContain('FORCE ROW LEVEL SECURITY')
    expect(sql).not.toContain('private_trial_invite_events_v2')
    expect(sql).not.toContain('invite_code TEXT')
  })
})
