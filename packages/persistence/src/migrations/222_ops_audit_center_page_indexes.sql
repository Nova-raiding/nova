-- migrate:no-transaction
-- 222_ops_audit_center_page_indexes: tenant-leading page indexes for the three
-- UNION ALL branches of the ops_audit_center view that had no index over the
-- access path the audit center actually reads.
--
-- Audit-center paging reads
--   SELECT ... FROM ops_audit_center
--    WHERE workspace_id = $1 [AND ...filters]
--    ORDER BY occurred_at DESC, source DESC, id DESC
--    LIMIT $n
-- and the view is a UNION ALL over four immutable fact tables, so the planner
-- evaluates every branch with a Merge Append. `source` is a literal per branch,
-- so each branch only has to return its own rows ordered by
-- (occurred_at DESC, id DESC) for one workspace.
--
-- workspace_operation_audit already had (workspace_id, created_at DESC, id DESC)
-- from 059. The other three did not, and their only workspace-scoped indexes
-- lead with a different key (rule_pack_id, rule_version_id, incident_id,
-- ticket_id, sequence), so each branch fell back to Seq Scan + Sort of the
-- tenant's entire history. Because this is a Merge Append, the first page paid
-- the full cost of all four branches and every later page repeated it.
--
-- Column order follows the access path: the equality column (workspace_id)
-- first, then the ORDER BY columns in the same direction as the view's
-- ORDER BY (DESC, DESC). No INCLUDE columns: the projection is wide and every
-- branch still has to visit the heap for its own row, so a covering index would
-- only add write amplification to append-only audit tables.
--
-- CONCURRENTLY keeps the build from taking an exclusive lock on tables that are
-- written on every rule change, incident update and support event, which is why
-- this migration is registered with `transactional: false` and carries the
-- `-- migrate:no-transaction` marker. If a build fails or is cancelled it
-- leaves an INVALID index behind, and a retry's `IF NOT EXISTS` matches on the
-- name alone and silently skips it; see the runner's post-build assertion for
-- the fail-closed guard.
CREATE INDEX CONCURRENTLY IF NOT EXISTS rule_audit_events_workspace_occurred_id_idx
  ON rule_audit_events (workspace_id, occurred_at DESC, id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS ops_incident_timeline_workspace_created_id_idx
  ON ops_incident_timeline (workspace_id, created_at DESC, id DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS workspace_support_ticket_events_workspace_created_id_idx
  ON workspace_support_ticket_events (workspace_id, created_at DESC, id DESC);
