-- 188_enterprise_workspace_bootstrap: preserve the existing workspace
-- bootstrap contract while requiring every workspace to have an enterprise.

CREATE OR REPLACE FUNCTION assign_workspace_enterprise_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.enterprise_id IS NULL OR btrim(NEW.enterprise_id) = '' THEN
    NEW.enterprise_id := NEW.id;
  END IF;
  INSERT INTO enterprises (id, name, status)
  VALUES (NEW.enterprise_id, 'Enterprise ' || NEW.enterprise_id, NEW.status)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workspaces_assign_enterprise_id ON workspaces;
CREATE TRIGGER workspaces_assign_enterprise_id
  BEFORE INSERT ON workspaces
  FOR EACH ROW
  EXECUTE FUNCTION assign_workspace_enterprise_id();

DO $$
BEGIN
  IF to_regclass('public.enterprises') IS NOT NULL THEN
    REVOKE ALL ON enterprises FROM merchant_app;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
      GRANT SELECT ON enterprises TO merchant_ops;
    END IF;
  END IF;
END
$$;
