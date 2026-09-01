import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { Pool } from 'pg'
import { loadMigrations, PostgresOutboxRepository, withWorkspaceTransaction } from '../packages/persistence/src/index.js'

const compose = ['compose', '-f', 'infra/local/docker-compose.yml']
const apiBase = process.env.COMPOSE_API_URL ?? 'http://127.0.0.1:8787'
const opsUiBase = process.env.COMPOSE_OPS_UI_URL ?? 'http://127.0.0.1:18082'
const workspaceCount = Number(process.env.COMPOSE_WORKSPACES ?? 50)

function docker(args: string[]) {
  return execFileSync('docker', [...compose, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function dockerRaw(args: string[]) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function assertRunning(service: string) {
  const running = docker(['ps', '--services', '--filter', 'status=running']).split(/\s+/).filter(Boolean)
  assert.ok(running.includes(service), `${service} must be running in Compose acceptance`)
}

async function assertHealthy(service: string) {
  const containerId = docker(['ps', '-q', service])
  assert.ok(containerId, `${service} container must have an id`)
  const deadline = Date.now() + 30_000
  let health = 'unknown'
  while (Date.now() < deadline) {
    health = execFileSync('docker', ['inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', containerId], { encoding: 'utf8' }).trim()
    if (health === 'healthy') return
    if (health === 'unhealthy' || health === 'none') break
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
  assert.equal(health, 'healthy', `${service} must be healthy, got ${health}`)
}

async function waitForHealth() {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiBase}/healthz`)
      if (response.status === 200) return await response.json() as { data: { persistence?: { mode?: string; ready?: boolean } } }
    } catch { /* container is still starting */ }
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
  throw new Error('Compose API did not become healthy within 60 seconds')
}

async function assertIndependentOpsUi() {
  const response = await fetch(opsUiBase)
  const html = await response.text()
  assert.equal(response.status, 200, `Ops UI returned ${response.status}`)
  assert.match(html, /<title>Merchant Operations Console<\/title>/, 'port 18082 must serve the Ops Console')
  assert.doesNotMatch(html, /Merchant Studio · 商家营销工作台/, 'port 18082 must not serve Merchant Studio')
  const apiResponse = await fetch(`${opsUiBase}/api/healthz`)
  assert.equal(apiResponse.status, 200, `Ops UI same-origin API proxy returned ${apiResponse.status}`)
}

async function request(path: string, workspaceId: string, init?: RequestInit) {
  const headers = new Headers(init?.headers)
  headers.set('x-workspace-id', workspaceId)
  headers.set('x-ops-workbench', 'workspace')
  headers.set('authorization', `Bearer ${process.env.COMPOSE_API_TOKEN ?? 'workspace-local-token'}`)
  const response = await fetch(`${apiBase}${path}`, { ...init, headers })
  const body = await response.json() as { workspace_id: string; data: unknown; error: unknown }
  assert.ok([200, 201, 202].includes(response.status), `${path} returned ${response.status}`)
  assert.equal(body.workspace_id, workspaceId)
  assert.equal(body.error, null)
  return body.data
}

async function bootstrapWorkspace(index: number) {
  const response = await fetch(`${apiBase}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.COMPOSE_API_TOKEN ?? 'workspace-local-token'}`, 'content-type': 'application/json', 'x-ops-workbench': 'workspace', 'x-workspace-bootstrap': 'true' },
    body: JSON.stringify({ jsonrpc: '2.0', id: index + 1, method: 'workspace.bootstrap', params: { display_name: `Compose smoke ${index}` } }),
  })
  const body = await response.json() as { data?: { result?: { workspaceId?: string } }; error?: { code?: string; message?: string } | null }
  assert.equal(response.status, 200, `workspace.bootstrap returned ${response.status}: ${body.error?.code ?? body.error?.message ?? 'unknown error'}`)
  const workspaceId = body.data?.result?.workspaceId
  assert.ok(workspaceId, 'workspace.bootstrap must return a workspace id')
  return workspaceId
}

async function postgres() {
  const pool = new Pool({ connectionString: process.env.COMPOSE_DATABASE_URL ?? 'postgres://merchant:merchant_local_only@127.0.0.1:54329/merchant' })
  return { pool, outbox: new PostgresOutboxRepository(pool) }
}

export async function runComposeAcceptance() {
  const expectedMigrationVersions = (await loadMigrations()).map(migration => migration.version)
  const health = await waitForHealth()
  assert.equal(health.data.persistence?.mode, 'postgres')
  assert.equal(health.data.persistence?.ready, true)
  for (const service of ['api', 'worker-sync', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-automation', 'worker-scan', 'clamav', 'postgres', 'redis', 'ui', 'ops-ui']) {
    assertRunning(service)
    await assertHealthy(service)
  }
  await assertIndependentOpsUi()

  // Exercise the real first-run ownership path before reading each isolated
  // workspace. Directly inventing ids would correctly fail membership checks.
  const smokeWorkspaceIds = await Promise.all(Array.from({ length: workspaceCount }, (_, index) => bootstrapWorkspace(index)))
  const workspaceResults = await Promise.all(smokeWorkspaceIds.map(workspaceId => request('/v1/platform-accounts', workspaceId)))
  assert.equal(workspaceResults.length, workspaceCount)

  const beforeRestart = docker(['ps', '-q', 'postgres'])
  assert.ok(beforeRestart, 'postgres container must be running')
  // Re-running the versioned migration service is the restart/idempotency gate.
  // The database is already healthy and the migration container is a
  // one-shot job; avoid Compose recreating dependency services during this
  // idempotency check.
  docker(['run', '--rm', '--no-deps', 'migrate'])
  const apiContainer = docker(['ps', '-q', 'api'])
  assert.ok(apiContainer, 'api container must be running before restart')
  dockerRaw(['restart', '--time=5', apiContainer])
  await waitForHealth()

  const { pool, outbox } = await postgres()
  try {
    const migrationRows = await pool.query<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version')
    assert.deepEqual(migrationRows.rows.map(row => Number(row.version)), expectedMigrationVersions)
    const businessTables = await withWorkspaceTransaction(pool, 'ws_demo', async client => {
      const result = await client.query<{ relname: string }>(
        `SELECT relname FROM pg_class WHERE relname IN ('products', 'tasks', 'content_versions', 'publish_jobs', 'generation_jobs', 'business_entity_snapshots', 'task_feedback') ORDER BY relname`,
      )
      return result.rows.map(row => row.relname)
    })
    assert.deepEqual(businessTables, ['business_entity_snapshots', 'content_versions', 'generation_jobs', 'products', 'publish_jobs', 'task_feedback', 'tasks'])

    const accountDirectory = await request('/v1/platform-accounts', 'ws_demo') as { items: Array<{ platform?: string; accountId?: string }> }
    const taobaoAccount = accountDirectory.items.find(item => item.platform === 'taobao' && item.accountId)
    assert.ok(taobaoAccount?.accountId, 'ws_demo must have a provisioned Taobao account for production Compose acceptance')
    const accountId = taobaoAccount.accountId
    await request('/v1/products/import', 'ws_demo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ platform: 'taobao', account_id: accountId, remote_id: 'TB-COMPOSE-1', title: 'Compose 验收商品', sku_count: 1, stock: 10 }) })
    await request('/v1/products/prod_taobao_TB-COMPOSE-1/confirm', 'ws_demo', { method: 'POST' })
    const task = await request('/v1/tasks', 'ws_demo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ product_id: 'prod_taobao_TB-COMPOSE-1', platform: 'taobao', account_id: accountId }) }) as { id: string }
    const feedback = await request(`/v1/tasks/${task.id}/feedback`, 'ws_demo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rating: 'liked', reason: 'compose feedback' }) }) as { id: string; taskId: string; rating: string }
    assert.equal(feedback.taskId, task.id)
    assert.equal(feedback.rating, 'liked')
    const currentApiContainer = docker(['ps', '-q', 'api'])
    assert.ok(currentApiContainer, 'api container must be running before recovery restart')
    dockerRaw(['restart', '--time=5', currentApiContainer])
    await waitForHealth()
    const recoveredTask = await request(`/v1/tasks/${task.id}`, 'ws_demo') as { id: string; state: string }
    assert.equal(recoveredTask.id, task.id, 'task snapshot must survive API restart')
    assert.equal(recoveredTask.state, 'ready_for_direction')
    const recoveredFeedback = await request(`/v1/tasks/${task.id}/feedback`, 'ws_demo') as Array<{ id: string }>
    assert.ok(recoveredFeedback.some(item => item.id === feedback.id), 'feedback snapshot must survive API restart')
    const recoveredTimeline = await request(`/v1/tasks/${task.id}/timeline?limit=200`, 'ws_demo') as Array<{ event_type: string }>
    assert.ok(recoveredTimeline.some(item => item.event_type === 'task.created'), 'task creation event must survive API restart')
    assert.ok(recoveredTimeline.some(item => item.event_type === 'task_feedback_submitted'), 'feedback event must survive API restart')
    const events = await withWorkspaceTransaction(pool, 'ws_demo', async client => {
      const result = await client.query<{ id: string; aggregate_id: string; published_at: string | Date | null }>('SELECT id, aggregate_id, published_at FROM outbox_events WHERE workspace_id = $1 AND aggregate_id = $2 ORDER BY created_at ASC', ['ws_demo', task.id])
      return result.rows
    })
    const durableTask = await withWorkspaceTransaction(pool, 'ws_demo', async client => {
      const result = await client.query<{ entity_id: string; entity_version: number; payload: Record<string, unknown> }>(
        'SELECT entity_id, entity_version, payload FROM business_entity_snapshots WHERE workspace_id = $1 AND entity_type = $2 AND entity_id = $3',
        ['ws_demo', 'task', task.id],
      )
      return result.rows[0]
    })
    assert.equal(durableTask?.entity_id, task.id, 'task must be stored in the durable business snapshot table')
    assert.equal(Number(durableTask?.entity_version), 1, 'task snapshot version must be persisted')
    const projectedRows = await withWorkspaceTransaction(pool, 'ws_demo', async client => {
      const result = await client.query<{ products: number; tasks: number; feedback: number }>(
        `SELECT
           (SELECT count(*) FROM products WHERE workspace_id = $1 AND id = $2)::int AS products,
           (SELECT count(*) FROM tasks WHERE workspace_id = $1 AND id = $3)::int AS tasks,
           (SELECT count(*) FROM task_feedback WHERE workspace_id = $1 AND id = $4)::int AS feedback`,
        ['ws_demo', 'prod_taobao_TB-COMPOSE-1', task.id, feedback.id],
      )
      return result.rows[0]
    })
    assert.equal(Number(projectedRows?.products), 1, 'product must be projected into normalized PostgreSQL table')
    assert.equal(Number(projectedRows?.tasks), 1, 'task must be projected into normalized PostgreSQL table')
    assert.equal(Number(projectedRows?.feedback), 1, 'feedback must be projected into normalized PostgreSQL table')
    const event = events[0]
    assert.ok(event, 'task event must be durable in the Postgres outbox')
    const published = await outbox.markPublished('ws_demo', event.id, new Date().toISOString())
    const replayed = await outbox.markPublished('ws_demo', event.id, new Date(Date.now() + 1_000).toISOString())
    assert.ok(published.publishedAt)
    assert.equal(replayed.publishedAt, published.publishedAt, 'outbox replay must be idempotent')
    assert.equal((await outbox.pending('ws_demo')).some(candidate => candidate.id === event.id), false)
  } finally {
    await pool.end()
  }

  return { profile: 'pilot_50_compose_postgres', transport: 'real_http', persistence: 'real_compose_postgres', workspaces: workspaceCount, migrationRestart: 'passed', outboxReplay: 'passed', cloudGate: false }
}

if (process.argv[1]?.endsWith('/compose-acceptance.ts')) console.log(JSON.stringify(await runComposeAcceptance()))
