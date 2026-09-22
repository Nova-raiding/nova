-- Some installations create the isolated runtime roles after the migrations
-- that introduced these read models. Re-assert only the SELECT privileges the
-- platform operations repositories consume, while explicitly preserving the
-- no-write boundary.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    GRANT SELECT ON TABLE
      ops_workspace_summaries,
      commercial_orders_v2,
      commercial_payment_events_v2
      TO merchant_ops;

    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE
      ops_workspace_summaries,
      commercial_orders_v2,
      commercial_payment_events_v2
      FROM merchant_ops;
  END IF;
END
$$;
