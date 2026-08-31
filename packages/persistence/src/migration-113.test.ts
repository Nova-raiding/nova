import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('migration 113 support SLA events', () => {
  it('extends the append-only event allowlist for worker SLA actions', async () => {
    const sql = await readFile(new URL('./migrations/113_support_sla_events.sql', import.meta.url), 'utf8')
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS workspace_support_ticket_events_event_type_check')
    expect(sql).toContain("'sla_at_risk','sla_breached'")
    expect(sql).toContain('ADD CONSTRAINT workspace_support_ticket_events_event_type_check')
  })
})
