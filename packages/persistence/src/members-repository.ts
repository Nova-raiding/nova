import { randomUUID } from 'node:crypto'
import { requireWorkspaceScope, type SqlClient, type SqlPool, withWorkspaceTransaction } from './repository.js'
import type { OperationAudit } from './operations-repository.js'

export type MemberRole = 'workspace_owner' | 'merchant_admin' | 'operator' | 'support' | 'finance' | 'platform_ops'
export type MemberStatus = 'invited' | 'active' | 'suspended'
export interface WorkspaceMember { id: string; workspaceId: string; externalSubject: string; displayName: string; role: MemberRole; status: MemberStatus; invitedBy: string; identityId?: string; revision: number; createdAt: string; updatedAt: string }
export interface WorkspaceMemberPage { items: WorkspaceMember[]; total: number; offset: number; limit: number; hasMore: boolean; activeOwnerCount: number }
export interface MemberStatusAuditInput { workspaceId: string; externalSubject: string; targetStatus: MemberStatus; expectedRevision: number; actorId: string; action: string; reason: string }
export interface MemberUpsertAuditInput { workspaceId: string; externalSubject: string; displayName: string; role: MemberRole; status: MemberStatus; expectedRevision?: number; actorId: string; action: string; reason: string }
/**
 * Placeholder shown by the Ops console for a workspace whose enterprise has no
 * usable name. The platform user directory and this repository's `query`
 * predicate must agree on it, otherwise a search would match a row the console
 * renders with a different value.
 */
export const DEFAULT_MEMBER_ENTERPRISE_NAME = '未命名企业主体'

/**
 * Platform user directory order: most recently updated first, then by subject.
 * This is the single definition of the order `ops.users.list`/`ops.users.export`
 * return and of the order `searchWindow` cuts its window at, so a SQL cut and a
 * JavaScript re-sort can never disagree about which row is the boundary.
 */
export function compareMembersByRecency(left: { updatedAt: string; externalSubject: string }, right: { updatedAt: string; externalSubject: string }): number {
  return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime() || left.externalSubject.localeCompare(right.externalSubject)
}

/** The identity key `ops.users.list` counts distinct identities by. */
export function memberIdentityKey(member: { identityId?: string; externalSubject: string }): string {
  return member.identityId ?? `subject:${member.externalSubject}`
}

/**
 * The `query` predicate of the platform user directory, shared verbatim by the
 * SQL `strpos` translation, the in-memory repository and the server's account
 * rows. `query` is expected to be trimmed and lower-cased by the caller.
 */
export function memberMatchesQuery(fields: { externalSubject: string; displayName: string; enterpriseName: string; workspaceId: string; role: string }, query: string): boolean {
  return [fields.externalSubject, fields.displayName, fields.enterpriseName, fields.workspaceId, fields.role]
    .some(value => value.toLocaleLowerCase().includes(query))
}

/**
 * A bounded window of the platform user directory.
 *
 * `items` covers every matched member whose `updatedAt` falls between the rows
 * at positions `firstIndex = max(0, offset - mergeMargin)` and
 * `offset + limit - 1` of the member list ordered by `updated_at` alone, plus
 * every row that ties with either boundary, and `itemsFrom` is how many matched
 * rows that window left out at the top. A caller that merges the rows it holds
 * from another relation, sorts with `compareMembersByRecency` and slices
 * `[offset - itemsFrom, offset - itemsFrom + limit)` therefore gets exactly the
 * page the whole directory would produce, without reading the directory. Rows
 * above `firstIndex` cannot reach the page even after the other relation's rows
 * are merged in — the `mergeMargin` is how many rows that relation can push —
 * and rows below the window sort after it.
 *
 * `itemsFrom` counts rows rather than reusing `firstIndex` because the window
 * is cut on `updated_at` and the position of a timestamp in the database's
 * collation order is not its position in `compareMembersByRecency` order once a
 * group of rows shares one timestamp.
 *
 * The boundaries are timestamps rather than SQL `OFFSET`/`LIMIT` positions on
 * purpose. `compareMembersByRecency` orders by `updatedAt` first, so a timestamp
 * boundary is exact whatever the database collation does with the subject
 * tie-break, and a bulk fixture that wrote a whole directory in one transaction
 * still yields a window instead of a page cut through the middle of a group of
 * rows that tie.
 *
 * `total`, `identityCount` and `workspaceCount` are counted over every matched
 * row, not over `items` — the caller must never have to present a page size as
 * a total.
 */
