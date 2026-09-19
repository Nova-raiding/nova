import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 221 commercial refund amount bound', () => {
  it('restates the cumulative bound over amounts instead of the highest revision', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 221)
    expect(migration).toMatchObject({ version: 221, name: 'commercial_refund_amount_bound' })
    const sql = migration?.sql ?? ''
    // 220 is a released artifact and stays untouched; 221 supersedes its
    // function body so every database converges to the corrected bound.
    expect(sql).toContain('CREATE OR REPLACE FUNCTION enforce_commercial_refund_cumulative_bound()')
    expect(sql).toContain('DROP TRIGGER IF EXISTS commercial_refund_events_v2_cumulative_bound')
    expect(sql).toContain('BEFORE INSERT ON commercial_refund_events_v2')
    // A request commits the maximum amount it was ever approved/completed for:
    // a later non-money revision cannot erase it, so the bound cannot be
    // lowered from 500000 to 0 by appending a cheap 'requested' revision.
    expect(sql).toContain('MAX(amount_fen) AS amount_fen')
    expect(sql).toContain("event_type IN ('approved', 'completed')")
    expect(sql).toContain('GROUP BY request_id')
    expect(sql).toContain('GREATEST(own_request_fen, NEW.amount_fen)')
    expect(sql).not.toContain('DISTINCT ON (request_id)')
    // Only money-committing events are bounded; a completed refund must never
    // pay out an order that already left 'paid'.
    expect(sql).toContain("NEW.event_type NOT IN ('approved', 'completed')")
    expect(sql).toContain("NEW.event_type = 'completed' AND order_status <> 'paid'")
    // Append-only stays intact: no data rewrite and no new privilege surface.
    expect(sql).not.toContain('UPDATE commercial_refund_events_v2')
    expect(sql).not.toContain('DELETE FROM')
    expect(sql).not.toContain('GRANT')
    expect(sql).not.toContain('ALTER TABLE')
  })
})
