import type { SqlPool } from './repository.js'

export interface OpsWorkspaceSummary {
  workspaceId: string
  status: 'active' | 'disabled'
  planName: string
  monthlyPriceCny: number
  usedTasks: number
  includedTasks: number
  subscriptionStatus: string
  memberCount: number
}

export interface OpsWorkspaceDirectoryQuery {
  query?: string
  status?: 'active' | 'disabled'
  subscriptionStatus?: string
  offset: number
  limit: number
}

export interface OpsWorkspaceDirectoryPage {
  items: OpsWorkspaceSummary[]
  total: number
  offset: number
  limit: number
  hasMore: boolean
}

export interface OpsDataRepository {
  listWorkspaceSummaries(): Promise<OpsWorkspaceSummary[]>
  listWorkspaceDirectory?(query: OpsWorkspaceDirectoryQuery): Promise<OpsWorkspaceDirectoryPage>
}

/**
 * Read-only persistence contract for the Ops workspace directory.
 * An empty database returns an empty list; missing per-workspace commercial
 * rows are represented by the safe defaults owned by migration 073's view.
 */
export class PostgresOpsDataRepository implements OpsDataRepository {
  constructor(private readonly pool: SqlPool) {}

  async listWorkspaceSummaries(): Promise<OpsWorkspaceSummary[]> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN READ ONLY')
      await client.query(`SELECT set_config('app.platform_scope', 'platform_ops', true)`)
      const result = await client.query<OpsWorkspaceSummary>(
        `SELECT workspace_id AS "workspaceId", status, plan_name AS "planName",
                monthly_price_cny AS "monthlyPriceCny", used_tasks AS "usedTasks",
                included_tasks AS "includedTasks", subscription_status AS "subscriptionStatus",
                member_count AS "memberCount"
           FROM ops_workspace_summaries
          ORDER BY created_at DESC, workspace_id ASC`,
      )
      await client.query('COMMIT')
      return result.rows
    } catch (error) {
      try { await client.query('ROLLBACK') } catch { /* preserve the original error */ }
      throw error
    } finally {
      client.release?.()
    }
  }

  async listWorkspaceDirectory(query: OpsWorkspaceDirectoryQuery): Promise<OpsWorkspaceDirectoryPage> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN READ ONLY')
      await client.query(`SELECT set_config('app.platform_scope', 'platform_ops', true)`)
      const values: unknown[] = []
      const where: string[] = []
      if (query.query) { values.push(`%${query.query}%`); where.push(`(workspace_id ILIKE $${values.length} OR plan_name ILIKE $${values.length})`) }
      if (query.status) { values.push(query.status); where.push(`status = $${values.length}`) }
      if (query.subscriptionStatus) { values.push(query.subscriptionStatus); where.push(`subscription_status = $${values.length}`) }
      const filterValues = [...values]
      const offsetIndex = values.push(query.offset)
      const limitIndex = values.push(query.limit)
      const countResult = await client.query<{ totalCount: number }>(
        `SELECT count(*)::integer AS "totalCount"
           FROM ops_workspace_summaries
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
        filterValues,
      )
      const result = await client.query<OpsWorkspaceSummary>(
        `SELECT workspace_id AS "workspaceId", status, plan_name AS "planName",
                monthly_price_cny AS "monthlyPriceCny", used_tasks AS "usedTasks",
                included_tasks AS "includedTasks", subscription_status AS "subscriptionStatus",
                member_count AS "memberCount"
           FROM ops_workspace_summaries
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY created_at DESC, workspace_id ASC
          OFFSET $${offsetIndex} LIMIT $${limitIndex}`,
        values,
      )
      const total = Number(countResult.rows[0]?.totalCount ?? 0)
      await client.query('COMMIT')
      return { items: result.rows, total, offset: query.offset, limit: query.limit, hasMore: query.offset + result.rows.length < total }
    } catch (error) {
      try { await client.query('ROLLBACK') } catch { /* preserve original */ }
      throw error
    } finally { client.release?.() }
  }
}
