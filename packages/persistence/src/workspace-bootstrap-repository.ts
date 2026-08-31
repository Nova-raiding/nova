import { randomUUID } from 'node:crypto'
import type { MembersRepository } from './members-repository.js'
import type { OperationsRepository } from './operations-repository.js'
import type { SqlPool } from './repository.js'

export interface WorkspaceBootstrapInput {
  issuer: string
  externalSubject: string
  identityId?: string
  candidateWorkspaceId: string
  displayName: string
  actorId: string
}

export interface WorkspaceBootstrapResult {
  workspaceId: string
  displayName: string
  created: boolean
}

export interface WorkspaceBootstrapRepository {
  bootstrap(input: WorkspaceBootstrapInput): Promise<WorkspaceBootstrapResult>
}

export class WorkspaceBootstrapError extends Error {
  constructor(readonly code: 'WORKSPACE_BOOTSTRAP_IDENTITY_MISMATCH' | 'WORKSPACE_BOOTSTRAP_BINDING_INACTIVE', message = code) {
    super(message)
    this.name = 'WorkspaceBootstrapError'
  }
}

function normalized(input: WorkspaceBootstrapInput): WorkspaceBootstrapInput {
  const issuer = input.issuer.trim()
  const externalSubject = input.externalSubject.trim()
  const candidateWorkspaceId = input.candidateWorkspaceId.trim()
  const displayName = input.displayName.trim()
  const actorId = input.actorId.trim()
  if (!issuer || !externalSubject || !candidateWorkspaceId || !displayName || !actorId) throw new WorkspaceBootstrapError('WORKSPACE_BOOTSTRAP_IDENTITY_MISMATCH')
  return { ...input, issuer, externalSubject, candidateWorkspaceId, displayName, actorId, ...(input.identityId?.trim() ? { identityId: input.identityId.trim() } : {}) }
}

export class MemoryWorkspaceBootstrapRepository implements WorkspaceBootstrapRepository {
  private readonly bindings = new Map<string, Omit<WorkspaceBootstrapResult, 'created'>>()
  private readonly inFlight = new Map<string, Promise<WorkspaceBootstrapResult>>()

  constructor(
    private readonly members: MembersRepository,
    private readonly operations: OperationsRepository,
    private readonly activateWorkspace: (workspaceId: string) => void,
    private readonly workspaceStatus: (workspaceId: string) => 'active' | 'disabled',
  ) {}

  async bootstrap(raw: WorkspaceBootstrapInput): Promise<WorkspaceBootstrapResult> {
    const input = normalized(raw)
    const key = `${input.issuer}\u0000${input.externalSubject}`
    const pending = this.inFlight.get(key)
    if (pending) return pending.then(result => ({ ...result, created: false }))
    const operation = this.bootstrapLocked(key, input)
    this.inFlight.set(key, operation)
    try { return await operation } finally { if (this.inFlight.get(key) === operation) this.inFlight.delete(key) }
  }

  private async bootstrapLocked(key: string, input: WorkspaceBootstrapInput): Promise<WorkspaceBootstrapResult> {
    const existing = this.bindings.get(key)
    if (existing) {
      const owner = (await this.members.list(existing.workspaceId)).find(member => member.externalSubject === input.externalSubject && member.role === 'workspace_owner')
      if (this.workspaceStatus(existing.workspaceId) !== 'active' || owner?.status !== 'active' || (input.identityId && owner.identityId && owner.identityId !== input.identityId)) throw new WorkspaceBootstrapError('WORKSPACE_BOOTSTRAP_BINDING_INACTIVE')
      return { ...existing, created: false }
    }
    this.activateWorkspace(input.candidateWorkspaceId)
    const member = await this.members.upsert({ workspaceId: input.candidateWorkspaceId, externalSubject: input.externalSubject, displayName: input.displayName, role: 'workspace_owner', status: 'active', invitedBy: input.actorId })
    if (input.identityId) await this.members.bindIdentity({ workspaceId: input.candidateWorkspaceId, externalSubject: input.externalSubject, identityId: input.identityId })
    const result = { workspaceId: input.candidateWorkspaceId, displayName: input.displayName, created: true }
    this.bindings.set(key, { workspaceId: result.workspaceId, displayName: result.displayName })
    await this.operations.append({ workspaceId: result.workspaceId, actorId: input.actorId, action: 'workspace.bootstrap', resourceType: 'workspace', resourceId: result.workspaceId, before: {}, after: { workspaceId: result.workspaceId, displayName: result.displayName, owner: input.externalSubject, memberId: member.id, status: 'active' }, reason: '首次运行创建工作区' })
    return result
  }
}

