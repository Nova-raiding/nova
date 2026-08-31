CREATE TABLE IF NOT EXISTS payment_callback_nonces (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('alipay', 'wechat')),
  nonce text NOT NULL CHECK (nonce ~ '^[A-Za-z0-9_-]{16,128}$'),
  signed_at timestamptz NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, channel, nonce)
);

CREATE INDEX IF NOT EXISTS payment_callback_nonces_expiry_idx
  ON payment_callback_nonces (received_at);

ALTER TABLE payment_callback_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_callback_nonces FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_callback_nonces_workspace_isolation ON payment_callback_nonces;
CREATE POLICY payment_callback_nonces_workspace_isolation ON payment_callback_nonces
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
