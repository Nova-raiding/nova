import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

const migrationSql = () =>
  readFile(new URL('./migrations/227_platform_media_spec_audit_append_only.sql', import.meta.url), 'utf8')

/**
 * The header prose deliberately names the constructs this migration does NOT
 * declare (`BEFORE TRUNCATE`, `DELETE FROM`, ...) so the next sweep does not
 * re-open them. Assertions about what the migration *does* have to run against
 * the executable statements, or they would pass/fail on the documentation.
 */
const executableSql = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/--[^\n]*/gu, '')

describe('migration 227 platform media spec audit append-only', () => {
  it('registers at the tail of a contiguous chain without opting out of the runner transaction', async () => {
    const migrations = await loadMigrations()
    const latestVersion = migrations.at(-1)?.version ?? 0

    expect(migrations.find(item => item.version === 227)).toMatchObject({
      version: 227,
      name: 'platform_media_spec_audit_append_only',
    })
    // 227 is the tail today; later migrations extend the chain, so the floor
    // plus the contiguity check below is the invariant, not this constant.
    expect(latestVersion).toBeGreaterThanOrEqual(227)
    expect(migrations.map(migration => migration.version)).toEqual(
      Array.from({ length: latestVersion }, (_, index) => index + 1),
    )
    expect(migrations.find(item => item.version === 227)?.transactional).not.toBe(false)
    expect(migrations.find(item => item.version === 227)?.sql).toContain(
      'CREATE OR REPLACE FUNCTION reject_platform_media_spec_audit_mutation()',
    )
  })

  it('rejects row-level UPDATE and DELETE with the 55000 append-only contract', async () => {
    const sql = await migrationSql()
    const statements = executableSql(sql)

    // The defect 226 left open: a statement-level TRUNCATE guard is never
    // fired by UPDATE or DELETE, so the rows stayed editable one at a time.
    expect(statements).toContain('BEFORE UPDATE OR DELETE ON platform_media_spec_audit')
    expect(statements).toContain('FOR EACH ROW EXECUTE FUNCTION reject_platform_media_spec_audit_mutation()')
    expect(statements).toContain("RAISE EXCEPTION 'platform media specification audit is append-only'")
    expect(statements).toContain("USING ERRCODE = '55000'")
    // The row guard must reject, not silently rewrite the attempted mutation.
    expect(statements).not.toMatch(/RETURN NULL|RETURN OLD|RETURN NEW/u)
  })

  it('does not re-declare the statement-level TRUNCATE guard 226 already owns', async () => {
    const sql = await migrationSql()
    const earlier = (await loadMigrations())
      .filter(migration => migration.version < 227)
      .map(migration => migration.sql)
      .join('\n')

    // 226 installs the statement-level guard for this table; a second one here
    // would be a second source of truth for a contract already enforced.
    expect(executableSql(sql)).not.toMatch(/BEFORE TRUNCATE/u)
    expect(executableSql(sql)).not.toContain('_no_truncate')
    // 226 derives the trigger name as `<table>_no_truncate`, so the literal
    // `platform_media_spec_audit_no_truncate` never appears in its source; the
    // table name plus the naming convention is the real evidence.
    expect(earlier).toContain("'platform_media_spec_audit'")
    expect(earlier).toContain("target || '_no_truncate'")
    expect(earlier).toContain('BEFORE TRUNCATE ON public.%I')
  })

  it('stays idempotent and re-runnable without dropping data or schema', async () => {
    const statements = executableSql(await migrationSql())

    expect(statements).toContain('DROP TRIGGER IF EXISTS platform_media_spec_audit_append_only')
    expect(statements).toContain('CREATE OR REPLACE FUNCTION')
    expect(statements).not.toMatch(/DELETE\s+FROM|TRUNCATE\s+TABLE|DROP\s+TABLE|DROP\s+FUNCTION|ALTER\s+TABLE|DROP\s+TRIGGER\s+[^I]/iu)
  })

  it('keeps the runtime roles out of the mutation path without widening anything', async () => {
    const statements = executableSql(await migrationSql())

    expect(statements).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON platform_media_spec_audit FROM PUBLIC')
    expect(statements).toContain("IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app')")
    expect(statements).toContain("IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops')")
    expect(statements).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON platform_media_spec_audit FROM merchant_app')
    expect(statements).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON platform_media_spec_audit FROM merchant_ops')
    // A guard only: it never grants a privilege, and it never revokes the
    // INSERT/SELECT that make merchant_ops the legitimate writer and reader.
    expect(statements).not.toMatch(/\bGRANT\b/iu)
    expect(statements).not.toMatch(/REVOKE[^;]*\b(INSERT|SELECT)\b/iu)
  })

  it('leaves the table itself owned by the migration that created it', async () => {
    const statements = executableSql(await migrationSql())
    const earlier = (await loadMigrations())
      .filter(migration => migration.version < 227)
      .map(migration => migration.sql)
      .join('\n')

    // 066 created the table; 227 only adds the guard on top of it.
    expect(earlier).toMatch(/CREATE TABLE IF NOT EXISTS platform_media_spec_audit\b/)
    expect(statements).not.toMatch(/CREATE\s+TABLE/iu)
    expect(statements).not.toMatch(/CREATE\s+(UNIQUE\s+)?INDEX/iu)
  })
})