type BindingRow = { workspaceId: string; displayName: string }
type StatusRow = { workspaceStatus: string; memberStatus: string; memberRole: string; identityId: string | null }

export class PostgresWorkspaceBootstrapRepository implements WorkspaceBootstrapRepository {
  constructor(private readonly pool: SqlPool) {}

  async bootstrap(raw: WorkspaceBootstrapInput): Promise<WorkspaceBootstrapResult> {
    const input = normalized(raw)
    const client = await this.pool.connect()
    let committed = false
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('app.identity_issuer', $1, true)`, [input.issuer])
      await client.query(`SELECT set_config('app.identity_subject', $1, true)`, [input.externalSubject])
      // Transaction advisory locks are shared by all API processes. The unique
      // key remains the final integrity boundary; the lock avoids loser-created
      // workspace rows and makes the canonical result available in one pass.
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [JSON.stringify(['workspace-bootstrap', input.issuer, input.externalSubject])])

      if (input.identityId) {
        await client.query(`SELECT set_config('app.identity_id', $1, true)`, [input.identityId])
        const identity = await client.query<{ id: string }>(`SELECT id FROM platform_identities WHERE id=$1 AND issuer=$2 AND external_subject=$3`, [input.identityId, input.issuer, input.externalSubject])
        if (!identity.rows[0]) throw new WorkspaceBootstrapError('WORKSPACE_BOOTSTRAP_IDENTITY_MISMATCH')
      }

      const existing = await client.query<BindingRow>(`SELECT workspace_id AS "workspaceId", display_name AS "displayName" FROM workspace_identity_bindings WHERE issuer=$1 AND external_subject=$2 FOR UPDATE`, [input.issuer, input.externalSubject])
      if (existing.rows[0]) {
        const binding = existing.rows[0]
        await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [binding.workspaceId])
        const status = await client.query<StatusRow>(`SELECT workspace.status AS "workspaceStatus", member.status AS "memberStatus", member.role AS "memberRole", member.identity_id AS "identityId" FROM workspaces workspace JOIN workspace_members member ON member.workspace_id=workspace.id AND member.external_subject=$2 WHERE workspace.id=$1`, [binding.workspaceId, input.externalSubject])
        const owner = status.rows[0]
        if (!owner || owner.workspaceStatus !== 'active' || owner.memberStatus !== 'active' || owner.memberRole !== 'workspace_owner' || (input.identityId && owner.identityId !== input.identityId)) throw new WorkspaceBootstrapError('WORKSPACE_BOOTSTRAP_BINDING_INACTIVE')
        await client.query('COMMIT')
        committed = true
        return { workspaceId: binding.workspaceId, displayName: binding.displayName, created: false }
      }

      await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [input.candidateWorkspaceId])
      await client.query(`INSERT INTO workspaces (id, status) VALUES ($1, 'active')`, [input.candidateWorkspaceId])
      const memberId = randomUUID()
      await client.query(`INSERT INTO workspace_members (id, workspace_id, external_subject, display_name, role, status, invited_by, identity_id) VALUES ($1,$2,$3,$4,'workspace_owner','active',$5,$6)`, [memberId, input.candidateWorkspaceId, input.externalSubject, input.displayName, input.actorId, input.identityId ?? null])
      await client.query(`INSERT INTO workspace_identity_bindings (issuer, external_subject, identity_id, workspace_id, display_name) VALUES ($1,$2,$3,$4,$5)`, [input.issuer, input.externalSubject, input.identityId ?? null, input.candidateWorkspaceId, input.displayName])
      await client.query(`INSERT INTO workspace_operation_audit (id, workspace_id, actor_id, action, resource_type, resource_id, before_json, after_json, reason) VALUES ($1,$2,$3,'workspace.bootstrap','workspace',$2,'{}'::jsonb,$4,'首次运行创建工作区')`, [randomUUID(), input.candidateWorkspaceId, input.actorId, { workspaceId: input.candidateWorkspaceId, displayName: input.displayName, owner: input.externalSubject, memberId, status: 'active' }])
      await client.query('COMMIT')
      committed = true
      return { workspaceId: input.candidateWorkspaceId, displayName: input.displayName, created: true }
    } catch (error) {
      if (!committed) try { await client.query('ROLLBACK') } catch { /* preserve original error */ }
      throw error
    } finally { client.release?.() }
  }
}
