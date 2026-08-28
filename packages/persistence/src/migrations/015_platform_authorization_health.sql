-- 015_platform_authorization_health: non-secret, last-known OAuth metadata for merchant health views.

ALTER TABLE platform_accounts
  ADD COLUMN IF NOT EXISTS granted_scopes jsonb,
  ADD COLUMN IF NOT EXISTS access_token_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS credential_refreshable boolean,
  ADD COLUMN IF NOT EXISTS last_authorized_at timestamptz,
  ADD COLUMN IF NOT EXISTS credential_metadata_observed_at timestamptz,
  ADD COLUMN IF NOT EXISTS token_state_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

ALTER TABLE platform_accounts
  DROP CONSTRAINT IF EXISTS platform_accounts_granted_scopes_array;

ALTER TABLE platform_accounts
  ADD CONSTRAINT platform_accounts_granted_scopes_array
  CHECK (granted_scopes IS NULL OR jsonb_typeof(granted_scopes) = 'array');
