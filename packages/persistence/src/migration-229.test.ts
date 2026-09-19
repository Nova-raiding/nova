import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

const migrationSql = () =>
  readFile(new URL('./migrations/229_evidence_and_snapshot_append_only_guards.sql', import.meta.url), 'utf8')

/**
 * The header prose deliberately names the constructs this migration does NOT
 * declare (`BEFORE TRUNCATE`, the two tables it leaves mutable, the call sites
 * that justify leaving them mutable) so the next sweep does not re-open them.
 * Assertions about what the migration *does* have to run against the
 * executable statements, or they would pass/fail on the documentation.
 */
const executableSql = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/--[^\n]*/gu, '')

/**
 * The three tables of the 226 family whose every writer is an unconditional
 * INSERT, whose foreign keys are default `NO ACTION` (or, for
 * `workspace_growth_events`, a workspace CASCADE that no code path reaches),
 * and which no retention, cleanup or data-lifecycle path targets.
 */
const guardedTables = ['context_snapshots', 'task_snapshots', 'workspace_growth_events']

/**
 * Deliberately left mutable — the two tables in the same family with a real
 * in-place rewrite contract. Freezing either would break working code, so this
 * pair is the actual decision in this migration, not an oversight.
 */
const mutableTables = ['manual_publish_evidence', 'workspace_usage_ledger']

const targetArray = async () => {
  const sql = await migrationSql()
  return sql.slice(
    sql.indexOf('targets text[] := ARRAY['),
    sql.indexOf('];', sql.indexOf('targets text[] := ARRAY[')),
  )
}