export interface MemberSearchInput {
  /** Workspaces in scope. An empty list means "no workspaces", never "no filter". */
  workspaceIds: readonly string[]
  status?: MemberStatus
  /** Trimmed, lower-cased substring matched against subject, name, enterprise, workspace and role. */
  query?: string
  /** 0-based position in the sorted directory of the first row the caller renders. */
  offset: number
  /** How many rows the caller renders from `offset`. */
  limit: number
  /**
   * How many rows the caller merges in from another relation before slicing the
   * page. They can push a member row out of the window, so the window starts
   * that many rows earlier.
   */
  mergeMargin?: number
  /**
   * Identity keys the caller holds from another source (platform accounts), so
   * `identityCount` is the count over the caller's merged result and not just
   * over the member half of it.
   */
  identityKeys?: readonly string[]
  /**
   * The caller's own workspace → enterprise-name projection, which the `query`
   * predicate matches because `ops.users.list` searches the name it renders.
   * Passing the caller's map (rather than joining `enterprises` here) keeps the
   * searched value and the displayed value the same string for every workspace,
   * including the ones the caller had to fall back for. Missing workspaces match
   * as `DEFAULT_MEMBER_ENTERPRISE_NAME`.
   */
  enterpriseNames?: ReadonlyMap<string, string>
}

export interface MemberSearchResult {
  items: WorkspaceMember[]
  /** 0-based position in the sorted directory of `items[0]`, i.e. `firstIndex`. */
  itemsFrom: number
  total: number
  identityCount: number
  workspaceCount: number
}

export interface MemberSubjectLookup {
  /** Workspaces in scope. An empty list means "no workspaces", never "no filter". */
  workspaceIds: readonly string[]
  identityId?: string
  externalSubject?: string
}

export interface MembersRepository { list(workspaceId: string): Promise<WorkspaceMember[]>; listPage?(workspaceId: string, input: { offset: number; limit: number }): Promise<WorkspaceMemberPage>; listMany?(workspaceIds: readonly string[]): Promise<WorkspaceMember[]>; bindIdentity(input: { workspaceId: string; externalSubject: string; identityId: string }): Promise<WorkspaceMember>; upsert(input: { workspaceId: string; externalSubject: string; displayName: string; role: MemberRole; status: MemberStatus; invitedBy: string }): Promise<WorkspaceMember>; suspend(input: { workspaceId: string; externalSubject: string; actorId: string; reason: string }): Promise<WorkspaceMember>; upsertWithAudit(input: MemberUpsertAuditInput): Promise<{ member: WorkspaceMember; audit: OperationAudit }>; changeStatusWithAudit(input: MemberStatusAuditInput): Promise<{ member: WorkspaceMember; audit: OperationAudit }>; searchWindow?(input: MemberSearchInput): Promise<MemberSearchResult>; findBySubject?(input: MemberSubjectLookup): Promise<WorkspaceMember[]> }

type WorkspaceMemberRow = Omit<WorkspaceMember, 'identityId' | 'createdAt' | 'updatedAt'> & { identityId?: string | null; createdAt: string | Date; updatedAt: string | Date }
const memberFromRow = (row: WorkspaceMemberRow): WorkspaceMember => {
  const { identityId, ...rest } = row
  return {
    ...rest,
    ...(identityId ? { identityId } : {}),
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
  }
}

/**
 * In-memory twin of the PostgreSQL `searchWindow`: same predicate, same order,
 * and the same widening at the boundary, so a suite can assert that both
 * implementations return the same page for one fixture.
 */
function searchInMemory(rows: readonly WorkspaceMember[], input: MemberSearchInput): MemberSearchResult {
  const allowed = new Set(input.workspaceIds)
  const query = input.query ?? ''
  const enterpriseNames = input.enterpriseNames
  const matched = [...rows]
    .filter(row => allowed.has(row.workspaceId))
    .filter(row => !input.status || row.status === input.status)
    .filter(row => !query || memberMatchesQuery({ ...row, enterpriseName: enterpriseNames?.get(row.workspaceId) ?? DEFAULT_MEMBER_ENTERPRISE_NAME }, query))
    .sort(compareMembersByRecency)
  const firstIndex = Math.max(0, Math.floor(input.offset) - Math.max(0, Math.floor(input.mergeMargin ?? 0)))
  const lastIndex = Math.max(0, Math.floor(input.offset)) + Math.max(1, Math.floor(input.limit)) - 1
  // `matched` is newest first, so the row at `firstIndex` carries the newest
  // timestamp of the window and the one at `lastIndex` the oldest.
  const first = matched[firstIndex]
  const last = matched[lastIndex]
  const items = !first ? [] : matched.filter(row => Date.parse(row.updatedAt) <= Date.parse(first.updatedAt) && (!last || Date.parse(row.updatedAt) >= Date.parse(last.updatedAt)))
  return {
    items,
    itemsFrom: first ? matched.filter(row => Date.parse(row.updatedAt) > Date.parse(first.updatedAt)).length : firstIndex,
    total: matched.length,
    identityCount: new Set([...matched.map(memberIdentityKey), ...(input.identityKeys ?? [])]).size,
    workspaceCount: new Set(matched.map(row => row.workspaceId).filter(Boolean)).size,
  }
}

