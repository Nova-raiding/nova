-- 183_knowledge_persistence: durable, tenant-scoped knowledge documents,
-- chunks, embedding metadata and auditable index lifecycle.

CREATE TABLE IF NOT EXISTS knowledge_assets (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('product_facts', 'material', 'selling_points', 'brand', 'customer', 'rule')),
  name text NOT NULL,
  content jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_asset_id text,
  product_id text,
  sku_id text,
  source_version integer NOT NULL DEFAULT 1 CHECK (source_version > 0),
  approval_status text NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  rights_status text NOT NULL DEFAULT 'unknown' CHECK (rights_status IN ('unknown', 'cleared', 'restricted')),
  index_state text NOT NULL DEFAULT 'queued' CHECK (index_state IN ('queued', 'indexing', 'ready', 'stale', 'failed', 'deleted')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  knowledge_asset_id text,
  source_asset_id text,
  source_version integer NOT NULL DEFAULT 1 CHECK (source_version > 0),
  brand_id text,
  product_id text,
  sku_id text,
  knowledge_type text NOT NULL CHECK (knowledge_type IN ('product_facts', 'material', 'selling_points', 'brand', 'customer', 'rule')),
  title text NOT NULL DEFAULT '',
  content_type text NOT NULL DEFAULT 'text/plain',
  content_hash text NOT NULL,
  extracted_text text NOT NULL DEFAULT '',
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(source_metadata) = 'object'),
  approval_status text NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  rights_status text NOT NULL DEFAULT 'unknown' CHECK (rights_status IN ('unknown', 'cleared', 'restricted')),
  rule_snapshot_version text,
  embedding_model text,
  embedding_version text,
  index_state text NOT NULL DEFAULT 'queued' CHECK (index_state IN ('queued', 'indexing', 'ready', 'stale', 'failed', 'deleted')),
  index_error text,
  expires_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  CONSTRAINT knowledge_documents_asset_workspace_fk FOREIGN KEY (workspace_id, knowledge_asset_id)
    REFERENCES knowledge_assets (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  content text NOT NULL,
  content_hash text NOT NULL,
  token_count integer CHECK (token_count IS NULL OR token_count >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, document_id, ordinal),
  CONSTRAINT knowledge_chunks_document_workspace_fk FOREIGN KEY (workspace_id, document_id)
    REFERENCES knowledge_documents (workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS knowledge_embeddings (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id text NOT NULL,
  chunk_id text NOT NULL,
  embedding jsonb NOT NULL CHECK (jsonb_typeof(embedding) = 'array'),
  embedding_model text NOT NULL,
  embedding_version text NOT NULL,
  vector_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(vector_metadata) = 'object'),
  index_state text NOT NULL DEFAULT 'queued' CHECK (index_state IN ('queued', 'indexing', 'ready', 'stale', 'failed', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, chunk_id, embedding_model, embedding_version),
  CONSTRAINT knowledge_embeddings_chunk_workspace_fk FOREIGN KEY (workspace_id, chunk_id)
    REFERENCES knowledge_chunks (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT knowledge_embeddings_document_workspace_fk FOREIGN KEY (workspace_id, document_id)
    REFERENCES knowledge_documents (workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS knowledge_asset_bindings (
  binding_id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  knowledge_asset_id text NOT NULL,
  source_asset_id text,
  product_id text,
  sku_id text,
  source_version integer NOT NULL DEFAULT 1 CHECK (source_version > 0),
  binding_type text NOT NULL DEFAULT 'spreadsheet_facts' CHECK (binding_type IN ('spreadsheet_facts', 'source_asset', 'manual')),
  approval_status text NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, binding_id),
  CONSTRAINT knowledge_asset_bindings_asset_workspace_fk FOREIGN KEY (workspace_id, knowledge_asset_id)
    REFERENCES knowledge_assets (workspace_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS knowledge_asset_bindings_identity_idx
  ON knowledge_asset_bindings (workspace_id, knowledge_asset_id,
    COALESCE(source_asset_id, ''), COALESCE(product_id, ''), COALESCE(sku_id, ''));

CREATE TABLE IF NOT EXISTS knowledge_index_events (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('queued', 'indexing', 'ready', 'stale', 'failed', 'deleted', 'rebuild')),
  previous_state text,
  next_state text NOT NULL CHECK (next_state IN ('queued', 'indexing', 'ready', 'stale', 'failed', 'deleted')),
  reason text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT knowledge_index_events_document_workspace_fk FOREIGN KEY (workspace_id, document_id)
    REFERENCES knowledge_documents (workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS knowledge_deletion_proofs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id text NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  chunks_deleted integer NOT NULL DEFAULT 0 CHECK (chunks_deleted >= 0),
  embeddings_deleted integer NOT NULL DEFAULT 0 CHECK (embeddings_deleted >= 0),
  deletion_digest text NOT NULL,
  UNIQUE (workspace_id, id),
  CONSTRAINT knowledge_deletion_proofs_document_workspace_fk FOREIGN KEY (workspace_id, document_id)
    REFERENCES knowledge_documents (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS knowledge_documents_scope_idx
  ON knowledge_documents (workspace_id, index_state, product_id, sku_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS knowledge_documents_hash_idx
  ON knowledge_documents (workspace_id, content_hash);
CREATE INDEX IF NOT EXISTS knowledge_chunks_document_idx
  ON knowledge_chunks (workspace_id, document_id, ordinal);
CREATE INDEX IF NOT EXISTS knowledge_embeddings_lookup_idx
  ON knowledge_embeddings (workspace_id, document_id, index_state, embedding_model, embedding_version);
CREATE INDEX IF NOT EXISTS knowledge_asset_bindings_product_idx
  ON knowledge_asset_bindings (workspace_id, product_id, sku_id, approval_status);
CREATE INDEX IF NOT EXISTS knowledge_index_events_document_idx
  ON knowledge_index_events (workspace_id, document_id, created_at DESC);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'knowledge_assets', 'knowledge_documents', 'knowledge_chunks',
    'knowledge_embeddings', 'knowledge_asset_bindings',
    'knowledge_index_events', 'knowledge_deletion_proofs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', table_name || '_workspace_isolation', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (workspace_id = current_setting(''app.workspace_id'', true)) WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))',
      table_name || '_workspace_isolation', table_name
    );
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    REVOKE ALL ON TABLE knowledge_assets, knowledge_documents, knowledge_chunks,
      knowledge_embeddings, knowledge_asset_bindings, knowledge_index_events,
      knowledge_deletion_proofs FROM merchant_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE knowledge_assets, knowledge_documents,
      knowledge_chunks, knowledge_embeddings, knowledge_asset_bindings,
      knowledge_index_events, knowledge_deletion_proofs TO merchant_app;
  END IF;
END
$$;
