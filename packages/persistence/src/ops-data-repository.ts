import type { SqlClient, SqlPool } from './repository.js'

const DEFAULT_ENTERPRISE_NAME = '未命名企业主体'

type SqlError = { code?: unknown }

/**
 * Historical release acceptance databases intentionally stop at an older
 * migration prefix.  A query that mentions a relation/column introduced by a
 * later migration must be retried against the older projection, but only for
 * PostgreSQL's schema-not-present errors.  Permission and connection errors
 * must continue to fail closed rather than being hidden by the fallback.
 */
function isMissingSchemaObject(error: unknown): boolean {
  const code = error && typeof error === 'object' ? (error as SqlError).code : undefined
  return code === '42P01' || code === '42703'
}

async function beginPlatformRead(client: SqlClient) {
  await client.query('BEGIN READ ONLY')
  await client.query(`SELECT set_config('app.platform_scope', 'platform_ops', true)`)
}

const modernSummarySql = `SELECT s.workspace_id AS "workspaceId",
                COALESCE(NULLIF(btrim(e.name), ''), '${DEFAULT_ENTERPRISE_NAME}') AS "enterpriseName",
                s.status, s.plan_name AS "planName",
                s.monthly_price_cny AS "monthlyPriceCny", s.used_tasks AS "usedTasks",
                s.included_tasks AS "includedTasks", s.subscription_status AS "subscriptionStatus",
                s.member_count AS "memberCount"
           FROM ops_workspace_summaries s
           JOIN workspaces w ON w.id = s.workspace_id
           JOIN enterprises e ON e.id = w.enterprise_id
          ORDER BY s.created_at DESC, s.workspace_id ASC`

const legacySummarySql = `SELECT s.workspace_id AS "workspaceId",
                '${DEFAULT_ENTERPRISE_NAME}' AS "enterpriseName",
                s.status, s.plan_name AS "planName",
                s.monthly_price_cny AS "monthlyPriceCny", s.used_tasks AS "usedTasks",
                s.included_tasks AS "includedTasks", s.subscription_status AS "subscriptionStatus",
                s.member_count AS "memberCount"
           FROM ops_workspace_summaries s
          ORDER BY s.created_at DESC, s.workspace_id ASC`

type DirectorySqlParts = {
  values: unknown[]
  filterValues: unknown[]
  whereClause: string
  offsetIndex: number
  limitIndex: number
}

function directorySqlParts(query: OpsWorkspaceDirectoryQuery, includeEnterprise: boolean): DirectorySqlParts {
  const values: unknown[] = []
  const where: string[] = []
  if (query.query) {
    values.push(`%${query.query}%`)
    const index = values.length
    where.push(includeEnterprise
      ? `(s.workspace_id ILIKE $${index} OR e.name ILIKE $${index} OR s.plan_name ILIKE $${index})`
      : `(s.workspace_id ILIKE $${index} OR s.plan_name ILIKE $${index})`)
  }
  if (query.status) {
    values.push(query.status)
    where.push(`s.status = $${values.length}`)
  }
  if (query.subscriptionStatus) {
    values.push(query.subscriptionStatus)
    where.push(`s.subscription_status = $${values.length}`)
  }
  const filterValues = [...values]
  const offsetIndex = values.push(query.offset)
  const limitIndex = values.push(query.limit)
  return { values, filterValues, whereClause: where.length ? `WHERE ${where.join(' AND ')}` : '', offsetIndex, limitIndex }
}

function modernDirectoryCountSql(parts: DirectorySqlParts): string {
  return `SELECT count(*)::integer AS "totalCount",
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
          ${parts.whereClause}`
}

function legacyDirectoryCountSql(parts: DirectorySqlParts): string {
  return `SELECT count(*)::integer AS "totalCount",
                0::integer AS "merchantWorkspaceCount",
                count(*) FILTER (WHERE EXISTS (
                  SELECT 1 FROM workspace_members m
                   WHERE m.workspace_id = s.workspace_id AND m.status = 'active'
                ))::integer AS "activeMemberWorkspaceCount"
           FROM ops_workspace_summaries s
          ${parts.whereClause}`
}

function directoryRowsSql(parts: DirectorySqlParts, includeEnterprise: boolean): string {
  const from = includeEnterprise
    ? `FROM ops_workspace_summaries s
           JOIN workspaces w ON w.id = s.workspace_id
           JOIN enterprises e ON e.id = w.enterprise_id`
    : 'FROM ops_workspace_summaries s'
  const enterprise = includeEnterprise
    ? `COALESCE(NULLIF(btrim(e.name), ''), '${DEFAULT_ENTERPRISE_NAME}')`
    : `'${DEFAULT_ENTERPRISE_NAME}'`
  return `SELECT s.workspace_id AS "workspaceId",
                ${enterprise} AS "enterpriseName",
                s.status, s.plan_name AS "planName",
                s.monthly_price_cny AS "monthlyPriceCny", s.used_tasks AS "usedTasks",
                s.included_tasks AS "includedTasks", s.subscription_status AS "subscriptionStatus",
                s.member_count AS "memberCount"
           ${from}
          ${parts.whereClause}
          ORDER BY s.created_at DESC, s.workspace_id ASC
          OFFSET $${parts.offsetIndex} LIMIT $${parts.limitIndex}`
}

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
      await beginPlatformRead(client)
      let result
      try {
        result = await client.query<OpsWorkspaceSummary>(modernSummarySql)
      } catch (error) {
        if (!isMissingSchemaObject(error)) throw error
        // PostgreSQL aborts a transaction after a relation/column error.  Start
        // a fresh read-only transaction before issuing the historical query.
        await client.query('ROLLBACK')
        await beginPlatformRead(client)
        result = await client.query<OpsWorkspaceSummary>(legacySummarySql)
      }
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
      const run = async (includeEnterprise: boolean) => {
        const parts = directorySqlParts(query, includeEnterprise)
        const countResult = await client.query<{ totalCount: number; merchantWorkspaceCount: number; activeMemberWorkspaceCount: number }>(
          includeEnterprise ? modernDirectoryCountSql(parts) : legacyDirectoryCountSql(parts),
          parts.filterValues,
        )
        const result = await client.query<OpsWorkspaceSummary>(
          directoryRowsSql(parts, includeEnterprise),
          parts.values,
        )
        const total = Number(countResult.rows[0]?.totalCount ?? 0)
        const merchantWorkspaceCount = Number(countResult.rows[0]?.merchantWorkspaceCount ?? 0)
        const activeMemberWorkspaceCount = Number(countResult.rows[0]?.activeMemberWorkspaceCount ?? 0)
        return { items: result.rows, total, merchantWorkspaceCount, activeMemberWorkspaceCount, offset: query.offset, limit: query.limit, hasMore: query.offset + result.rows.length < total }
      }

      await beginPlatformRead(client)
      let page: OpsWorkspaceDirectoryPage
      try {
        page = await run(true)
      } catch (error) {
        if (!isMissingSchemaObject(error)) throw error
        await client.query('ROLLBACK')
        await beginPlatformRead(client)
        page = await run(false)
      }
      await client.query('COMMIT')
      return page
    } catch (error) {
      try { await client.query('ROLLBACK') } catch { /* preserve original */ }
      throw error
    } finally { client.release?.() }
  }
}
