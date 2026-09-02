import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

describe('migration 159 commercial point adjustment approvals', () => {
  it('creates immutable workspace-scoped proposal and decision facts', async () => {
    const sql = await readFile(new URL('./migrations/159_commercial_point_adjustment_approvals.sql', import.meta.url), 'utf8')
    expect(sql).toContain('CREATE TABLE commercial_point_adjustment_proposals_v2')
    expect(sql).toContain('CREATE TABLE commercial_point_adjustment_decisions_v2')
    expect(sql).toContain('FORCE ROW LEVEL SECURITY')
    expect(sql).toContain("current_setting(''app.workspace_id'', true)")
    expect(sql).toContain('BEFORE UPDATE OR DELETE')
    expect(sql).toContain('BEFORE TRUNCATE')
    expect(sql).toContain('UNIQUE (workspace_id, proposal_id)')
    expect(sql).toContain('UNIQUE (workspace_id, idempotency_key)')
    expect(sql).toContain('require_distinct_commercial_point_adjustment_approver')
    expect(sql).toContain('proposal.proposed_by_actor_id = NEW.actor_id')
  })

  it('is registered at version 159', async () => {
    expect((await loadMigrations()).find(item => item.version === 159)).toMatchObject({ version: 159, name: 'commercial_point_adjustment_approvals' })
  })
})
