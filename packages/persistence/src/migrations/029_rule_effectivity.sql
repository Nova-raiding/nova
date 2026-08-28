-- 029_rule_effectivity: persist rule lifecycle fields used by deterministic review.
ALTER TABLE rule_pack_versions
  ADD COLUMN IF NOT EXISTS effective_from timestamptz,
  ADD COLUMN IF NOT EXISTS effective_to timestamptz,
  ADD COLUMN IF NOT EXISTS severity text CHECK (severity IS NULL OR severity IN ('error', 'warning')),
  ADD COLUMN IF NOT EXISTS action text CHECK (action IS NULL OR action IN ('block', 'warn', 'review', 'allow')),
  ADD COLUMN IF NOT EXISTS target_id text,
  ADD COLUMN IF NOT EXISTS scope_value text;

CREATE INDEX IF NOT EXISTS rule_pack_versions_effectivity_idx
  ON rule_pack_versions (workspace_id, effective_from, effective_to, status);