describe('migration 229 evidence and snapshot append-only guards', () => {
  it('registers at the tail of a contiguous chain without opting out of the runner transaction', async () => {
    const migrations = await loadMigrations()
    const latestVersion = migrations.at(-1)?.version ?? 0

    expect(migrations.find(item => item.version === 229)).toMatchObject({
      version: 229,
      name: 'evidence_and_snapshot_append_only_guards',
    })
    // 229 is the tail today; later migrations extend the chain, so the floor
    // plus the contiguity check below is the invariant, not this constant.
    expect(latestVersion).toBeGreaterThanOrEqual(229)
    expect(migrations.map(migration => migration.version)).toEqual(
      Array.from({ length: latestVersion }, (_, index) => index + 1),
    )
    expect(migrations.find(item => item.version === 229)?.transactional).not.toBe(false)
    expect(migrations.find(item => item.version === 229)?.sql).toContain(
      'DO $evidence_and_snapshot_append_only_guards$',
    )
  })

  it('guards exactly the three tables whose writers are pure INSERT', async () => {
    const arrayLiteral = await targetArray()

    for (const table of guardedTables) expect(arrayLiteral).toContain(`'${table}'`)
    expect(guardedTables).toHaveLength(3)
    // The list is a decision with a boundary: no table outside the 226 family
    // may drift into it.
    expect(arrayLiteral).not.toContain('knowledge_hydration_snapshots')
    expect(arrayLiteral).not.toContain('unified_link_audit')
    expect(arrayLiteral).not.toContain('platform_media_spec_audit')
  })

  it('leaves the two tables with a live row-rewrite contract mutable', async () => {
    const arrayLiteral = await targetArray()
    const sql = await migrationSql()

    for (const table of mutableTables) expect(arrayLiteral).not.toContain(`'${table}'`)
    // The exclusion is a decision, not an oversight: the header has to say so,
    // and it has to name the concrete rewrite each one depends on.
    expect(sql).toContain('`manual_publish_evidence` (218) is a revisioned record, not a log')
    expect(sql).toContain('`workspace_usage_ledger` (019) is the quota consumption ledger')
    expect(sql).toContain('MANUAL_PUBLISH_REVISION_CONFLICT')
    expect(sql).toContain('refunded=true')
    // A row guard on the refund ledger would make it permanently
    // un-refundable, which is the reason this table is out of scope.
    expect(sql).toContain('would make the ledger permanently un-refundable')
  })

  it('records the real call site behind each excluded table', async () => {
    // The prose above is only worth anything if the call sites it cites exist.
    const usageRepository = await readFile(new URL('./usage-repository.ts', import.meta.url), 'utf8')
    const manualPublishEvidence = await readFile(
      new URL('./migrations/218_manual_publish_evidence.sql', import.meta.url),
      'utf8',
    )

    expect(usageRepository).toContain('UPDATE workspace_usage_ledger SET refunded=true')
    expect(usageRepository).toContain('refunded_at=now()')
    // 218 grants the row rewrite while revoking the row delete, which is
    // exactly the asymmetry a row-level append-only guard would contradict.
    expect(manualPublishEvidence).toContain('GRANT SELECT, INSERT, UPDATE ON manual_publish_evidence TO merchant_app')
    expect(manualPublishEvidence).toContain('REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON manual_publish_evidence FROM merchant_app')
    // ...and the revision column that makes the UPDATE meaningful.
    expect(manualPublishEvidence).toContain('revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0)')
  })

  it('rejects row-level UPDATE and DELETE with the 55000 append-only contract', async () => {
    const statements = executableSql(await migrationSql())

    // The defect 226 left open: a statement-level TRUNCATE guard is never
    // fired by UPDATE or DELETE, so the rows stayed editable one at a time.
    expect(statements).toContain('BEFORE UPDATE OR DELETE ON public.%I')
    expect(statements).toContain('FOR EACH ROW EXECUTE FUNCTION reject_evidence_snapshot_mutation()')
    expect(statements).toContain("RAISE EXCEPTION 'evidence table %.% is append-only'")
    expect(statements).toContain("USING ERRCODE = '55000'")
    // The row guard must reject, not silently rewrite the attempted mutation.
    expect(statements).not.toMatch(/RETURN NULL|RETURN OLD|RETURN NEW/u)
  })

  it('declares the rejecting function once for all three tables and names the offending table', async () => {
    const statements = executableSql(await migrationSql())

    // The 225 shape for this family: one definition of the contract so the
    // three tables cannot drift apart, with the diagnostic still per-table.
    expect(statements.match(/CREATE OR REPLACE FUNCTION reject_evidence_snapshot_mutation\(\)/gu)).toHaveLength(1)
    expect(statements).toContain('TG_TABLE_SCHEMA, TG_TABLE_NAME')
    // 227's per-table function was justified by a per-table message; this
    // migration has one message for one contract and says so.
    expect(statements).not.toContain('reject_platform_media_spec_audit_mutation')
  })

  it('does not re-declare the statement-level TRUNCATE guard 226 already owns', async () => {
    const statements = executableSql(await migrationSql())
    const earlier = (await loadMigrations())
      .filter(migration => migration.version < 229)
      .map(migration => migration.sql)
      .join('\n')

    // 226 installs the statement-level guard for all three tables; a second one
    // here would be a second source of truth for a contract already enforced.
    expect(statements).not.toMatch(/BEFORE TRUNCATE/u)
    expect(statements).not.toContain('_no_truncate')
    // 226 derives the trigger name as `<table>_no_truncate`, so the literal
    // never appears per table in its source; the naming convention is the
    // evidence that 229 is not the one declaring it.
    expect(earlier).toContain("target || '_no_truncate'")
    expect(earlier).toContain('BEFORE TRUNCATE ON public.%I')
  })

  it('stays idempotent and re-runnable without dropping data or schema', async () => {
    const statements = executableSql(await migrationSql())

    expect(statements).toContain("DROP TRIGGER IF EXISTS %I ON public.%I")
    expect(statements).toContain('CREATE OR REPLACE FUNCTION')
    expect(statements).not.toMatch(/DELETE\s+FROM|TRUNCATE\s+TABLE|DROP\s+TABLE|DROP\s+FUNCTION|ALTER\s+TABLE|DROP\s+TRIGGER\s+[^I]/iu)
  })

  it('keeps the runtime roles out of the mutation path without widening anything', async () => {
    const statements = executableSql(await migrationSql())

    expect(statements).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON public.%I FROM PUBLIC')
    expect(statements).toContain("IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app')")
    expect(statements).toContain("IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops')")
    expect(statements).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON public.%I FROM merchant_app')
    expect(statements).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON public.%I FROM merchant_ops')
    // A guard only: it never grants a privilege. Scoped to a real GRANT
    // statement so the header prose may still discuss grants.
    expect(statements).not.toMatch(/\bGRANT\s+(SELECT|INSERT|UPDATE|DELETE|TRUNCATE|ALL|REFERENCES|TRIGGER)\b/iu)
    // The REVOKE is inside the same per-table loop as the trigger, so it can
    // never reach the two tables this migration leaves mutable.
    const loop = statements.slice(statements.indexOf('FOREACH target IN ARRAY targets LOOP'))
    expect(loop).toContain('REVOKE UPDATE, DELETE, TRUNCATE')
    expect(statements.indexOf('FOREACH target IN ARRAY targets LOOP')).toBeGreaterThan(-1)
  })

  it('leaves the earlier migrations as the creators of every guarded table', async () => {
    const earlier = (await loadMigrations())
      .filter(migration => migration.version < 229)
      .map(migration => migration.sql)
      .join('\n')

    for (const table of guardedTables) {
      expect(earlier).toMatch(new RegExp(`CREATE TABLE (IF NOT EXISTS )?${table}\\b`))
      // ...and none of them had a row-level guard of its own, which is the
      // defect this migration closes.
      expect(earlier).not.toContain(`BEFORE UPDATE OR DELETE ON ${table}`)
      expect(earlier).not.toContain(`${table}_append_only`)
    }
  })

  it('skips a table that a deployment predates rather than failing the chain', async () => {
    const sql = await migrationSql()

    expect(sql).toContain("IF to_regclass(format('public.%I', target)) IS NULL THEN")
    expect(sql).toContain('CONTINUE')
  })
})
