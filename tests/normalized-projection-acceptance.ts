import assert from 'node:assert/strict'
import { Pool } from 'pg'
import { PostgresBusinessRepository, withWorkspaceTransaction } from '../packages/persistence/src/index.js'

const databaseUrl = process.env.COMPOSE_DATABASE_URL ?? 'postgres://merchant:merchant_local_only@127.0.0.1:54329/merchant'
const workspaceId = `ws_projection_${Date.now()}`
const productId = `projection_product_${Date.now()}`
const taskId = `projection_task_${Date.now()}`
const firstVersionId = `projection_cv_1_${Date.now()}`
const secondVersionId = `projection_cv_2_${Date.now()}`

const pool = new Pool({ connectionString: databaseUrl })
const repository = new PostgresBusinessRepository(pool, { normalizedProjection: true })

async function ensureWorkspace() {
  await pool.query("INSERT INTO workspaces (id, status) VALUES ($1, 'active') ON CONFLICT (id) DO NOTHING", [workspaceId])
}

async function save(entityType: 'product' | 'task' | 'content_version', entityId: string, entityVersion: number, payload: Record<string, unknown>) {
  return repository.save({ workspaceId, entityType, entityId, entityVersion, payload })
}

try {
  await ensureWorkspace()
  await save('product', productId, 1, {
    id: productId, workspaceId, platform: 'taobao', storeName: 'projection', remoteId: `remote-${productId}`,
    title: '规范化投影验收商品', skuCount: 1, stock: 10, factsConfirmed: true, source: 'csv', version: 1,
  })
  await save('task', taskId, 1, {
    id: taskId, workspaceId, productId, platform: 'taobao', state: 'ready_for_direction', version: 1,
  })
  await save('content_version', firstVersionId, 1, {
    id: firstVersionId, taskId, version: 1, body: { title: 'v1', detail: 'detail', sellingPoints: ['point'] },
    factVersionIds: [], ruleVersionIds: [], state: 'review_required', createdBy: 'acceptance',
  })
  await save('task', taskId, 2, {
    id: taskId, workspaceId, productId, platform: 'taobao', state: 'review_required', contentVersionId: firstVersionId, version: 2,
  })
  await save('content_version', firstVersionId, 2, {
    id: firstVersionId, taskId, version: 1, body: { title: 'v1 approved', detail: 'detail', sellingPoints: ['point'] },
    factVersionIds: [], ruleVersionIds: [], state: 'approved', createdBy: 'acceptance',
  })
  await save('content_version', secondVersionId, 1, {
    id: secondVersionId, taskId, parentId: firstVersionId, version: 2,
    body: { title: 'v2', detail: 'detail 2', sellingPoints: ['point 2'] }, factVersionIds: [], ruleVersionIds: [],
    state: 'review_required', createdBy: 'acceptance',
  })
  await save('task', taskId, 3, {
    id: taskId, workspaceId, productId, platform: 'taobao', state: 'review_required', contentVersionId: secondVersionId, version: 3,
  })

  const rows = await withWorkspaceTransaction(pool, workspaceId, async client => {
    const result = await client.query<{ version: number; state: string; task_version: number }>(
      `SELECT cv.version, cv.state, t.version AS task_version
         FROM content_versions cv
         JOIN tasks t ON t.workspace_id = cv.workspace_id AND t.id = cv.task_id
        WHERE cv.workspace_id = $1 AND cv.task_id = $2
        ORDER BY cv.version`, [workspaceId, taskId],
    )
    return result.rows
  })
  assert.deepEqual(rows.map(row => Number(row.version)), [1, 2])
  assert.equal(rows[0]?.state, 'approved')
  assert.equal(Number(rows[0]?.task_version), 3)
  console.log(JSON.stringify({ profile: 'normalized_projection', workspaceId, taskId, versions: rows.map(row => Number(row.version)), status: 'pass' }))
} finally {
  await pool.end()
}
