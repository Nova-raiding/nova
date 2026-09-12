import type { SqlPool } from './repository.js'

export interface OpsWorkspaceSummary {
  workspaceId: string
  enterpriseName: string
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
  merchantWorkspaceCount: number
  activeMemberWorkspaceCount: number
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
        `SELECT s.workspace_id AS "workspaceId",
                COALESCE(NULLIF(btrim(e.name), ''), '未命名企业主体') AS "enterpriseName",
                s.status, s.plan_name AS "planName",
                s.monthly_price_cny AS "monthlyPriceCny", s.used_tasks AS "usedTasks",
                s.included_tasks AS "includedTasks", s.subscription_status AS "subscriptionStatus",
                s.member_count AS "memberCount"
           FROM ops_workspace_summaries s
           JOIN workspaces w ON w.id = s.workspace_id
           JOIN enterprises e ON e.id = w.enterprise_id
          ORDER BY s.created_at DESC, s.workspace_id ASC`,
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
      if (query.query) { values.push(`%${query.query}%`); where.push(`(s.workspace_id ILIKE $${values.length} OR e.name ILIKE $${values.length} OR s.plan_name ILIKE $${values.length})`) }
      if (query.status) { values.push(query.status); where.push(`status = $${values.length}`) }
      if (query.subscriptionStatus) { values.push(query.subscriptionStatus); where.push(`subscription_status = $${values.length}`) }
      const filterValues = [...values]
      const offsetIndex = values.push(query.offset)
      const limitIndex = values.push(query.limit)
      const countResult = await client.query<{ totalCount: number; merchantWorkspaceCount: number; activeMemberWorkspaceCount: number }>(
        `SELECT count(*)::integer AS "totalCount",
                count(*) FILTER (WHERE EXISTS (
                  SELECT 1 FROM platform_password_accounts a
                   WHERE a.account_type = 'merchant'
                     AND a.status = 'active'
                     AND s.workspace_id = ANY(a.workspace_ids)
                ))::integer AS "merchantWorkspaceCount",
                count(*) FILTER (WHERE EXISTS (
                  SELECT 1 FROM workspace_members m
                   WHERE m.workspace_id = s.workspace_id AND m.status = 'active'
                ))::integer AS "activeMemberWorkspaceCount"
           FROM ops_workspace_summaries s
           JOIN workspaces w ON w.id = s.workspace_id
           JOIN enterprises e ON e.id = w.enterprise_id
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
        filterValues,
      )
      const result = await client.query<OpsWorkspaceSummary>(
        `SELECT s.workspace_id AS "workspaceId",
                COALESCE(NULLIF(btrim(e.name), ''), '未命名企业主体') AS "enterpriseName",
                s.status, s.plan_name AS "planName",
                s.monthly_price_cny AS "monthlyPriceCny", s.used_tasks AS "usedTasks",
                s.included_tasks AS "includedTasks", s.subscription_status AS "subscriptionStatus",
                s.member_count AS "memberCount"
           FROM ops_workspace_summaries s
           JOIN workspaces w ON w.id = s.workspace_id
           JOIN enterprises e ON e.id = w.enterprise_id
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY s.created_at DESC, s.workspace_id ASC
          OFFSET $${offsetIndex} LIMIT $${limitIndex}`,
        values,
      )
      const total = Number(countResult.rows[0]?.totalCount ?? 0)
      const merchantWorkspaceCount = Number(countResult.rows[0]?.merchantWorkspaceCount ?? 0)
      const activeMemberWorkspaceCount = Number(countResult.rows[0]?.activeMemberWorkspaceCount ?? 0)
      await client.query('COMMIT')
      return { items: result.rows, total, merchantWorkspaceCount, activeMemberWorkspaceCount, offset: query.offset, limit: query.limit, hasMore: query.offset + result.rows.length < total }
    } catch (error) {
      try { await client.query('ROLLBACK') } catch { /* preserve original */ }
      throw error
    } finally { client.release?.() }
  }
}
