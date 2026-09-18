import { randomUUID } from 'node:crypto'
import type { OperationsRepository } from './operations-repository.js'
import { requireWorkspaceScope, type SqlPool, withWorkspaceTransaction } from './repository.js'

export interface WorkspaceContentSetup {
  workspaceId: string
  displayName: string
  platform: string
  accountId: string
  actorId: string
  confirmedAt: string
}

export interface WorkspaceContentSetupRepository {
  get(workspaceId: string): Promise<WorkspaceContentSetup | undefined>
  confirm(input: Omit<WorkspaceContentSetup, 'confirmedAt'>): Promise<WorkspaceContentSetup>
}

export class MemoryWorkspaceContentSetupRepository implements WorkspaceContentSetupRepository {
  private readonly rows = new Map<string, WorkspaceContentSetup>()
  constructor(private readonly operations: OperationsRepository) {}
  async get(workspaceId: string) { return this.rows.get(workspaceId) }
  async confirm(input: Omit<WorkspaceContentSetup, 'confirmedAt'>) {
    const before = this.rows.get(input.workspaceId)
    const row = { ...input, confirmedAt: new Date().toISOString() }
    await this.operations.append({ workspaceId: input.workspaceId, actorId: input.actorId, action: 'workspace.content_setup.confirm', resourceType: 'workspace', resourceId: input.workspaceId, before: before ? { ...before } : {}, after: { ...row }, reason: '商家确认首次内容工作区名称及店铺范围' })
    this.rows.set(input.workspaceId, row)
    return row
  }
}

type SetupRow = Omit<WorkspaceContentSetup, 'confirmedAt'> & { confirmedAt: Date | string }
function fromRow(row: SetupRow): WorkspaceContentSetup {
  return { ...row, confirmedAt: new Date(row.confirmedAt).toISOString() }
}

export class PostgresWorkspaceContentSetupRepository implements WorkspaceContentSetupRepository {
  constructor(private readonly pool: SqlPool) {}
  async get(workspaceId: string) {
    requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const found = await client.query<SetupRow>(`SELECT workspace_id AS "workspaceId", display_name AS "displayName", platform, account_id AS "accountId", actor_id AS "actorId", confirmed_at AS "confirmedAt" FROM workspace_content_setup WHERE workspace_id=$1`, [workspaceId])
      return found.rows[0] ? fromRow(found.rows[0]) : undefined
    })
  }
  async confirm(input: Omit<WorkspaceContentSetup, 'confirmedAt'>) {
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const previous = await client.query<SetupRow>(`SELECT workspace_id AS "workspaceId", display_name AS "displayName", platform, account_id AS "accountId", actor_id AS "actorId", confirmed_at AS "confirmedAt" FROM workspace_content_setup WHERE workspace_id=$1 FOR UPDATE`, [input.workspaceId])
      const saved = await client.query<SetupRow>(`INSERT INTO workspace_content_setup (workspace_id, display_name, platform, account_id, actor_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (workspace_id) DO UPDATE SET display_name=EXCLUDED.display_name, platform=EXCLUDED.platform, account_id=EXCLUDED.account_id, actor_id=EXCLUDED.actor_id, confirmed_at=now() RETURNING workspace_id AS "workspaceId", display_name AS "displayName", platform, account_id AS "accountId", actor_id AS "actorId", confirmed_at AS "confirmedAt"`, [input.workspaceId, input.displayName, input.platform, input.accountId, input.actorId])
      const row = fromRow(saved.rows[0]!)
      await client.query(`INSERT INTO workspace_operation_audit (id, workspace_id, actor_id, action, resource_type, resource_id, before_json, after_json, reason) VALUES ($1,$2,$3,'workspace.content_setup.confirm','workspace',$2,$4,$5,'商家确认首次内容工作区名称及店铺范围')`, [randomUUID(), input.workspaceId, input.actorId, previous.rows[0] ? { ...fromRow(previous.rows[0]) } : {}, { ...row }])
      return row
    })
  }
}
