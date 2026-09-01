-- Immutable merge barrier for migrations allocated concurrently after 132.
-- This migration intentionally changes no schema or business data; keeping
-- the version occupied preserves the append-only, contiguous artifact chain.
DO $$
BEGIN
  PERFORM 1;
END
$$;
