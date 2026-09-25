import { withWorkspaceTransaction, type SqlPool } from '../../../packages/persistence/src/index.js'

/** Read a workspace status inside the tenant-scoped transaction. */
export async function readWorkspaceStatusInTransaction(pool: SqlPool, workspaceId: string): Promise<'active' | 'disabled'> {
  return withWorkspaceTransaction(pool, workspaceId, async client => {
    const row = await client.query<{ status: 'active' | 'disabled' }>('SELECT status FROM workspaces WHERE id = $1', [workspaceId])
    return row.rows[0]?.status ?? 'active'
  })
}