export class MemoryMembersRepository implements MembersRepository {
  private readonly rows = new Map<string, WorkspaceMember>()
  async list(workspaceId: string) { return [...this.rows.values()].filter(row => row.workspaceId === workspaceId) }
  async listPage(workspaceId: string, input: { offset: number; limit: number }): Promise<WorkspaceMemberPage> {
    const all = await this.list(workspaceId)
    const offset = Math.max(0, input.offset); const limit = Math.min(100, Math.max(1, input.limit))
    return { items: all.slice(offset, offset + limit), total: all.length, offset, limit, hasMore: offset + limit < all.length, activeOwnerCount: all.filter(row => row.role === 'workspace_owner' && row.status === 'active').length }
  }
  async listMany(workspaceIds: readonly string[]) { const allowed = new Set(workspaceIds); return [...this.rows.values()].filter(row => allowed.has(row.workspaceId)) }
  async searchWindow(input: MemberSearchInput): Promise<MemberSearchResult> {
    return searchInMemory([...this.rows.values()], input)
  }
  async findBySubject(input: MemberSubjectLookup): Promise<WorkspaceMember[]> {
    const identityId = input.identityId
    const externalSubject = input.externalSubject
    return [...this.rows.values()]
      .filter(row => input.workspaceIds.includes(row.workspaceId))
      .filter(row => identityId ? row.identityId === identityId || row.externalSubject === externalSubject : row.externalSubject === externalSubject)
      .sort((left, right) => compareMembersByRecency(left, right) || left.workspaceId.localeCompare(right.workspaceId))
  }
  async bindIdentity(input: { workspaceId: string; externalSubject: string; identityId: string }) { const key = `${input.workspaceId}:${input.externalSubject}`; const current = this.rows.get(key); if (!current) throw new Error('MEMBER_NOT_FOUND'); if (current.identityId && current.identityId !== input.identityId) throw new Error('MEMBER_IDENTITY_CONFLICT'); if (current.identityId) return current; const row = { ...current, identityId: input.identityId }; this.rows.set(key, row); return row }
  async upsert(input: { workspaceId: string; externalSubject: string; displayName: string; role: MemberRole; status: MemberStatus; invitedBy: string }) { const key = `${input.workspaceId}:${input.externalSubject}`; const current = this.rows.get(key); const now = new Date().toISOString(); const row = { id: current?.id ?? `member_${randomUUID()}`, ...input, revision: (current?.revision ?? 0) + 1, createdAt: current?.createdAt ?? now, updatedAt: now }; this.rows.set(key, row); return row }
  async suspend(input: { workspaceId: string; externalSubject: string; actorId: string; reason: string }) { const key = `${input.workspaceId}:${input.externalSubject}`; const current = this.rows.get(key); if (!current) throw new Error('MEMBER_NOT_FOUND'); const row = { ...current, status: 'suspended' as const, revision: current.revision + 1, updatedAt: new Date().toISOString() }; this.rows.set(key, row); return row }
  async upsertWithAudit(input: MemberUpsertAuditInput) {
    const key = `${input.workspaceId}:${input.externalSubject}`
    const current = this.rows.get(key)
    if (current && input.expectedRevision !== current.revision) throw new Error('MEMBER_REVISION_CONFLICT')
    if (!current && input.expectedRevision !== undefined) throw new Error('MEMBER_REVISION_CONFLICT')
    const member = await this.upsert({ workspaceId: input.workspaceId, externalSubject: input.externalSubject, displayName: input.displayName, role: input.role, status: input.status, invitedBy: input.actorId })
    const audit: OperationAudit = { id: `audit_${randomUUID()}`, workspaceId: input.workspaceId, actorId: input.actorId, action: input.action, resourceType: 'workspace_member', resourceId: input.externalSubject, before: (current ?? {}) as Record<string, unknown>, after: member as unknown as Record<string, unknown>, reason: input.reason, createdAt: member.updatedAt }
    return { member, audit }
  }
  async changeStatusWithAudit(input: MemberStatusAuditInput) {
    const key = `${input.workspaceId}:${input.externalSubject}`
    const current = this.rows.get(key)
    if (!current) throw new Error('MEMBER_NOT_FOUND')
    if (current.revision !== input.expectedRevision) throw new Error('MEMBER_REVISION_CONFLICT')
    const createdAt = new Date().toISOString()
    const member = { ...current, status: input.targetStatus, revision: current.revision + 1, updatedAt: createdAt }
    const audit: OperationAudit = { id: `audit_${randomUUID()}`, workspaceId: input.workspaceId, actorId: input.actorId, action: input.action, resourceType: 'workspace_member', resourceId: input.externalSubject, before: current as unknown as Record<string, unknown>, after: member as unknown as Record<string, unknown>, reason: input.reason, createdAt }
    this.rows.set(key, member)
    return { member, audit }
  }
}

