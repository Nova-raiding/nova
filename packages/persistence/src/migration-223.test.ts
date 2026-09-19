import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migration.js'

const migrationSql = () => readFile(new URL('./migrations/223_merchant_catalog_projection.sql', import.meta.url), 'utf8')

describe('migration 223 merchant catalog projection', () => {
  it('registers the two SECURITY DEFINER projections for the tenant runtime', async () => {
    const sql = await migrationSql()
    expect((await loadMigrations()).find(item => item.version === 223))
      .toMatchObject({ version: 223, name: 'merchant_catalog_projection' })
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.merchant_entitlement_snapshots_v2(p_limit integer)')
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.merchant_onboarding_sku_v2()')
    // Each definition carries the whole 051/066 SECURITY DEFINER shape; the
    // `$function$` quoting keeps a semicolon inside the body from ending it.
    const definitions = sql.split('CREATE OR REPLACE FUNCTION ').slice(1)
    expect(definitions).toHaveLength(2)
    for (const definition of definitions) {
      for (const contract of [
        'LANGUAGE sql',
        'STABLE',
        'SECURITY DEFINER',
        'SET search_path = pg_catalog',
        'SET row_security = off',
        'AS $function$',
        '$function$;',
      ]) expect(definition, contract).toContain(contract)
    }
    // The runner keeps its default transactional posture: no concurrent index
    // build in this file, so the `-- migrate:no-transaction` marker must be
    // absent and `transactional` must not be set to false.
    expect(sql).not.toContain('CREATE INDEX CONCURRENTLY')
    expect(sql.split('\n').some(line => line.trim() === '-- migrate:no-transaction')).toBe(false)
    expect((await loadMigrations()).find(item => item.version === 223)?.transactional).not.toBe(false)
  })

  it('keeps EXECUTE private to the tenant runtime and out of PUBLIC', async () => {
    const sql = await migrationSql()
    for (const signature of ['public.merchant_entitlement_snapshots_v2(integer)', 'public.merchant_onboarding_sku_v2()']) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`)
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO merchant_app;`)
      expect(sql).toContain(`COMMENT ON FUNCTION ${signature} IS`)
    }
    // The role is bootstrapped before migrations in the deployed entrypoint, but
    // a prefix/CI database may not have it yet; 146 sets the same precedent.
    expect(sql).toContain("IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app')")
  })

  it('narrows the entitlement projection to the calling workspace inside the function body', async () => {
    const sql = await migrationSql()
    // `row_security = off` means the forced-RLS policy from 153 does not apply,
    // so the workspace predicate has to be written explicitly or the function
    // becomes a cross-tenant read for every caller that can execute it.
    const body = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.merchant_entitlement_snapshots_v2'))
    expect(body).toContain("WHERE e.workspace_id = current_setting('app.workspace_id', true)")
    // Fail closed when the setting is unset (`= NULL` matches no row) and never
    // widen to a second workspace: the predicate is a single equality, not a
    // disjunction over a caller-supplied scope.
    const predicate = body.slice(body.indexOf('WHERE e.workspace_id'), body.indexOf('ORDER BY e.created_at DESC'))
    expect(predicate).not.toContain(' OR ')
    expect(predicate).not.toContain('IS NULL')
    expect(predicate).not.toContain('coalesce')
    // The limit is clamped by the function; the repository keeps its own 1..200
    // range check on top.
    expect(body).toContain('LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 200)')
    expect(body).toContain('ORDER BY e.created_at DESC, e.id DESC')
    for (const column of ['sku_code', 'resolved_benefits', 'unresolved_blockers', 'period_status', 'catalog_version_id']) expect(body).toContain(column)
    // The onboarding projection is global by construction: it returns the one
    // approved, executable, public `onboarding_once` catalog snapshot and no
    // tenant-scoped relation.
    const onboarding = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.merchant_onboarding_sku_v2'))
    expect(onboarding).toContain("WHERE s.code = 'onboarding_once'")
    expect(onboarding).toContain("AND v.lifecycle = 'approved'")
    expect(onboarding).toContain('AND v.executable = true')
    expect(onboarding).toContain('LIMIT 2')
    expect(onboarding).not.toContain('workspace_id')
  })
})
