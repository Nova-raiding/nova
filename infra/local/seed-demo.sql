-- Local Compose only: keep the durable demo workspace accessible after the
-- production identity/member boundary is enabled. This seed is idempotent and
-- never ships in the production deployment manifests.
BEGIN;
SELECT set_config('app.workspace_id', 'ws_demo', true);

INSERT INTO workspaces (id, status, capacity_tier)
VALUES ('ws_demo', 'active', 'pilot_50')
ON CONFLICT (id) DO UPDATE SET status = 'active';

INSERT INTO workspace_members (
  id, workspace_id, external_subject, display_name, role, status, invited_by
)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  'ws_demo',
  'actor_demo',
  '本地演示平台运营',
  'platform_ops',
  'active',
  'local_compose_seed'
)
ON CONFLICT (workspace_id, external_subject) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  role = EXCLUDED.role,
  status = EXCLUDED.status,
  updated_at = now(),
  revision = workspace_members.revision + 1;

INSERT INTO workspace_members (
  id, workspace_id, external_subject, display_name, role, status, invited_by
)
VALUES (
  '00000000-0000-4000-8000-000000000002',
  'ws_demo',
  'support_demo',
  '本地演示支持专员',
  'support',
  'active',
  'local_compose_seed'
)
ON CONFLICT (workspace_id, external_subject) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  role = EXCLUDED.role,
  status = EXCLUDED.status,
  updated_at = now(),
  revision = workspace_members.revision + 1;

COMMIT;
