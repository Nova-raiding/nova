CREATE TABLE IF NOT EXISTS platform_feature_flags (
  id uuid PRIMARY KEY,
  flag_key text NOT NULL CHECK (flag_key ~ '^[a-z][a-z0-9_.-]{1,127}$'),
  environment text NOT NULL CHECK (environment ~ '^[a-z][a-z0-9_-]{1,31}$'),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 500),
  value_type text NOT NULL CHECK (value_type IN ('boolean', 'string', 'number', 'json')),
  value_json jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  emergency_disabled boolean NOT NULL DEFAULT false,
  valid_from timestamptz,
  valid_to timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (flag_key, environment),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to > valid_from),
  CHECK (octet_length(value_json::text) <= 16384),
  CHECK (
    (value_type = 'boolean' AND jsonb_typeof(value_json) = 'boolean') OR
    (value_type = 'string' AND jsonb_typeof(value_json) = 'string') OR
    (value_type = 'number' AND jsonb_typeof(value_json) = 'number') OR
    (value_type = 'json' AND jsonb_typeof(value_json) IN ('object', 'array'))
  )
);

CREATE TABLE IF NOT EXISTS platform_feature_flag_targets (
  id uuid PRIMARY KEY,
  flag_id uuid NOT NULL REFERENCES platform_feature_flags(id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (target_type IN ('identity', 'workspace', 'percentage')),
  target_value text NOT NULL,
  enabled boolean NOT NULL,
  value_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(target_value) BETWEEN 1 AND 255),
  CHECK (octet_length(COALESCE(value_json, 'null'::jsonb)::text) <= 16384),
  CHECK (target_type <> 'percentage' OR (target_value ~ '^[0-9]+$' AND target_value::integer BETWEEN 0 AND 10000)),
  UNIQUE (flag_id, target_type, target_value)
);

CREATE TABLE IF NOT EXISTS platform_feature_flag_events (
  id uuid PRIMARY KEY,
  flag_id uuid NOT NULL REFERENCES platform_feature_flags(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('created', 'updated', 'emergency_disabled', 'emergency_restored')),
  actor_id text NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  before_json jsonb,
  after_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (flag_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS platform_feature_flags_page_idx
  ON platform_feature_flags (updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS platform_feature_flag_events_page_idx
  ON platform_feature_flag_events (flag_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS platform_feature_flag_targets_eval_idx
  ON platform_feature_flag_targets (flag_id, target_type, target_value);

CREATE OR REPLACE FUNCTION validate_feature_flag_target_value()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_type text;
BEGIN
  IF NEW.value_json IS NULL THEN RETURN NEW; END IF;
  SELECT value_type INTO parent_type FROM platform_feature_flags WHERE id = NEW.flag_id;
  IF parent_type IS NULL THEN RAISE EXCEPTION 'feature flag does not exist'; END IF;
  IF NOT (
    (parent_type = 'boolean' AND jsonb_typeof(NEW.value_json) = 'boolean') OR
    (parent_type = 'string' AND jsonb_typeof(NEW.value_json) = 'string') OR
    (parent_type = 'number' AND jsonb_typeof(NEW.value_json) = 'number') OR
    (parent_type = 'json' AND jsonb_typeof(NEW.value_json) IN ('object', 'array'))
  ) THEN RAISE EXCEPTION 'feature flag target value type mismatch'; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS platform_feature_flag_target_value_type ON platform_feature_flag_targets;
CREATE TRIGGER platform_feature_flag_target_value_type
BEFORE INSERT OR UPDATE ON platform_feature_flag_targets
FOR EACH ROW EXECUTE FUNCTION validate_feature_flag_target_value();

-- These tables are platform-control-plane data. They are intentionally not
-- exposed to tenant application roles; the API service enforces Ops RBAC and
-- tenant-scoped evaluation. Production grants must be made only to the Ops role.
REVOKE ALL ON platform_feature_flags, platform_feature_flag_targets, platform_feature_flag_events FROM PUBLIC;

CREATE OR REPLACE FUNCTION reject_feature_flag_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'platform_feature_flag_events is immutable';
END;
$$;

DROP TRIGGER IF EXISTS platform_feature_flag_events_immutable ON platform_feature_flag_events;
CREATE TRIGGER platform_feature_flag_events_immutable
BEFORE UPDATE OR DELETE ON platform_feature_flag_events
FOR EACH ROW EXECUTE FUNCTION reject_feature_flag_event_mutation();
