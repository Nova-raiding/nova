-- 230_revoke_tenant_dml_on_shared_platform_rules: make migration 219's ACL the
-- one that actually holds at runtime on every deployment path.
--
-- The hole this closes: 219 grants `merchant_app` SELECT and reserves
-- INSERT/UPDATE for `merchant_ops` on the two shared platform rule tables. Two
-- things then silently widen that back:
--
--   * `infra/local/ensure-app-role.sql` runs `GRANT SELECT, INSERT, UPDATE,
--     DELETE ON ALL TABLES IN SCHEMA public TO merchant_app` and re-runs after
--     the migration chain on the ECS Compose path, so the ACL 219 just set is
--     revoked by a later statement in the same deployment.
--   * Nothing on the Kubernetes path re-narrows it either; that path never runs
--     the bootstrap at all, so its final ACL is whatever the migrations left.
--
-- Neither table carries a `workspace_id`, so there is no tenant boundary behind
-- the ACL: a session running as the tenant runtime role could deactivate or
-- rewrite the platform rules every merchant is governed by, and could INSERT
-- forged rows into the operations audit ledger. The ledger's append-only
-- trigger (`reject_public_platform_rule_audit_mutation`) rejects UPDATE and
-- DELETE but is never fired for INSERT, so a forged row is accepted and the
-- audit chain reads as genuine.
--
-- Read access is deliberately kept. `merchant_app` SELECT is what 219 intends
-- and what `PostgresRuleRepository.listPublic` relies on: every merchant reads
-- platform policy through its own tenant connection. Only DML is withdrawn, and
-- the application's write path now uses the operations pool
-- (`PostgresRuleRepository` takes a second pool for the two public writes), so
-- this withdraws nothing the runtime needs.
--
-- Why a new migration rather than an edit to 219: the runner validates the
-- checksum of every applied file, so editing 219 fails every database that has
-- already run it. The ECS bootstrap fix lives in `ensure-app-role.sql`; this
-- file is what makes the same guarantee hold on the path that never runs it.

DO $revoke_tenant_dml_on_shared_platform_rules$
DECLARE
  target text;
  targets text[] := ARRAY[
    'public_platform_rule_versions',
    'public_platform_rule_audits'
  ];
BEGIN
  -- Only narrow what is actually present and actually granted, so the migration
  -- stays runnable against a deployment that predates 219 and against the
  -- fixture databases that never create the runtime roles.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    RETURN;
  END IF;

  FOREACH target IN ARRAY targets LOOP
    IF to_regclass(target) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE %s FROM merchant_app',
      target);
    -- Re-assert the read grant rather than assume it: the blanket bootstrap
    -- grant is not the only thing that can have replaced 219's ACL, and a
    -- missing SELECT here surfaces as every platform reporting
    -- `not_configured`, which reads as a sync problem rather than a grant one.
    EXECUTE format('GRANT SELECT ON TABLE %s TO merchant_app', target);
  END LOOP;
END
$revoke_tenant_dml_on_shared_platform_rules$;
