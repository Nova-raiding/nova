-- Bind delivery readiness to one explicitly selected merchant login identity.
-- Existing rows stay unbound. No account, membership, payment or business status
-- is activated or rewritten by this migration.
ALTER TABLE workspace_customer_deliveries
  ADD COLUMN target_account_id UUID,
  ADD COLUMN target_identity_id UUID,
  ADD CONSTRAINT customer_deliveries_account_pair_check
    CHECK ((target_account_id IS NULL) = (target_identity_id IS NULL)),
  ADD CONSTRAINT customer_deliveries_account_identity_fk
    FOREIGN KEY (target_account_id, target_identity_id)
    REFERENCES platform_password_accounts(id, identity_id) ON DELETE RESTRICT,
  ADD CONSTRAINT customer_deliveries_workspace_identity_fk
    FOREIGN KEY (workspace_id, target_identity_id)
    REFERENCES workspace_members(workspace_id, identity_id) ON DELETE RESTRICT,
  ADD CONSTRAINT customer_deliveries_workspace_identity_unique
    UNIQUE (workspace_id, target_identity_id);

-- merchant_ops can read workspaces but intentionally cannot UPDATE that table.
-- The narrow helper owns only exact-target row locks; do not grant broad UPDATE
-- merely to acquire FOR SHARE. It returns no password hashes, sessions or tokens.
CREATE FUNCTION public.lock_customer_delivery_account_target(p_workspace_id TEXT, p_account_id UUID)
RETURNS TABLE (account_id UUID, identity_id UUID, login TEXT)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $delivery_account_target$
BEGIN
  IF current_setting('app.platform_scope', true) IS DISTINCT FROM 'platform_ops'
    OR current_setting('app.workspace_id', true) IS DISTINCT FROM p_workspace_id
    OR p_workspace_id IS NULL OR length(btrim(p_workspace_id))=0 THEN
    RAISE EXCEPTION 'customer delivery account scope is invalid' USING ERRCODE='42501';
  END IF;
  RETURN QUERY
    SELECT a.id, a.identity_id, a.login_identifier
    FROM public.platform_password_accounts a
    JOIN public.platform_identities i ON i.id=a.identity_id
    JOIN public.workspace_members m ON m.identity_id=a.identity_id AND m.workspace_id=p_workspace_id
    JOIN public.workspaces w ON w.id=m.workspace_id
    WHERE a.id=p_account_id AND a.account_type='merchant' AND a.status='active'
      AND p_workspace_id=ANY(a.workspace_ids)
      AND i.access_status='active' AND i.risk_decision='allow'
      AND m.status='active' AND w.status='active'
    FOR SHARE OF a,i,m,w;
END
$delivery_account_target$;

REVOKE ALL ON FUNCTION public.lock_customer_delivery_account_target(TEXT,UUID) FROM PUBLIC, merchant_app;
GRANT EXECUTE ON FUNCTION public.lock_customer_delivery_account_target(TEXT,UUID) TO merchant_ops;

CREATE FUNCTION public.guard_customer_delivery_account_binding()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $delivery_account_binding$
DECLARE target_identity UUID;
BEGIN
  IF TG_OP='UPDATE' AND OLD.target_account_id IS NOT NULL
    AND (NEW.target_account_id IS DISTINCT FROM OLD.target_account_id
      OR NEW.target_identity_id IS DISTINCT FROM OLD.target_identity_id
      OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id) THEN
    RAISE EXCEPTION 'customer delivery account binding is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.target_account_id IS NULL AND NEW.target_identity_id IS NULL THEN RETURN NEW; END IF;
  -- Rewriting unrelated delivery fields never reactivates or rejects a suspended
  -- customer. Validate eligibility only at the first binding transition.
  IF TG_OP='UPDATE' AND OLD.target_account_id IS NOT NULL THEN RETURN NEW; END IF;
  SELECT identity_id INTO target_identity
    FROM public.lock_customer_delivery_account_target(NEW.workspace_id, NEW.target_account_id);
  IF target_identity IS NULL OR target_identity IS DISTINCT FROM NEW.target_identity_id THEN
    RAISE EXCEPTION 'customer delivery account is not bindable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$delivery_account_binding$;

REVOKE ALL ON FUNCTION public.guard_customer_delivery_account_binding() FROM PUBLIC, merchant_app;
CREATE TRIGGER customer_delivery_account_binding_guard
  BEFORE INSERT OR UPDATE OF target_account_id,target_identity_id,workspace_id
  ON workspace_customer_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.guard_customer_delivery_account_binding();

-- Keep the existing control-plane ACL and forced workspace RLS intact.
REVOKE ALL ON workspace_customer_deliveries FROM PUBLIC, merchant_app;
REVOKE DELETE,TRUNCATE,REFERENCES,TRIGGER ON workspace_customer_deliveries FROM merchant_ops;
