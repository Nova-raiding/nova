import { describe, expect, it } from 'vitest'
import { concurrentIndexNames, loadMigrations } from './migration.js'

describe('migration 222 ops audit center page indexes', () => {
  it('registers as a non-transactional chain member after a contiguous 001-221 prefix', async () => {
    const migrations = await loadMigrations()
    const latestVersion = migrations.at(-1)?.version ?? 0

    expect(migrations.find(item => item.version === 222))
      .toMatchObject({ version: 222, name: 'ops_audit_center_page_indexes', transactional: false })
    // The chain stays a contiguous prefix; later migrations (223) append after
    // this one instead of taking over its non-transactional registry entry.
    expect(migrations.map(migration => migration.version)).toEqual(
      Array.from({ length: latestVersion }, (_, index) => index + 1),
    )
  })

  it('carries the no-transaction marker its registry entry requires', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 222)
    const sql = migration?.sql ?? ''

    // CONCURRENTLY cannot run inside a transaction block, so the file marker and
    // the registry `transactional: false` flag have to agree; the shell runner
    // greps for the marker and the TypeScript runner reads the flag.
    expect(sql.split('\n')[0]).toBe('-- migrate:no-transaction')
    expect(migration?.transactional).toBe(false)
    expect(sql).not.toMatch(/\bBEGIN\b|\bCOMMIT\b/)
  })

  it('builds one tenant-leading page index per unindexed ops_audit_center branch', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 222)
    const sql = migration?.sql ?? ''

    // Equality column first, then the view's ORDER BY columns in the same
    // direction, so each UNION ALL branch of ops_audit_center can feed the
    // Merge Append already sorted instead of Seq Scan + Sort of the tenant's
    // whole history.
    expect(sql).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS rule_audit_events_workspace_occurred_id_idx\s+ON rule_audit_events \(workspace_id, occurred_at DESC, id DESC\);/u)
    expect(sql).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS ops_incident_timeline_workspace_created_id_idx\s+ON ops_incident_timeline \(workspace_id, created_at DESC, id DESC\);/u)
    expect(sql).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS workspace_support_ticket_events_workspace_created_id_idx\s+ON workspace_support_ticket_events \(workspace_id, created_at DESC, id DESC\);/u)
    expect(concurrentIndexNames(sql)).toEqual([
      'rule_audit_events_workspace_occurred_id_idx',
      'ops_incident_timeline_workspace_created_id_idx',
      'workspace_support_ticket_events_workspace_created_id_idx',
    ])
  })

  it('adds no schema, privilege or data surface beyond the three indexes', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 222)
    const sql = migration?.sql ?? ''

    expect(sql).not.toMatch(/CREATE TABLE|ALTER TABLE|DROP INDEX|REVOKE|GRANT|UPDATE |DELETE FROM|CREATE OR REPLACE VIEW/u)
    expect((sql.match(/CREATE INDEX CONCURRENTLY/gu) ?? [])).toHaveLength(3)
  })

  it('leaves the audit-center projection from 059 in place', async () => {
    const auditCenter = (await loadMigrations()).find(item => item.version === 59)
    const sql = auditCenter?.sql ?? ''

    // 222 is an index-only follow-up: the view definition and its append-only
    // guards stay owned by 059.
    expect(sql).toContain('CREATE OR REPLACE VIEW ops_audit_center')
    expect(sql).not.toContain('rule_audit_events_workspace_occurred_id_idx')
  })
})
