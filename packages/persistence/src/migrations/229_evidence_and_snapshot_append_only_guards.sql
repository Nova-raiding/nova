-- 229_evidence_and_snapshot_append_only_guards: close the row-level mutation
-- path on the three remaining tables of the 226 evidence family whose writers
-- are pure INSERT.
--
-- 226 installed a statement-level `BEFORE TRUNCATE` guard on six tables that
-- held irreplaceable rows but had no trigger at all. It deliberately stopped
-- there because the family was not uniform: some of the six had a legitimate
-- row-rewrite flow that a row-level append-only trigger would have frozen.
-- 227 then closed the row path for `platform_media_spec_audit`, and this
-- migration closes it for the three of the five that survived that check.
--
-- This migration is NOT a "make the batch uniform" sweep. Each table below was
-- judged on its own writers, its own foreign keys and its own cleanup paths,
-- and two tables from the same five are deliberately left mutable. The
-- per-table evidence is recorded here so the next sweep does not re-open them
-- by pattern-matching on the table name.
--
-- GUARDED — no UPDATE, DELETE, UPSERT or MERGE against them exists anywhere in
-- `packages/`, `apps/`, `scripts/`, `tests/`, `infra/` or the migration chain;
-- no table references them with `ON DELETE CASCADE`; and no retention, cleanup
-- or data-lifecycle path targets them. Each has exactly one writer, and it is
-- an unconditional INSERT:
--
--   * `context_snapshots` (039) — frozen generation context. No writer at all
--     today: the live path is `PostgresContextSnapshotRepository.save`, which
--     writes `context_blobs` + `context_snapshot_links` (both created by 043),
--     and `apps/api/src/server.ts` wires its `contextSnapshotSink` to exactly
--     that repository. 039's table is therefore the legacy half of a split that
--     043 completed, and the rows it already holds are the only surviving copy
--     of those envelopes. Its five foreign keys are all default `NO ACTION`.
--   * `task_snapshots` (004) — the frozen per-version task history. Also has no
--     writer: task state is persisted as `business_entity_snapshots` rows
--     (`entity_type = 'task'`) by `PostgresBusinessRepository`, and 175's
--     `repair_legacy_task_snapshot_scope` rewrites *that* payload column, never
--     this table. `workspace_id` and the composite `(workspace_id, task_id)`
--     keys are both default `NO ACTION`.
--   * `workspace_growth_events` (025) — funnel events. One writer:
--     `PostgresGrowthRepository.append`, an unconditional `INSERT ... RETURNING`;
--     `funnel` is a `SELECT`, and the memory mirror (`MemoryGrowthRepository`)
--     only pushes onto an array, so the two implementations agree that the
--     event log is append-only. Its `workspace_id` reference is
--     `ON DELETE CASCADE`, which is the one thing that gave this table pause —
--     see the cascade note below.
--
-- DELIBERATELY LEFT MUTABLE — the two tables in the same family that have a
-- real in-place rewrite contract. Freezing either would break working code:
--
--   * `manual_publish_evidence` (218) is a revisioned record, not a log. It
--     carries `revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0)`,
--     `updated_at` and `updated_by_actor_id`; 218's ACL grants `UPDATE` to
--     `merchant_app` and `merchant_ops` while revoking `DELETE`, and its work
--     queue index is `(workspace_id, status, updated_at DESC, id DESC)` — an
--     index ordered by a column that only an UPDATE can move. The API surface
--     matches: `ops.marketing.publish.manual-evidence.record` takes
--     `expected_revision`, rejects anything but 1 with
--     `MANUAL_PUBLISH_REVISION_CONFLICT`, and the authz policy in
--     `packages/contracts/src/authz.ts` declares a `revision` obligation. The
--     manual publish state machine (`export_ready` ->
--     `manual_publish_in_progress` -> `manual_publish_reported` ->
--     `manual_review_required`) is a status transition *on one row*. A row
--     guard here would reject every one of those transitions.
--   * `workspace_usage_ledger` (019) is the quota consumption ledger and 226's
--     own header named its refund UPDATE. `PostgresUsageRepository.refund`
--     issues `UPDATE workspace_usage_ledger SET refunded=true,
--     refund_reason=$4, refunded_by=$5, refunded_at=now() WHERE ... AND
--     refunded=false RETURNING id`, reached from the `billing.usage.refund`
--     surface. That UPDATE is the whole point of the `refunded`,
--     `refund_reason`, `refunded_by` and `refunded_at` columns. A row guard
--     here would make the ledger permanently un-refundable.
--
-- Cascade note (why `workspace_growth_events` is still guarded). Its
-- `workspace_id` reference is `ON DELETE CASCADE`, so a cascading delete does
-- reach it, and a `BEFORE DELETE ... FOR EACH ROW` trigger does fire for
-- cascaded rows — verified against a live database, not assumed. What that
-- costs was measured rather than guessed: no code anywhere deletes a
-- workspace. `workspace.deactivate` is a soft state change,
-- `workspace.data.delete.request` / `ops.data.delete.approve` only write
-- `workspace_data_deletion_requests`, and `DataLifecycleRepository.complete`
-- records an out-of-band `execution_proof_ref` instead of issuing deletes; a
-- repository-wide search finds no `DELETE FROM workspaces`. A workspace delete
-- already fails today (`23503`) on the first `NO ACTION` child anyway, and the
-- repository has already accepted this exact combination deliberately:
-- `workspace_operation_audit` (020 `ON DELETE CASCADE` + 059 row guard) and
-- `commercial_order_snapshots` (123) both ship it. Guarding this table adds no
-- new class of behaviour; it extends a trade-off the family already made. If a
-- hard-erasure runbook is ever written, it has to sequence around these guards
-- regardless of this migration.
--
-- The rejecting function is shared by the three tables rather than declared
-- once per table. 225 established that split for the statement-level guards in
-- this family — one definition of the 55000 contract, no copy-paste drift —
-- and the same argument holds here: the function interpolates
-- `TG_TABLE_SCHEMA`/`TG_TABLE_NAME`, so an operator who gets 55000 is still
-- told exactly which table refused the write. 227's per-table function was
-- justified by a per-table message naming one audit chain; three tables with
-- one shared contract are the 225 shape. `reject_append_only_ledger_truncate`
-- from 225 is not reused because its message says "rejects TRUNCATE" and would
-- misreport a row mutation.
--
-- Scope note: this migration adds ONLY the row-level trigger and the matching
-- REVOKE. The statement-level `BEFORE TRUNCATE` guard that normally accompanies
-- it in this family already exists on all three tables — 226 created
-- `context_snapshots_no_truncate`, `task_snapshots_no_truncate` and
-- `workspace_growth_events_no_truncate` — so re-declaring it here would be a
-- second source of truth for a contract that is already enforced. 226 is
-- guaranteed to run first because the runner applies versions in ascending
-- order. The `REVOKE UPDATE, DELETE, TRUNCATE` below is the belt-and-braces
-- half of the 132 pattern: no non-owner role holds UPDATE or DELETE on these
-- three tables in a way any code uses, so it only stops a later grant from
-- reopening the path this trigger closes. It never grants anything back, and
-- it deliberately does not touch the four tables it leaves mutable.

CREATE OR REPLACE FUNCTION reject_evidence_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'evidence table %.% is append-only', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = '55000',
          HINT = 'Recorded evidence and frozen snapshots are facts about a past moment; corrections are new rows, never rewrites or deletes.';
END;
$$;

DO $evidence_and_snapshot_append_only_guards$
DECLARE
  target text;
  targets text[] := ARRAY[
    'context_snapshots',
    'task_snapshots',
    'workspace_growth_events'
  ];
BEGIN
  FOREACH target IN ARRAY targets LOOP
    -- Only guard tables that are actually present, so the migration stays
    -- runnable if a deployment predates the table that introduced one of them.
    IF to_regclass(format('public.%I', target)) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', target || '_append_only', target);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION reject_evidence_snapshot_mutation()',
      target || '_append_only', target
    );
    -- Belt and braces: the trigger above is the guard, these REVOKEs only stop
    -- a later privilege grant from reopening the path it closes.
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON public.%I FROM PUBLIC', target);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON public.%I FROM merchant_app', target);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON public.%I FROM merchant_ops', target);
    END IF;
  END LOOP;
END;
$evidence_and_snapshot_append_only_guards$;
