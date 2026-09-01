import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const scriptPath = 'infra/scripts/verify-runtime-db-role.sh'

describe('runtime database role verification', () => {
  it('validates the special workspaces and workspace_members policy shapes explicitly', () => {
    const source = readFileSync(scriptPath, 'utf8')

    expect(source).toContain("special_policy_failures=")
    expect(source).toContain("workspaces_workspace_isolation")
    expect(source).toContain("workspace_members_select_scope")
    expect(source).toContain("workspace_members_insert_scope")
    expect(source).toContain("workspace_members_update_scope")
    expect(source).toContain("workspace_members_delete_scope")
    expect(source).toContain('workspace_identity_bindings_identity_scope')
    expect(source).toContain('workspace_commercial_settings_select_scope')
    expect(source).toContain('workspace_subscriptions_select_scope')
    expect(source).toContain('special_scoped_failures=')
    expect(source).not.toContain("tablename <> 'workspace_members'")
  })

  it('runs positive and cross-tenant read/write probes for both special tables', () => {
    const source = readFileSync(scriptPath, 'utf8')

    expect(source).toContain('runtime RLS dynamic probe failed')
    expect(source).toContain('own workspace is not visible')
    expect(source).toContain('foreign workspace is visible')
    expect(source).toContain('own workspace member is not visible')
    expect(source).toContain('foreign workspace member is visible')
    expect(source).toContain('cross-workspace insert was allowed')
    expect(source).toContain('cross-workspace member insert was allowed')
    expect(source).toContain('foreign workspace update was allowed')
    expect(source).toContain('foreign workspace member delete was allowed')
  })

  it('checks both runtime roles for privilege escalation and table ownership', () => {
    const source = readFileSync(scriptPath, 'utf8')

    expect(source).toContain('Ops database role must not be a superuser')
    expect(source).toContain('Ops database role must not bypass RLS')
    expect(source).toContain('Ops database role must not own public application tables')
    expect(source).toContain('Ops database role lacks platform control-plane access')
    expect(source).toContain('Ops database role has unexpected tenant write access')
    expect(source).toContain("'authorization_revisions','authorization_execution_reservations','platform_role_assignments','platform_role_assignment_events','ops_access_grants','ops_access_grant_events'")
    expect(source).toContain("'authorization_execution_reservations'")
    expect(source).toContain("'workspace_subscriptions', 'ops_access_grants', 'ops_access_grant_events'")
  })

  it('re-applies the migration 105 tenant-role deny after local compatibility grants', () => {
    const bootstrap = readFileSync('infra/local/ensure-app-role.sql', 'utf8')

    expect(bootstrap).toContain("to_regclass('public.authorization_revisions')")
    expect(bootstrap).toContain(
      'REVOKE ALL ON authorization_revisions, authorization_execution_reservations, platform_role_assignments, platform_role_assignment_events, ops_access_grants, ops_access_grant_events FROM merchant_app',
    )
  })

  it('keeps model cost budget reservations non-destructive after local compatibility grants', () => {
    const bootstrap = readFileSync('infra/local/ensure-app-role.sql', 'utf8')
    const source = readFileSync(scriptPath, 'utf8')

    expect(bootstrap).toContain('REVOKE DELETE, TRUNCATE ON TABLE model_cost_budget_reservations FROM merchant_app')
    expect(source).toContain("has_table_privilege(current_user, 'public.model_cost_budget_reservations', 'DELETE,TRUNCATE')")
    expect(source).toContain('tenant runtime role must not delete or truncate model cost budget reservations')
  })

  it('fails closed when the runtime role can delete confirmation tickets', () => {
    const source = readFileSync(scriptPath, 'utf8')
    expect(source).toContain("has_table_privilege(current_user, 'public.interactive_confirmation_tickets', 'DELETE,TRUNCATE')")
    expect(source).toContain('tenant runtime role must not delete or truncate interactive confirmation tickets')
  })

  it('bounds authorization execution reservation privileges for both database roles', () => {
    const source = readFileSync(scriptPath, 'utf8')
    expect(source).toContain("FROM unnest(ARRAY['platform_feature_flags','platform_feature_flag_targets','platform_feature_flag_events','authorization_revisions','authorization_execution_reservations'")
    expect(source).toContain("'public.authorization_execution_reservations', 'SELECT,INSERT'")
    expect(source).toContain('Ops database role has destructive authorization reservation access')
    expect(source).toContain('authorization_execution_reservations')
  })

  it('re-applies the interactive confirmation ticket ACL guard after local compatibility grants', () => {
    const bootstrap = readFileSync('infra/local/ensure-app-role.sql', 'utf8')
    expect(bootstrap).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON TABLE interactive_confirmation_tickets FROM merchant_app')
    expect(bootstrap).toContain('GRANT UPDATE (consumed_at,consumed_operation_id,reservation_id,reservation_token,reserved_at,reservation_expires_at,reservation_revision) ON TABLE interactive_confirmation_tickets TO merchant_app')
  })

  it('remains valid POSIX shell', () => {
    expect(execFileSync('sh', ['-n', scriptPath], { encoding: 'utf8' })).toBe('')
  })
})