const memberProjection = `m.id AS id, m.workspace_id AS "workspaceId", m.external_subject AS "externalSubject", m.display_name AS "displayName", m.role AS role, m.status AS status, m.invited_by AS "invitedBy", m.identity_id AS "identityId", m.revision AS revision, m.created_at AS "createdAt", m.updated_at AS "updatedAt"`

/** The identity key `ops.users.list` counts distinct identities by, in SQL. */
const memberIdentityKeySql = `coalesce(m.identity_id::text, 'subject:' || m.external_subject)`

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

type MemberFilterSql = { from: string; where: string; values: unknown[] }

/**
 * `strpos` is the SQL spelling of `String.prototype.includes`: unlike `LIKE` it
 * has no wildcard characters, so a query containing `%` or `_` stays literal,
 * and `lower()` reproduces the caller's `toLocaleLowerCase()` for the ASCII
 * identifiers and logins the directory holds.
 */
function memberFilterSql(input: MemberSearchInput, workspaceIds: readonly string[]): MemberFilterSql {
  const values: unknown[] = []
  const where: string[] = []
  values.push([...workspaceIds])
  where.push(`m.workspace_id = ANY($${values.length})`)
  if (input.status) {
    values.push(input.status)
    where.push(`m.status = $${values.length}`)
  }
  let from = 'FROM workspace_members m'
  if (input.query) {
    values.push(input.query)
    const index = values.length
    // The caller's own workspace → name projection, joined by workspace id.
    // Resolving the name from `enterprises` here would search a different
    // string than the one the caller renders whenever its own projection had to
    // fall back, so the predicate takes the caller's map instead.
    const named = [...(input.enterpriseNames ?? [])]
    values.push(named.map(([workspaceId]) => workspaceId))
    const workspaceIndex = values.length
    values.push(named.map(([, enterpriseName]) => enterpriseName))
    const nameIndex = values.length
    from = `FROM workspace_members m LEFT JOIN unnest($${workspaceIndex}::text[], $${nameIndex}::text[]) AS member_workspace_name(workspace_id, enterprise_name) ON member_workspace_name.workspace_id = m.workspace_id`
    where.push(`(strpos(lower(m.external_subject), $${index}) > 0
              OR strpos(lower(m.display_name), $${index}) > 0
              OR strpos(lower(coalesce(member_workspace_name.enterprise_name, '${DEFAULT_MEMBER_ENTERPRISE_NAME}')), $${index}) > 0
              OR strpos(lower(m.workspace_id), $${index}) > 0
              OR strpos(lower(m.role), $${index}) > 0)`)
  }
  return { from, where: where.join(' AND '), values }
}

/**
 * The counts the platform user directory reports. They are counted over every
 * matched row, never over the page: `identityCount` folds in the keys the caller
 * holds from another source, so a directory assembled from more than one
 * relation can still report one honest identity total.
 */
function memberCountsSql(filter: MemberFilterSql): string {
  return `WITH filtered AS (
            SELECT ${memberIdentityKeySql} AS "identityKey", m.workspace_id AS "workspaceId"
            ${filter.from} WHERE ${filter.where}
          )
          SELECT (SELECT count(*)::text FROM filtered) AS "total",
                 (SELECT count(DISTINCT "workspaceId")::text FROM filtered) AS "workspaceCount",
                 (SELECT count(DISTINCT keys."value")::text FROM (
                    SELECT filtered."identityKey" AS "value" FROM filtered
                    UNION ALL
                    SELECT extra."value" FROM unnest($${filter.values.length + 1}::text[]) AS extra("value")
                  ) keys) AS "identityCount"`
}

