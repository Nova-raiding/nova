ALTER TABLE platform_password_accounts DROP CONSTRAINT IF EXISTS platform_password_accounts_status_check;
ALTER TABLE platform_password_accounts ADD CONSTRAINT platform_password_accounts_status_check CHECK (status IN ('merchant_pending', 'active', 'suspended', 'revoked', 'rejected'));
