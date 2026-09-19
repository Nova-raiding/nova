import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 220 commercial refund cumulative bound', () => {
  // 220 is a released artifact and stays byte-for-byte intact. Its revision
  // based projection could be bypassed by appending a non-money revision to an
  // approved request (paid = 500000 while completed = 1000000); migration 221
  // supersedes the function with an amount based bound. These assertions
  // describe the historical artifact only — the effective trigger is the one
  // 221 installs last.
  it('registers a database-level backstop for the cumulative refund bound', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 220)
    expect(migration).toMatchObject({ version: 220, name: 'commercial_refund_cumulative_bound' })
    const sql = migration?.sql ?? ''
    expect(sql).toContain('CREATE OR REPLACE FUNCTION enforce_commercial_refund_cumulative_bound()')
    expect(sql).toContain('BEFORE INSERT ON commercial_refund_events_v2')
    expect(sql).toContain('DROP TRIGGER IF EXISTS commercial_refund_events_v2_cumulative_bound')
    // Only money-committing events are bounded, each request counted once at
    // its highest revision.
    expect(sql).toContain("NEW.event_type NOT IN ('approved', 'completed')")
    expect(sql).toContain('SELECT DISTINCT ON (request_id) request_id, event_type, amount_fen')
    expect(sql).toContain("latest.event_type IN ('approved', 'completed')")
    expect(sql).toContain('latest.request_id <> NEW.request_id')
    // A completed refund must never pay out an order that already left 'paid'.
    expect(sql).toContain("NEW.event_type = 'completed' AND order_status <> 'paid'")
    // No data rewrite and no new privilege surface.
    expect(sql).not.toContain('UPDATE commercial_refund_events_v2')
    expect(sql).not.toContain('DELETE FROM')
    expect(sql).not.toContain('GRANT')
    expect(sql).not.toContain('ALTER TABLE')
  })
})
