-- 226_evidence_and_snapshot_truncate_guards: close the owner-level TRUNCATE
-- path on the last six tables that carry irreplaceable rows but never got a
-- statement-level guard.
--
-- 224 and 225 closed this hole for the ledgers that already had a row-level
-- append-only trigger. These six were worse off: they had *no* trigger at all,
-- so UPDATE, DELETE and TRUNCATE were all open. A row-level trigger is never
-- fired by TRUNCATE anyway, and TRUNCATE is gated by the TRUNCATE privilege
-- rather than DELETE, so a single statement from the table owner emptied the
-- whole table while the append-only contract still looked enforced.
--
-- Why only TRUNCATE here, and not a full row-level append-only lock:
--
--   * `context_snapshots`, `task_snapshots`, `manual_publish_evidence`,
--     `platform_media_spec_audit`, `workspace_growth_events` and
--     `workspace_usage_ledger` hold rows that cannot be recomputed after the
--     fact. A frozen context envelope, a task version history entry, a human
--     publish report, an approval audit row, a funnel event and a quota
--     consumption row are all facts about a moment that has passed; re-deriving
--     them from current state yields different bytes. Losing the whole table to
--     one statement destroys the audit chain for every tenant at once.
--   * TRUNCATE is never a normal runtime operation for any of these tables. The
--     application only ever INSERTs into them (plus the status/refund UPDATEs on
--     manual_publish_evidence and workspace_usage_ledger), so blocking TRUNCATE
--     cannot obstruct any business write. That is why this migration is strictly
--     narrower than the append-only row guards on the 132/134/136/224/225
--     families, which would also freeze the legitimate UPDATE paths.
--
-- Deliberately absent, with the reason recorded so the next sweep does not
-- re-open them by pattern-matching on the table name:
--
--   * `knowledge_hydration_snapshots` is a rebuildable cursor cache: exactly one
--     row per workspace, rewritten on every hydration revision bump, holding a
--     bounded event buffer plus a `knowledge_index_events` cursor. Losing it
--     forces a re-hydration, not an audit loss, and it is the one table here
--     that is a high-churn rewrite target.
--   * `unified_link_audit` is a projection, not evidence. 098's own header calls
--     it a "canonical relationship audit projection"; the writer
--     (`persistCanonicalLinkAudit`) upserts rows derived from a live
--     `canonicalConsistencyApiReport` and its own comment states the repository
--     is "a test/dev projection, not durable evidence". Truncating it costs one
--     re-run of the consistency check; the only non-derived field is
--     `first_seen_at`, which is a diagnostic detail rather than an audit fact.
--
-- The rejecting function is NOT redefined here on purpose. 225 already declares
-- `reject_append_only_ledger_truncate()` once for every statement-level guard in
-- the chain, and 225 is guaranteed to run before 226 because the runner applies
-- versions in ascending order. A second `CREATE OR REPLACE` in this file would
-- be a second source of truth for the 55000 message contract and reintroduce the
-- copy-paste drift that 225 was written to remove. The shared function already
-- interpolates TG_TABLE_SCHEMA/TG_TABLE_NAME, so an operator who gets 55000 is
-- still told exactly which table rejected the truncate.

DO $evidence_and_snapshot_truncate_guards$
DECLARE
  target text;
  targets text[] := ARRAY[
    'context_snapshots',
    'manual_publish_evidence',
    'platform_media_spec_audit',
    'task_snapshots',
    'workspace_growth_events',
    'workspace_usage_ledger'
  ];
BEGIN
  FOREACH target IN ARRAY targets LOOP
    -- Only guard tables that are actually present, so the migration stays
    -- runnable if a deployment predates the table that introduced one of them.
    IF to_regclass(format('public.%I', target)) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', target || '_no_truncate', target);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_ledger_truncate()',
      target || '_no_truncate', target
    );
    -- Belt and braces: no non-owner role holds TRUNCATE on these tables today,
    -- so these REVOKEs are no-ops that only stop a later privilege grant from
    -- reopening the path the trigger above closes.
    EXECUTE format('REVOKE TRUNCATE ON public.%I FROM PUBLIC', target);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
      EXECUTE format('REVOKE TRUNCATE ON public.%I FROM merchant_app', target);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
      EXECUTE format('REVOKE TRUNCATE ON public.%I FROM merchant_ops', target);
    END IF;
  END LOOP;
END;
$evidence_and_snapshot_truncate_guards$;
