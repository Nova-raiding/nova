import { randomUUID } from 'node:crypto'
import { requireWorkspaceScope, type SqlPool, withWorkspaceTransaction } from './repository.js'
import type { OperationAudit } from './operations-repository.js'

export type MemberRole = 'workspace_owner' | 'merchant_admin' | 'operator' | 'support' | 'finance' | 'platform_ops'
export type MemberStatus = 'invited' | 'active' | 'suspended'
export interface WorkspaceMember { id: string; workspaceId: string; externalSubject: string; displayName: string; role: MemberRole; status: MemberStatus; invitedBy: string; identityId?: string; revision: number; createdAt: string; updatedAt: string }
export interface MemberStatusAuditInput { workspaceId: string; externalSubject: string; targetStatus: MemberStatus; expectedRevision: number; actorId: string; action: string; reason: string }
export interface MemberUpsertAuditInput { workspaceId: string; externalSubject: string; displayName: string; role: MemberRole; status: MemberStatus; expectedRevision?: number; actorId: string; action: string; reason: string }
export interface MembersRepository { list(workspaceId: string): Promise<WorkspaceMember[]>; listMany?(workspaceIds: readonly string[]): Promise<WorkspaceMember[]>; bindIdentity(input: { workspaceId: string; externalSubject: string; identityId: string }): Promise<WorkspaceMember>; upsert(input: { workspaceId: string; externalSubject: string; displayName: string; role: MemberRole; status: MemberStatus; invitedBy: string }): Promise<WorkspaceMember>; suspend(input: { workspaceId: string; externalSubject: string; actorId: string; reason: string }): Promise<WorkspaceMember>; upsertWithAudit(input: MemberUpsertAuditInput): Promise<{ member: WorkspaceMember; audit: OperationAudit }>; changeStatusWithAudit(input: MemberStatusAuditInput): Promise<{ member: WorkspaceMember; audit: OperationAudit }> }

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

export class MemoryMembersRepository implements MembersRepository {
  private readonly rows = new Map<string, WorkspaceMember>()
  async list(workspaceId: string) { return [...this.rows.values()].filter(row => row.workspaceId === workspaceId) }
  async listMany(workspaceIds: readonly string[]) { const allowed = new Set(workspaceIds); return [...this.rows.values()].filter(row => allowed.has(row.workspaceId)) }
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

export class PostgresMembersRepository implements MembersRepository {
  constructor(private readonly pool: SqlPool) {}
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
  async listMany(workspaceIds: readonly string[]) {
    const uniqueIds = [...new Set(workspaceIds.map(id => requireWorkspaceScope(id)))]
    if (!uniqueIds.length) return []
    const client = await this.pool.connect()
    const rows: WorkspaceMember[] = []
    try {
      for (const workspaceId of uniqueIds) {
        await client.query('BEGIN')
        try {
          await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId])
          const result = await client.query<WorkspaceMemberRow>(`SELECT id, workspace_id AS "workspaceId", external_subject AS "externalSubject", display_name AS "displayName", role, status, invited_by AS "invitedBy", identity_id AS "identityId", revision, created_at AS "createdAt", updated_at AS "updatedAt" FROM workspace_members WHERE workspace_id=$1 ORDER BY created_at ASC`, [workspaceId])
          rows.push(...result.rows.map(memberFromRow))
          await client.query('COMMIT')
        } catch (error) {
          try { await client.query('ROLLBACK') } catch { /* preserve original error */ }
          throw error
        }
      }
      return rows
    } finally { client.release?.() }
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
      const auditResult = await client.query<OperationAudit>(`INSERT INTO workspace_operation_audit (id, workspace_id, actor_id, action, resource_type, resource_id, before_json, after_json, reason) VALUES ($1,$2,$3,$4,'workspace_member',$5,$6,$7,$8) RETURNING id, workspace_id AS "workspaceId", actor_id AS "actorId", action, resource_type AS "resourceType", resource_id AS "resourceId", before_json AS "before", after_json AS "after", reason, created_at AS "createdAt"`, [`audit_${randomUUID()}`, input.workspaceId, input.actorId, input.action, input.externalSubject, before ?? {}, member, input.reason])
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
      const auditId = `audit_${randomUUID()}`
      const auditResult = await client.query<OperationAudit>(`INSERT INTO workspace_operation_audit (id, workspace_id, actor_id, action, resource_type, resource_id, before_json, after_json, reason) VALUES ($1,$2,$3,$4,'workspace_member',$5,$6,$7,$8) RETURNING id, workspace_id AS "workspaceId", actor_id AS "actorId", action, resource_type AS "resourceType", resource_id AS "resourceId", before_json AS "before", after_json AS "after", reason, created_at AS "createdAt"`, [auditId, input.workspaceId, input.actorId, input.action, input.externalSubject, before, member, input.reason])
      return { member, audit: auditResult.rows[0]! }
    })
  }
}
