import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

const migrationSql = () =>
  readFile(new URL('./migrations/226_evidence_and_snapshot_truncate_guards.sql', import.meta.url), 'utf8')

/**
 * The six tables that had no trigger at all — neither a row-level append-only
 * contract nor a statement-level TRUNCATE guard — but whose rows cannot be
 * recomputed after the fact. Verified against the live catalog: before this
 * migration every one of them reported zero non-internal triggers and an owner
 * `TRUNCATE` succeeded with the row count dropping to zero.
 */
const guardedTables = [
  'context_snapshots',
  'manual_publish_evidence',
  'platform_media_spec_audit',
  'task_snapshots',
  'workspace_growth_events',
  'workspace_usage_ledger',
]

/**
 * Deliberately left unguarded. Both are rebuildable, and both would be the
 * wrong shape to freeze: `knowledge_hydration_snapshots` is a one-row-per-
 * workspace cursor cache that is rewritten on every revision bump, and
 * `unified_link_audit` is an explicitly-labelled projection of a live
 * consistency report rather than durable evidence.
 */
const unguardedTables = ['knowledge_hydration_snapshots', 'unified_link_audit']

describe('migration 226 evidence and snapshot truncate guards', () => {
  it('registers at the tail of a contiguous chain without opting out of the runner transaction', async () => {
    const migrations = await loadMigrations()
    const latestVersion = migrations.at(-1)?.version ?? 0

    expect(migrations.find(item => item.version === 226)).toMatchObject({
      version: 226,
      name: 'evidence_and_snapshot_truncate_guards',
    })
    // 226 was the tail when it landed; later migrations (227+) extend the
    // chain, so assert the floor rather than pinning a version that must keep
    // moving. The contiguity check below is the invariant that actually
    // matters, and it still runs against the real tail.
    expect(latestVersion).toBeGreaterThanOrEqual(226)
    expect(migrations.map(migration => migration.version)).toEqual(
      Array.from({ length: latestVersion }, (_, index) => index + 1),
    )
    expect(migrations.find(item => item.version === 226)?.transactional).not.toBe(false)
    // A DO block and no concurrent index build, so the default transactional
    // posture is the correct one.
    expect(migrations.find(item => item.version === 226)?.sql).toContain('DO $evidence_and_snapshot_truncate_guards$')
  })

  it('guards exactly the six irreplaceable tables this defect covers', async () => {
    const sql = await migrationSql()
    const arrayLiteral = sql.slice(
      sql.indexOf('targets text[] := ARRAY['),
      sql.indexOf('];', sql.indexOf('targets text[] := ARRAY[')),
    )

    for (const table of guardedTables) expect(arrayLiteral).toContain(`'${table}'`)
    expect(guardedTables).toHaveLength(6)
  })

  it('leaves the rebuildable cache and the projection unguarded', async () => {
    const sql = await migrationSql()
    const arrayLiteral = sql.slice(
      sql.indexOf('targets text[] := ARRAY['),
      sql.indexOf('];', sql.indexOf('targets text[] := ARRAY[')),
    )

    for (const table of unguardedTables) expect(arrayLiteral).not.toContain(`'${table}'`)
    // The exclusion is a decision, not an oversight: the header has to say so.
    expect(sql).toContain('knowledge_hydration_snapshots` is a rebuildable cursor cache')
    expect(sql).toContain('`unified_link_audit` is a projection, not evidence')
  })

  it('installs a statement-level BEFORE TRUNCATE trigger per table', async () => {
    const sql = await migrationSql()

    // A row-level trigger is never fired by TRUNCATE; only a statement-level
    // one is.
    expect(sql).toContain('BEFORE TRUNCATE ON public.%I')
    expect(sql).toContain('FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_ledger_truncate()')
    expect(sql).toContain("EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I'")
    expect(sql).not.toMatch(/FOR EACH ROW/u)
  })

  it('reuses 225s shared rejecting function instead of declaring a second one', async () => {
    const sql = await migrationSql()
    const earlier = (await loadMigrations())
      .filter(migration => migration.version < 226)
      .map(migration => migration.sql)
      .join('\n')

    // 225 owns the single definition of the 55000 message contract, and 226
    // always runs after it, so re-declaring it here would only create a second
    // source of truth to drift from.
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION')
    expect(sql).not.toContain('RETURNS trigger')
    expect(earlier).toContain('CREATE OR REPLACE FUNCTION reject_append_only_ledger_truncate()')
    expect(earlier).toContain("RAISE EXCEPTION 'append-only ledger %.% rejects TRUNCATE'")
    // The shared function already names the offending table, so the 55000
    // diagnostic stays per-table without any new error text here.
    expect(earlier).toContain('TG_TABLE_SCHEMA, TG_TABLE_NAME')
  })

  it('stays idempotent and re-runnable without dropping data or schema', async () => {
    const sql = await migrationSql()

    expect(sql).toContain('DROP TRIGGER IF EXISTS')
    // Re-running must be a no-op: nothing here removes rows, tables or the
    // functions the earlier migrations own.
    expect(sql).not.toMatch(/DELETE\s+FROM|TRUNCATE\s+TABLE|DROP\s+TABLE|DROP\s+FUNCTION|ALTER\s+TABLE|DROP\s+TRIGGER\s+[^I]/iu)
  })

  it('keeps the runtime roles out of the truncate path without widening anything', async () => {
    const sql = await migrationSql()

    expect(sql).toContain("EXECUTE format('REVOKE TRUNCATE ON public.%I FROM PUBLIC'")
    expect(sql).toContain("IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app')")
    expect(sql).toContain("IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops')")
    expect(sql).toContain("REVOKE TRUNCATE ON public.%I FROM merchant_app")
    expect(sql).toContain("REVOKE TRUNCATE ON public.%I FROM merchant_ops")
    // A guard only: it never grants a privilege. Scoped to a real GRANT
    // statement so the header prose may still discuss grants.
    expect(sql).not.toMatch(/\bGRANT\s+(SELECT|INSERT|UPDATE|DELETE|TRUNCATE|ALL|REFERENCES|TRIGGER)\b/iu)
  })

  it('leaves the earlier migrations as the creators of every guarded table', async () => {
    const earlier = (await loadMigrations())
      .filter(migration => migration.version < 226)
      .map(migration => migration.sql)
      .join('\n')

    for (const table of guardedTables) {
      // 218 created manual_publish_evidence without IF NOT EXISTS; the rest use
      // the guarded form.
      expect(earlier).toMatch(new RegExp(`CREATE TABLE (IF NOT EXISTS )?${table}\\b`))
      // ...and none of them had a TRUNCATE guard of their own, which is the
      // defect this migration closes.
      expect(earlier).not.toContain(`BEFORE TRUNCATE ON ${table}`)
      expect(earlier).not.toContain(`${table}_no_truncate`)
    }
  })

  it('skips a table that a deployment predates rather than failing the chain', async () => {
    const sql = await migrationSql()

    expect(sql).toContain("IF to_regclass(format('public.%I', target)) IS NULL THEN")
    expect(sql).toContain('CONTINUE')
  })
})