/**
 * The window the caller asked for, cut on `updated_at` boundaries instead of on
 * SQL `OFFSET`/`LIMIT` positions.
 *
 * Both boundaries are the `updated_at` of a row at a known position of the
 * sorted member list, so the fetch is `limit + mergeMargin` rows wide whatever
 * the caller's `offset` is, and it is independent of the collation: the
 * comparator orders by `updated_at` before it looks at the subject, so the rows
 * a timestamp excludes from the window stay outside it even after another
 * relation's rows are merged in. The rows that tie with either boundary come
 * along, which keeps the caller's own sort deciding the window rather than an
 * arbitrary cut through a group of rows a bulk fixture wrote in one transaction.
 *
 * A missing low boundary means the window starts past the end of the directory:
 * the caller's page holds no member, and the query returns nothing instead of
 * the whole directory.
 */
function memberWindowSql(filter: MemberFilterSql, lowIndex: number, highIndex: number): string {
  const firstParam = filter.values.length + 1
  const lastParam = filter.values.length + 2
  // The list is newest first, so the row at `lowIndex` carries the newest
  // timestamp the window may contain and the row at `highIndex` the oldest.
  return `WITH filtered AS (
            SELECT ${memberProjection} ${filter.from} WHERE ${filter.where}
          ),
          bounds AS (
            SELECT (SELECT "updatedAt" FROM filtered ORDER BY "updatedAt" DESC, id ASC OFFSET $${firstParam} LIMIT 1) AS "first",
                   (SELECT "updatedAt" FROM filtered ORDER BY "updatedAt" DESC, id ASC OFFSET $${lastParam} LIMIT 1) AS "last"
          )
          SELECT filtered.*,
                 (SELECT count(*)::text FROM filtered skipped, bounds edge
                   WHERE edge."first" IS NOT NULL AND skipped."updatedAt" > edge."first") AS "__itemsFrom"
            FROM filtered, bounds
           WHERE bounds."first" IS NOT NULL
             AND "updatedAt" <= bounds."first"
             AND (bounds."last" IS NULL OR "updatedAt" >= bounds."last")
           ORDER BY "updatedAt" DESC, "externalSubject" ASC, "workspaceId" ASC, id ASC
          /* window ${lowIndex}..${highIndex} */`
}

/**
 * Reads the platform user directory with the isolated operations role, whose
 * `app.platform_scope = 'platform_ops'` grant is the only way to see
 * `workspace_members` outside a single tenant scope (migration 091). `READ ONLY`
 * because every caller is a read path, and the explicit workspace list keeps the
 * result identical whether the connection is the operations role or a
 * superuser, instead of depending on which of the two RLS lets through.
 */
