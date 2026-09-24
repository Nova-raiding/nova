import { requireWorkspaceScope, type SqlPool, withWorkspaceTransaction } from './repository.js'

export interface DemoEvaluationEntitlementRow {
  id: string
  workspaceId: string
  startsAt: string
  expiresAt: string
  createdAt: string
  checksum: string
  status: 'active' | 'revoked'
}

function instant(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.valueOf())) throw new Error('invalid demo evaluation timestamp')
  return date.toISOString()
}

/** Read only. Grant insertion is restricted to the privileged first-install tool. */
export class PostgresDemoEvaluationEntitlementRepository {
  constructor(private readonly pool: SqlPool) {}

  async listDemoEvaluationEntitlements(input: { workspace_id: string }): Promise<DemoEvaluationEntitlementRow[]> {
    const workspaceId = requireWorkspaceScope(input.workspace_id)
    if (workspaceId !== 'ws_guirenniaoniao') return []
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const rows = await client.query<{
        id: string; workspaceId: string; startsAt: Date | string; expiresAt: Date | string;
        createdAt: Date | string; checksum: string; status: 'active' | 'revoked'
      }>(`SELECT id, workspace_id AS "workspaceId", starts_at AS "startsAt",
                  expires_at AS "expiresAt", created_at AS "createdAt", checksum, status
             FROM demo_evaluation_entitlements WHERE workspace_id = $1`, [workspaceId])
      return rows.rows.map(row => ({ ...row, startsAt: instant(row.startsAt), expiresAt: instant(row.expiresAt), createdAt: instant(row.createdAt) }))
    })
  }
}
