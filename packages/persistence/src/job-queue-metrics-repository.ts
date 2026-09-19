import { requireWorkspaceScope, withWorkspaceTransaction, type SqlPool } from './repository.js'

/**
 * One durable job-queue row group: a `(queue, state)` bucket for one workspace.
 *
 * `oldest*At` are the oldest timestamps inside the group, or `null` when the
 * group has no timestamp to report. Which timestamp the queue gauges age from
 * is a per-queue decision made by the caller, so both are returned rather than
 * collapsing them into one "age" here.
 */
export interface MerchantJobQueueGroup {
  /** `sync` jobs live in `business_entity_snapshots` (`entity_type = 'sync_job'`); there is no `sync_jobs` table. */
  queue: 'sync' | 'publish' | 'generation'
  state: string
  count: number
  oldestCreatedAt: string | null
  oldestUpdatedAt: string | null
  /**
   * Oldest `COALESCE(remote_observed_at, updated_at, created_at)` for publish
   * jobs. This is the closest durable proxy for "when the job went unknown":
   * every write that moves a publish job into `unknown` also stamps
   * `remote_observed_at` with that moment (`MerchantService.recordPublishObservation`).
   * It is a proxy, not an audit timestamp — a later poll that observes the same
   * job still unknown overwrites it, so the age is a lower bound. Only publish
   * jobs can be `unknown`, so the column is meaningless for the other queues and
   * is reported as `null` there.
   */
  oldestRemoteObservedAt: string | null
}

export interface MerchantJobQueueMetricsRepository {
  /**
   * Read-only, workspace-scoped aggregation of durable job rows.
   *
   * Scoped per workspace because `publish_jobs`, `generation_jobs` and
   * `business_entity_snapshots` are all `FORCE ROW LEVEL SECURITY` with a
   * `workspace_id = current_setting('app.workspace_id')` policy and no
   * platform-scope policy, so no single query can legally span tenants as the
   * runtime role. Callers iterate the workspace directory instead.
   */
  jobQueueGroups(workspaceId: string): Promise<MerchantJobQueueGroup[]>
}

/**
 * The one statement behind `jobQueueGroups`.
 *
 * Index basis (all three verified with `EXPLAIN` on PostgreSQL against the
 * migrated schema, see the pool test):
 *   - `publish_jobs` — `publish_jobs_workspace_state_idx (workspace_id, state,
 *     updated_at DESC, id)`: `workspace_id = $1` is the leading equality column
 *     and `state` is the next one, so the grouping dimension comes out of the
 *     index; `created_at`/`remote_observed_at` are heap columns fetched per row.
 *   - `generation_jobs` — `generation_jobs_workspace_state_idx (workspace_id,
 *     state, created_at)`: the same shape, and it also carries `created_at`, so
 *     the `min(created_at)` aggregate is answerable from the index.
 *   - `business_entity_snapshots` — `business_entity_snapshots_workspace_type_idx
 *     (workspace_id, entity_type, updated_at DESC, entity_id)`: `workspace_id`
 *     and `entity_type` are both equality predicates and lead the index.
 *
 * `count(*)` is `bigint` and the pg driver hands that back as a string, so the
 * caller normalizes with `Number(...)`.
 */
export const JOB_QUEUE_GROUPS_SQL = `SELECT 'publish' AS queue, state, count(*)::bigint AS job_count,
       min(created_at) AS oldest_created_at, min(updated_at) AS oldest_updated_at,
       min(COALESCE(remote_observed_at, updated_at, created_at)) AS oldest_remote_observed_at
  FROM publish_jobs
 WHERE workspace_id = $1
 GROUP BY state
UNION ALL
SELECT 'generation' AS queue, state, count(*)::bigint AS job_count,
       min(created_at) AS oldest_created_at, min(updated_at) AS oldest_updated_at,
       NULL::timestamptz AS oldest_remote_observed_at
  FROM generation_jobs
 WHERE workspace_id = $1
 GROUP BY state
UNION ALL
SELECT 'sync' AS queue, COALESCE(payload->>'state', 'unknown') AS state, count(*)::bigint AS job_count,
       min(created_at) AS oldest_created_at, min(updated_at) AS oldest_updated_at,
       NULL::timestamptz AS oldest_remote_observed_at
  FROM business_entity_snapshots
 WHERE workspace_id = $1 AND entity_type = 'sync_job'
 GROUP BY 2`

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  const text = String(value)
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? text : null
}

/**
 * PostgreSQL-backed, tenant-scoped job-queue aggregation for `GET /metrics`.
 * Read-only by construction: the statement is a single `SELECT` and never
 * mutates state.
 */
export class PostgresMerchantJobQueueMetricsRepository implements MerchantJobQueueMetricsRepository {
  constructor(private readonly pool: SqlPool) {}

  async jobQueueGroups(workspaceId: string): Promise<MerchantJobQueueGroup[]> {
    const scope = requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<{
        queue: string
        state: string
        job_count: string | number
        oldest_created_at: unknown
        oldest_updated_at: unknown
        oldest_remote_observed_at: unknown
      }>(JOB_QUEUE_GROUPS_SQL, [scope])
      return result.rows
        .filter(row => row.queue === 'sync' || row.queue === 'publish' || row.queue === 'generation')
        .map(row => ({
          queue: row.queue as MerchantJobQueueGroup['queue'],
          state: String(row.state),
          count: Number(row.job_count),
          oldestCreatedAt: isoOrNull(row.oldest_created_at),
          oldestUpdatedAt: isoOrNull(row.oldest_updated_at),
          oldestRemoteObservedAt: isoOrNull(row.oldest_remote_observed_at),
        }))
    })
  }
}