async function withPlatformRead<T>(pool: SqlPool, work: (client: SqlClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  let committed = false
  try {
    await client.query('BEGIN READ ONLY')
    await client.query(`SELECT set_config('app.platform_scope', 'platform_ops', true)`)
    const result = await work(client)
    await client.query('COMMIT')
    committed = true
    return result
  } catch (error) {
    if (!committed) {
      try { await client.query('ROLLBACK') } catch { /* preserve the original error */ }
    }
    throw error
  } finally {
    client.release?.()
  }
}

function scopedWorkspaceIds(workspaceIds: readonly string[]): string[] {
  return [...new Set(workspaceIds.map(id => requireWorkspaceScope(id)))]
}

export class PostgresMembersRepository implements MembersRepository {
  /**
   * Platform-scoped reads. Both methods exist only when the deployment was given
   * a pool that can hold the operations role: without it a platform-wide read
   * would either be the per-workspace fan-out these replace or, on a connection
   * still bound by tenant RLS, an empty directory presented as a real one.
   */
  readonly searchWindow?: (input: MemberSearchInput) => Promise<MemberSearchResult>
  readonly findBySubject?: (input: MemberSubjectLookup) => Promise<WorkspaceMember[]>
  constructor(private readonly pool: SqlPool, platformPool?: SqlPool) {
    if (!platformPool) return
    this.searchWindow = async input => {
      const workspaceIds = scopedWorkspaceIds(input.workspaceIds)
      const offset = Math.max(0, Math.floor(input.offset))
      const limit = Math.max(1, Math.floor(input.limit))
      const lowIndex = Math.max(0, offset - Math.max(0, Math.floor(input.mergeMargin ?? 0)))
      const highIndex = offset + limit - 1
      const identityKeys = [...(input.identityKeys ?? [])]
      // One read-only platform transaction for both statements: the counts and
      // the window then describe the same snapshot, which is what makes `total`
      // and the page consistent with each other.
      return withPlatformRead(platformPool, async client => {
        const filter = memberFilterSql(input, workspaceIds)
        const totals = await client.query<{ total: string; workspaceCount: string; identityCount: string }>(
          memberCountsSql(filter),
          [...filter.values, identityKeys],
        )
        const rows = await client.query<WorkspaceMemberRow & { __itemsFrom?: string }>(memberWindowSql(filter, lowIndex, highIndex), [...filter.values, lowIndex, highIndex])
        const stats = totals.rows[0]
        return {
          items: rows.rows.map(row => { const { __itemsFrom, ...member } = row; return memberFromRow(member) }),
          itemsFrom: Number(rows.rows[0]?.__itemsFrom ?? lowIndex),
          total: Number(stats?.total ?? 0),
          identityCount: Number(stats?.identityCount ?? 0),
          workspaceCount: Number(stats?.workspaceCount ?? 0),
        }
      })
    }
    this.findBySubject = async input => {
      const workspaceIds = scopedWorkspaceIds(input.workspaceIds)
      // `identity_id` is UUID; a caller-supplied non-UUID can never equal one, so
      // it is dropped rather than sent as a value PostgreSQL rejects with a raw
      // type error instead of an empty result.
      const identityId = input.identityId && UUID_PATTERN.test(input.identityId) ? input.identityId : null
      return withPlatformRead(platformPool, async client => {
        const result = await client.query<WorkspaceMemberRow>(
          `SELECT ${memberProjection} FROM workspace_members m
            WHERE m.workspace_id = ANY($1) AND (m.identity_id = $2 OR m.external_subject = $3)
            ORDER BY m.updated_at DESC, m.workspace_id ASC, m.external_subject ASC`,
          [workspaceIds, identityId, input.externalSubject ?? null],
        )
        return result.rows.map(memberFromRow)
      })
    }
  }
  async bindIdentity(input: { workspaceId: string; externalSubject: string; identityId: string }) {
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const existing = await client.query<WorkspaceMemberRow & { identityId: string | null }>(`SELECT id, workspace_id AS "workspaceId", external_subject AS "externalSubject", display_name AS "displayName", role, status, invited_by AS "invitedBy", identity_id AS "identityId", revision, created_at AS "createdAt", updated_at AS "updatedAt" FROM workspace_members WHERE workspace_id=$1 AND external_subject=$2 FOR UPDATE`, [input.workspaceId, input.externalSubject])
      if (!existing.rows[0]) throw new Error('MEMBER_NOT_FOUND')
      if (existing.rows[0].identityId && existing.rows[0].identityId !== input.identityId) throw new Error('MEMBER_IDENTITY_CONFLICT')
      if (existing.rows[0].identityId) return memberFromRow({ ...existing.rows[0], identityId: existing.rows[0].identityId })
      const updated = await client.query<WorkspaceMemberRow & { identityId: string | null }>(`UPDATE workspace_members SET identity_id=$3 WHERE workspace_id=$1 AND external_subject=$2 AND identity_id IS NULL RETURNING id, workspace_id AS "workspaceId", external_subject AS "externalSubject", display_name AS "displayName", role, status, invited_by AS "invitedBy", identity_id AS "identityId", revision, created_at AS "createdAt", updated_at AS "updatedAt"`, [input.workspaceId, input.externalSubject, input.identityId])
      if (!updated.rows[0]) throw new Error('MEMBER_IDENTITY_CONFLICT')
      return memberFromRow({ ...updated.rows[0], identityId: updated.rows[0].identityId ?? undefined })
    })
  }
  async list(workspaceId: string) { requireWorkspaceScope(workspaceId); return withWorkspaceTransaction(this.pool, workspaceId, async client => { const result = await client.query<WorkspaceMemberRow>(`SELECT id, workspace_id AS "workspaceId", external_subject AS "externalSubject", display_name AS "displayName", role, status, invited_by AS "invitedBy", identity_id AS "identityId", revision, created_at AS "createdAt", updated_at AS "updatedAt" FROM workspace_members WHERE workspace_id=$1 ORDER BY created_at ASC`, [workspaceId]); return result.rows.map(memberFromRow) }) }
  async listPage(workspaceId: string, input: { offset: number; limit: number }): Promise<WorkspaceMemberPage> {
    requireWorkspaceScope(workspaceId)
    const offset = Math.max(0, Math.floor(input.offset)); const limit = Math.min(100, Math.max(1, Math.floor(input.limit)))
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const [rows, count, owners] = await Promise.all([
        client.query<WorkspaceMemberRow>(`SELECT id, workspace_id AS "workspaceId", external_subject AS "externalSubject", display_name AS "displayName", role, status, invited_by AS "invitedBy", identity_id AS "identityId", revision, created_at AS "createdAt", updated_at AS "updatedAt" FROM workspace_members WHERE workspace_id=$1 ORDER BY created_at ASC, id ASC LIMIT $2 OFFSET $3`, [workspaceId, limit, offset]),
        client.query<{ count: string }>(`SELECT count(*)::text AS count FROM workspace_members WHERE workspace_id=$1`, [workspaceId]),
        client.query<{ count: string }>(`SELECT count(*)::text AS count FROM workspace_members WHERE workspace_id=$1 AND role='workspace_owner' AND status='active'`, [workspaceId]),
      ])
      const total = Number(count.rows[0]?.count ?? 0)
      return { items: rows.rows.map(memberFromRow), total, offset, limit, hasMore: offset + limit < total, activeOwnerCount: Number(owners.rows[0]?.count ?? 0) }
    })
  }
  async listMany(workspaceIds: readonly string[]) {
    const uniqueIds = [...new Set(workspaceIds.map(id => requireWorkspaceScope(id)))]
    if (!uniqueIds.length) return []
    const rows: WorkspaceMember[] = []
    let cursor = 0
    const workerCount = Math.min(8, uniqueIds.length)
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = cursor++
        if (index >= uniqueIds.length) return
        const workspaceId = uniqueIds[index]!
        const members = await withWorkspaceTransaction(this.pool, workspaceId, async client => {
          const result = await client.query<WorkspaceMemberRow>(`SELECT id, workspace_id AS "workspaceId", external_subject AS "externalSubject", display_name AS "displayName", role, status, invited_by AS "invitedBy", identity_id AS "identityId", revision, created_at AS "createdAt", updated_at AS "updatedAt" FROM workspace_members WHERE workspace_id=$1 ORDER BY created_at ASC`, [workspaceId])
          return result.rows.map(memberFromRow)
        })
        rows.push(...members)
      }
    }))
    return rows
  }
  async upsert(input: { workspaceId: string; externalSubject: string; displayName: string; role: MemberRole; status: MemberStatus; invitedBy: string }) { requireWorkspaceScope(input.workspaceId); return withWorkspaceTransaction(this.pool, input.workspaceId, async client => { const result = await client.query<WorkspaceMemberRow>(`INSERT INTO workspace_members (id, workspace_id, external_subject, display_name, role, status, invited_by) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (workspace_id, external_subject) DO UPDATE SET display_name=$4, role=$5, status=$6, invited_by=$7, revision=workspace_members.revision+1, updated_at=now() RETURNING id, workspace_id AS "workspaceId", external_subject AS "externalSubject", display_name AS "displayName", role, status, invited_by AS "invitedBy", revision, created_at AS "createdAt", updated_at AS "updatedAt"`, [randomUUID(), input.workspaceId, input.externalSubject, input.displayName, input.role, input.status, input.invitedBy]); return memberFromRow(result.rows[0]!) }) }
  async suspend(input: { workspaceId: string; externalSubject: string; actorId: string; reason: string }) { requireWorkspaceScope(input.workspaceId); return withWorkspaceTransaction(this.pool, input.workspaceId, async client => { const result = await client.query<WorkspaceMemberRow>(`UPDATE workspace_members SET status='suspended', revision=revision+1, updated_at=now() WHERE workspace_id=$1 AND external_subject=$2 RETURNING id, workspace_id AS "workspaceId", external_subject AS "externalSubject", display_name AS "displayName", role, status, invited_by AS "invitedBy", revision, created_at AS "createdAt", updated_at AS "updatedAt"`, [input.workspaceId, input.externalSubject]); if (!result.rows[0]) throw new Error('MEMBER_NOT_FOUND'); return memberFromRow(result.rows[0]) }) }
  async upsertWithAudit(input: MemberUpsertAuditInput) {
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const beforeResult = await client.query<WorkspaceMemberRow>(`SELECT id, workspace_id AS "workspaceId", external_subject AS "externalSubject", display_name AS "displayName", role, status, invited_by AS "invitedBy", revision, created_at AS "createdAt", updated_at AS "updatedAt" FROM workspace_members WHERE workspace_id=$1 AND external_subject=$2 FOR UPDATE`, [input.workspaceId, input.externalSubject])
      const before = beforeResult.rows[0] ? memberFromRow(beforeResult.rows[0]) : undefined
      if (before && input.expectedRevision !== before.revision) throw new Error('MEMBER_REVISION_CONFLICT')
      if (!before && input.expectedRevision !== undefined) throw new Error('MEMBER_REVISION_CONFLICT')
      const memberResult = await client.query<WorkspaceMemberRow>(`INSERT INTO workspace_members (id, workspace_id, external_subject, display_name, role, status, invited_by) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (workspace_id, external_subject) DO UPDATE SET display_name=$4, role=$5, status=$6, invited_by=$7, revision=workspace_members.revision+1, updated_at=now() WHERE workspace_members.revision=$8 RETURNING id, workspace_id AS "workspaceId", external_subject AS "externalSubject", display_name AS "displayName", role, status, invited_by AS "invitedBy", revision, created_at AS "createdAt", updated_at AS "updatedAt"`, [randomUUID(), input.workspaceId, input.externalSubject, input.displayName, input.role, input.status, input.actorId, input.expectedRevision ?? 0])
      if (!memberResult.rows[0]) throw new Error('MEMBER_REVISION_CONFLICT')
      const member = memberFromRow(memberResult.rows[0])
      const auditResult = await client.query<OperationAudit>(`INSERT INTO workspace_operation_audit (id, workspace_id, actor_id, action, resource_type, resource_id, before_json, after_json, reason) VALUES ($1,$2,$3,$4,'workspace_member',$5,$6,$7,$8) RETURNING id, workspace_id AS "workspaceId", actor_id AS "actorId", action, resource_type AS "resourceType", resource_id AS "resourceId", before_json AS "before", after_json AS "after", reason, created_at AS "createdAt"`, [randomUUID(), input.workspaceId, input.actorId, input.action, input.externalSubject, before ?? {}, member, input.reason])
      return { member, audit: auditResult.rows[0]! }
    })
  }
  async changeStatusWithAudit(input: MemberStatusAuditInput) {
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const beforeResult = await client.query<WorkspaceMemberRow>(`SELECT id, workspace_id AS "workspaceId", external_subject AS "externalSubject", display_name AS "displayName", role, status, invited_by AS "invitedBy", revision, created_at AS "createdAt", updated_at AS "updatedAt" FROM workspace_members WHERE workspace_id=$1 AND external_subject=$2 FOR UPDATE`, [input.workspaceId, input.externalSubject])
      if (!beforeResult.rows[0]) throw new Error('MEMBER_NOT_FOUND')
      const before = memberFromRow(beforeResult.rows[0])
      if (before.revision !== input.expectedRevision) throw new Error('MEMBER_REVISION_CONFLICT')
      const memberResult = await client.query<WorkspaceMemberRow>(`UPDATE workspace_members SET status=$3, revision=revision+1, updated_at=now() WHERE workspace_id=$1 AND external_subject=$2 AND revision=$4 RETURNING id, workspace_id AS "workspaceId", external_subject AS "externalSubject", display_name AS "displayName", role, status, invited_by AS "invitedBy", revision, created_at AS "createdAt", updated_at AS "updatedAt"`, [input.workspaceId, input.externalSubject, input.targetStatus, input.expectedRevision])
      if (!memberResult.rows[0]) throw new Error('MEMBER_REVISION_CONFLICT')
      const member = memberFromRow(memberResult.rows[0])
      const auditId = randomUUID()
      const auditResult = await client.query<OperationAudit>(`INSERT INTO workspace_operation_audit (id, workspace_id, actor_id, action, resource_type, resource_id, before_json, after_json, reason) VALUES ($1,$2,$3,$4,'workspace_member',$5,$6,$7,$8) RETURNING id, workspace_id AS "workspaceId", actor_id AS "actorId", action, resource_type AS "resourceType", resource_id AS "resourceId", before_json AS "before", after_json AS "after", reason, created_at AS "createdAt"`, [auditId, input.workspaceId, input.actorId, input.action, input.externalSubject, before, member, input.reason])
      return { member, audit: auditResult.rows[0]! }
    })
  }
}
