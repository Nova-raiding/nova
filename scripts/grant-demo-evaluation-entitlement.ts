import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'

const workspaceId = 'ws_guirenniaoniao'
if (process.env.DEPLOYMENT_PROFILE !== 'ecs' || process.env.DEMO_EVALUATION_ENTITLEMENT_ENABLED !== 'true') {
  throw new Error('explicit ECS demo evaluation flag is required')
}
const databaseUrl = process.env.FIRST_INSTALL_ADMIN_DATABASE_URL?.trim()
const actorId = process.env.DEMO_EVALUATION_ACTOR_ID?.trim()
const reason = process.env.DEMO_EVALUATION_REASON?.trim()
if (!databaseUrl || !actorId || !reason) throw new Error('admin database URL, actor ID and reason are required')
if (actorId.length > 255 || reason.length > 1000) throw new Error('audit fields are too long')

const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 })
const client = await pool.connect()
try {
  await client.query('BEGIN')
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['demo-evaluation:ws_guirenniaoniao'])
  const workspace = await client.query('SELECT id FROM workspaces WHERE id=$1', [workspaceId])
  if (workspace.rowCount !== 1) throw new Error('first-install workspace does not exist')
  const existing = await client.query<{ id: string; expires_at: Date; checksum: string }>(
    'SELECT id, expires_at, checksum FROM demo_evaluation_entitlements WHERE workspace_id=$1 AND status=$2',
    [workspaceId, 'active'],
  )
  if (existing.rowCount) {
    await client.query('COMMIT')
    console.log(JSON.stringify({ workspace_id: workspaceId, entitlement_id: existing.rows[0]!.id, expires_at: existing.rows[0]!.expires_at.toISOString(), replayed: true }))
  } else {
    const startsAt = new Date()
    const expiresAt = new Date(startsAt.valueOf() + 7 * 24 * 60 * 60 * 1000)
    const id = `dee_${randomUUID()}`
    const checksum = createHash('sha256').update(JSON.stringify({ id, workspaceId, startsAt: startsAt.toISOString(), expiresAt: expiresAt.toISOString(), actorId, reason, kind: 'demo_evaluation_v1' })).digest('hex')
    await client.query(
      `INSERT INTO demo_evaluation_entitlements (id,workspace_id,starts_at,expires_at,actor_id,reason,checksum)
       VALUES ($1,$2,$3::timestamptz,$4::timestamptz,$5,$6,$7)`,
      [id, workspaceId, startsAt.toISOString(), expiresAt.toISOString(), actorId, reason, checksum],
    )
    await client.query('COMMIT')
    console.log(JSON.stringify({ workspace_id: workspaceId, entitlement_id: id, expires_at: expiresAt.toISOString(), replayed: false }))
  }
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined)
  throw error
} finally {
  client.release()
  await pool.end()
}
