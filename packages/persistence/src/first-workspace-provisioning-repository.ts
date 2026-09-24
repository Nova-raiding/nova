import { randomUUID } from 'node:crypto'
import type { SqlPool } from './repository.js'

export interface FirstWorkspaceProvisionInput {
  platformActorIdentityId: string
  workspaceId: string
  ownerIdentityId: string
  ownerIssuer: string
  ownerSubject: string
  ownerDisplayName: string
  reason: string
}

export class FirstWorkspaceProvisionError extends Error {
  constructor(readonly code: 'INVALID_PROVISION_REQUEST' | 'PLATFORM_ACTOR_FORBIDDEN' | 'OWNER_IDENTITY_INACTIVE' | 'WORKSPACE_PROVISION_CONFLICT') {
    super(code)
  }
}

/** Run only with a deliberately provisioned database role able to read platform identities
 * and write tenant rows. The role's SQL privileges are an additional deployment gate. */
export class PostgresFirstWorkspaceProvisioningRepository {
  constructor(private readonly pool: SqlPool) {}

  async provision(raw: FirstWorkspaceProvisionInput): Promise<{ workspaceId: string; created: boolean }> {
    const input = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, value.trim()])) as unknown as FirstWorkspaceProvisionInput
    if (!/^ws_[a-zA-Z0-9_]{3,120}$/.test(input.workspaceId) || !/^[0-9a-f-]{36}$/i.test(input.platformActorIdentityId)
      || !/^[0-9a-f-]{36}$/i.test(input.ownerIdentityId) || !input.ownerIssuer || !input.ownerSubject
      || !input.ownerDisplayName || input.ownerDisplayName.length > 120 || input.reason.length < 3 || input.reason.length > 2000)
      throw new FirstWorkspaceProvisionError('INVALID_PROVISION_REQUEST')

    const client = await this.pool.connect()
    let committed = false
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('app.platform_scope', 'platform_ops', true)`)
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [JSON.stringify(['first-workspace', input.ownerIssuer, input.ownerSubject])])
      const actor = await client.query<{ id: string }>(`SELECT identity.id FROM platform_identities identity JOIN platform_role_assignments role ON role.subject_identity_id=identity.id WHERE identity.id=$1 AND identity.access_status='active' AND identity.risk_decision='allow' AND role.role IN ('platform_owner','platform_admin') AND role.revoked_at IS NULL AND role.valid_from<=now() AND (role.expires_at IS NULL OR role.expires_at>now()) LIMIT 1`, [input.platformActorIdentityId])
      if (!actor.rows[0]) throw new FirstWorkspaceProvisionError('PLATFORM_ACTOR_FORBIDDEN')
      const owner = await client.query<{ id: string }>(`SELECT id FROM platform_identities WHERE id=$1 AND issuer=$2 AND external_subject=$3 AND access_status='active' AND risk_decision='allow'`, [input.ownerIdentityId, input.ownerIssuer, input.ownerSubject])
      if (!owner.rows[0]) throw new FirstWorkspaceProvisionError('OWNER_IDENTITY_INACTIVE')
      const existing = await client.query<{ workspace_id: string; identity_id: string; status: string; role: string; workspace_status: string }>(`SELECT binding.workspace_id, binding.identity_id, member.status, member.role, workspace.status AS workspace_status FROM workspace_identity_bindings binding JOIN workspace_members member ON member.workspace_id=binding.workspace_id AND member.external_subject=binding.external_subject JOIN workspaces workspace ON workspace.id=binding.workspace_id WHERE binding.issuer=$1 AND binding.external_subject=$2 FOR UPDATE OF binding`, [input.ownerIssuer, input.ownerSubject])
      if (existing.rows[0]) {
        const row = existing.rows[0]
        if (row.workspace_id !== input.workspaceId || row.identity_id !== input.ownerIdentityId || row.role !== 'workspace_owner' || row.status !== 'active' || row.workspace_status !== 'active') throw new FirstWorkspaceProvisionError('WORKSPACE_PROVISION_CONFLICT')
        await client.query('COMMIT')
        committed = true
        return { workspaceId: input.workspaceId, created: false }
      }
      const occupied = await client.query<{ id: string }>(`SELECT id FROM workspaces WHERE id=$1`, [input.workspaceId])
      const bound = await client.query<{ workspace_id: string }>(`SELECT workspace_id FROM workspace_identity_bindings WHERE identity_id=$1`, [input.ownerIdentityId])
      if (occupied.rows[0] || bound.rows[0]) throw new FirstWorkspaceProvisionError('WORKSPACE_PROVISION_CONFLICT')
      await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [input.workspaceId])
      await client.query(`INSERT INTO workspaces (id,status) VALUES ($1,'active')`, [input.workspaceId])
      const memberId = randomUUID()
      await client.query(`INSERT INTO workspace_members (id,workspace_id,external_subject,display_name,role,status,invited_by,identity_id) VALUES ($1,$2,$3,$4,'workspace_owner','active',$5,$6)`, [memberId, input.workspaceId, input.ownerSubject, input.ownerDisplayName, input.platformActorIdentityId, input.ownerIdentityId])
      await client.query(`INSERT INTO workspace_identity_bindings (issuer,external_subject,identity_id,workspace_id,display_name) VALUES ($1,$2,$3,$4,$5)`, [input.ownerIssuer, input.ownerSubject, input.ownerIdentityId, input.workspaceId, input.ownerDisplayName])
      await client.query(`INSERT INTO workspace_operation_audit (id,workspace_id,actor_id,action,resource_type,resource_id,before_json,after_json,reason) VALUES ($1,$2,$3,'workspace.provision.first','workspace',$2,'{}'::jsonb,$4,$5)`, [randomUUID(), input.workspaceId, input.platformActorIdentityId, { ownerIdentityId: input.ownerIdentityId, ownerIssuer: input.ownerIssuer, ownerSubject: input.ownerSubject, memberId, status: 'active' }, input.reason])
      await client.query('COMMIT')
      committed = true
      return { workspaceId: input.workspaceId, created: true }
    } catch (error) {
      if (!committed) try { await client.query('ROLLBACK') } catch { /* preserve original error */ }
      if ((error as { code?: string }).code === '23505') throw new FirstWorkspaceProvisionError('WORKSPACE_PROVISION_CONFLICT')
      throw error
    } finally { client.release?.() }
  }
}
