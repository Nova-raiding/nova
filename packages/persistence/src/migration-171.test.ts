import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 171 commercial refund runtime ACL', () => {
  it('repairs migration 170 forward-only and preserves the tenant RLS boundary', async () => {
    const migrations = await loadMigrations()
    expect(migrations.findIndex((item) => item.version === 171)).toBe(
      migrations.findIndex((item) => item.version === 170) + 1,
    )

    const sql = await readFile(
      new URL('./migrations/171_commercial_refund_runtime_acl.sql', import.meta.url),
      'utf8',
    )
    expect(sql).toContain('REVOKE ALL ON commercial_refund_events_v2 FROM merchant_ops')
    expect(sql).toContain('GRANT SELECT, INSERT ON commercial_refund_events_v2 TO merchant_app')
    expect(sql).toContain('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
    expect(sql).not.toContain('GRANT SELECT, INSERT ON commercial_refund_events_v2 TO merchant_ops')
  })
})
