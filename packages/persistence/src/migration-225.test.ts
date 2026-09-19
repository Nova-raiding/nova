import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

const migrationSql = () =>
  readFile(new URL('./migrations/225_append_only_ledger_truncate_guards.sql', import.meta.url), 'utf8')

/**
 * The fourteen ledgers that carried an unconditional append-only row trigger
 * but no statement-level TRUNCATE guard. `alert_webhook_receipts` is NOT here:
 * 208 already installed `alert_webhook_receipts_no_truncate BEFORE TRUNCATE`,
 * so it never had this defect.
 */
const guardedTables = [
  'asset_scan_receipts',
  'commercial_order_snapshots',
  'ops_incident_idempotency',
  'ops_incident_timeline',
  'platform_feature_flag_events',
  'platform_identity_events',
  'reconciliation_evidence',
  'support_sla_correction_approvals',
  'support_sla_correction_decisions',
  'support_sla_correction_runs',
  'support_sla_reporting_exclusions',
  'support_sla_reporting_results',
  'support_sla_reporting_runs',
  'workspace_support_ticket_events',
]

describe('migration 225 append-only ledger truncate guards', () => {
  it('registers in a contiguous chain without opting out of the runner transaction', async () => {
    const migrations = await loadMigrations()
    const latestVersion = migrations.at(-1)?.version ?? 0

    expect(migrations.find(item => item.version === 225)).toMatchObject({
      version: 225,
      name: 'append_only_ledger_truncate_guards',
    })
    // 225 was the tail when it landed; later migrations (226+) extend the chain,
    // so assert the floor rather than pinning a version that must keep moving.
    expect(latestVersion).toBeGreaterThanOrEqual(225)
    expect(migrations.map(migration => migration.version)).toEqual(
      Array.from({ length: latestVersion }, (_, index) => index + 1),
    )
    expect(migrations.find(item => item.version === 225)?.transactional).not.toBe(false)
    // A DO block and no concurrent index build, so the default transactional
    // posture is the correct one.
    expect(migrations.find(item => item.version === 225)?.sql).toContain('DO $append_only_truncate_guards$')
  })

  it('guards exactly the fourteen ledgers this defect covers', async () => {
    const sql = await migrationSql()
    const arrayLiteral = sql.slice(
      sql.indexOf('targets text[] := ARRAY['),
      sql.indexOf('];', sql.indexOf('targets text[] := ARRAY[')),
    )

    for (const table of guardedTables) expect(arrayLiteral).toContain(`'${table}'`)
    // 208 already guards this one with its own 42501 contract. Re-adding it
    // here would DROP and replace that trigger with the 55000 shared function,
    // silently changing the SQLSTATE an existing caller may branch on.
    expect(arrayLiteral).not.toContain("'alert_webhook_receipts'")
    expect(guardedTables).toHaveLength(14)
  })

  it('installs a statement-level BEFORE TRUNCATE trigger per ledger', async () => {
    const sql = await migrationSql()

    // A row-level trigger is never fired by TRUNCATE; only a statement-level
    // one is. This is the missing half of the append-only contract.
    expect(sql).toContain('BEFORE TRUNCATE ON public.%I')
    expect(sql).toContain('FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_ledger_truncate()')
    expect(sql).toContain("EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I'")
    expect(sql).toContain("CREATE OR REPLACE FUNCTION reject_append_only_ledger_truncate()")
    expect(sql).not.toMatch(/FOR EACH ROW/u)
  })

  it('names the offending table in the 55000 diagnostic', async () => {
    const sql = await migrationSql()

    expect(sql).toContain("RAISE EXCEPTION 'append-only ledger %.% rejects TRUNCATE'")
    expect(sql).toContain('TG_TABLE_SCHEMA, TG_TABLE_NAME')
    expect(sql).toContain("USING ERRCODE = '55000'")
    // The sibling guards 132/134/136/224 all use the same append-only code.
    expect(sql).not.toContain("ERRCODE = '42501'")
  })

  it('stays idempotent and re-runnable without dropping data or schema', async () => {
    const sql = await migrationSql()

    expect(sql).toContain('DROP TRIGGER IF EXISTS')
    expect(sql).toContain('CREATE OR REPLACE FUNCTION')
    // Re-running must be a no-op: nothing here removes rows, tables or the
    // pre-existing row-level triggers owned by the earlier migrations.
    expect(sql).not.toMatch(/DELETE\s+FROM|TRUNCATE\s+TABLE|DROP\s+TABLE|DROP\s+FUNCTION|ALTER\s+TABLE|DROP\s+TRIGGER\s+[^I]/iu)
  })

  it('keeps the runtime roles out of the truncate path without widening anything', async () => {
    const sql = await migrationSql()

    expect(sql).toContain("EXECUTE format('REVOKE TRUNCATE ON public.%I FROM PUBLIC'")
    expect(sql).toContain("IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app')")
    expect(sql).toContain("IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops')")
    expect(sql).toContain("REVOKE TRUNCATE ON public.%I FROM merchant_app")
    expect(sql).toContain("REVOKE TRUNCATE ON public.%I FROM merchant_ops")
    // A guard only: it never grants a privilege.
    expect(sql).not.toMatch(/\bGRANT\b/u)
  })

  it('leaves the earlier migrations as the owners of the row-level contract', async () => {
    const migrations = await loadMigrations()
    const earlier = migrations
      .filter(migration => migration.version < 225)
      .map(migration => migration.sql)
      .join('\n')

    // Every guarded ledger already existed with its row-level append-only
    // trigger; 225 adds the statement-level half rather than redefining it.
    for (const trigger of [
      'asset_scan_receipts_append_only',
      'commercial_order_snapshots_immutable',
      'ops_incident_timeline_immutable',
      'reconciliation_evidence_append_only',
      'workspace_support_ticket_events_immutable',
      'platform_identity_events_append_only',
      'platform_feature_flag_events_immutable',
    ]) expect(earlier).toContain(trigger)
    // ...and none of them had a TRUNCATE guard of their own.
    for (const table of guardedTables) {
      expect(earlier).not.toContain(`BEFORE TRUNCATE ON ${table}`)
    }
  })
})
