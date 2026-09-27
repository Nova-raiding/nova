import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const bootstrap = readFileSync(new URL('../infra/protected/canonical-safe-state-reader-bootstrap.sql', import.meta.url), 'utf8')
const verifier = readFileSync(new URL('../infra/scripts/verify-canonical-safe-state-reader.sh', import.meta.url), 'utf8')
const runbook = readFileSync(new URL('../docs/runbooks/canonical-safe-state-reader-bootstrap.md', import.meta.url), 'utf8')

describe('canonical safe-state reader bootstrap contract', () => {
  it('uses a dedicated non-privileged login and grants only SELECT on the exact source tables', () => {
    expect(bootstrap).toContain('canonical_safe_state_reader')
    expect(bootstrap).toMatch(/LOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE\s+NOINHERIT NOBYPASSRLS NOREPLICATION/u)
    expect(bootstrap).toContain('BEGIN;')
    expect(bootstrap).toContain('COMMIT;')
    expect(bootstrap).toContain('canonical_safe_state_reader already exists; audit it independently rather than reusing it')
    expect(bootstrap).not.toContain('ALTER ROLE canonical_safe_state_reader\n      LOGIN')
    expect(bootstrap).toContain('GRANT CONNECT ON DATABASE %I TO canonical_safe_state_reader')
    expect(bootstrap).toContain('GRANT USAGE ON SCHEMA public TO canonical_safe_state_reader;')
    expect(bootstrap).toContain('GRANT SELECT ON TABLE')
    expect(bootstrap).toContain('public.workspaces')
    expect(bootstrap).toContain('public.platform_feature_flags')
    expect(bootstrap).toContain('public.platform_feature_flag_targets')
    expect(bootstrap).not.toContain('platform_feature_flag_events')
    expect(bootstrap).not.toMatch(/GRANT\s+(?:ALL|INSERT|UPDATE|DELETE|TRUNCATE)/iu)
    expect(bootstrap).toContain('ALTER ROLE canonical_safe_state_reader CONNECTION LIMIT 2;')
    expect(bootstrap).toContain('ALTER ROLE canonical_safe_state_reader SET default_transaction_read_only = on;')
    expect(bootstrap).toContain('ALTER ROLE canonical_safe_state_reader SET search_path = pg_catalog, public;')
    expect(bootstrap).toContain('FOR SELECT')
    expect(bootstrap).toContain('workspaces must already have ENABLE and FORCE ROW LEVEL SECURITY')
    expect(bootstrap).toContain('feature flag source tables must not hide rows through RLS')
    expect(bootstrap).toContain("acl.grantee = 0")
    expect(bootstrap).toContain("acl.privilege_type = 'TEMPORARY'")
    expect(bootstrap).toContain("acl.privilege_type = 'CONNECT'")
    expect(bootstrap).toContain('database owner must review shared ACL')
  })

  it('validates effective write denial, role isolation, RLS, and single-role execution', () => {
    for (const fragment of [
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      "current_setting('transaction_read_only') = 'on'",
      "current_setting('row_security') = 'on'",
      "NOT has_table_privilege(current_user, relation_name,",
      "'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'",
      'NOT has_any_column_privilege(current_user, relation_name,',
      'has_any_column_privilege(current_user, c.oid,',
      'FROM pg_auth_members',
      'm.member = r.oid OR m.roleid = r.oid',
      'c.relrowsecurity AND c.relforcerowsecurity',
      'AND p.polcmd = \'r\'',
      "NOT has_schema_privilege(current_user, 'public', 'CREATE')",
      'no_other_relation_access',
      'AND (has_table_privilege(current_user, c.oid,',
      "has_database_privilege(current_user, current_database(), 'CONNECT')",
      "has_schema_privilege(current_user, 'public', 'USAGE')",
      "NOT has_database_privilege(current_user, current_database(), 'CREATE,TEMPORARY')",
      'no_other_schema_access',
      'no_sequence_access',
      'no_security_definer_execution',
      'no_owned_objects',
      'no_other_database_access',
      'no_restrictive_reader_policy',
      'flags_unfiltered',
      'read_probe AS MATERIALIZED',
      'FROM public.workspaces LIMIT 1',
      'FROM public.platform_feature_flags LIMIT 1',
      'FROM public.platform_feature_flag_targets LIMIT 1',
      'canonical-safe-state-reader:fail',
      'no evidence was produced',
    ]) expect(verifier).toContain(fragment)
  })

  it('states bootstrap limitations and does not claim signed release evidence', () => {
    expect(runbook).toContain('review-only')
    expect(runbook).toContain('does not sign release evidence')
    expect(runbook).toContain('does not collect canonical state, attest source')
    expect(runbook).toContain('does not prove two shadow cycles')
    expect(runbook).toContain('column-level writes')
    expect(readFileSync(new URL('./canonical-safe-state-column-acl.postgres.sh', import.meta.url), 'utf8')).toContain('postgres:${major}-alpine')
  })
})
