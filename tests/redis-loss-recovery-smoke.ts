import { execFileSync } from 'node:child_process'
import { Pool } from 'pg'

const compose = ['compose', '-f', 'infra/local/docker-compose.yml']
const api = 'http://127.0.0.1:8787'
const accountId = process.env.REDIS_RECOVERY_ACCOUNT_ID?.trim()
if (!accountId) throw new Error('REDIS_RECOVERY_ACCOUNT_ID is required; provision a bound Taobao account first')
const workspaceId = process.env.REDIS_RECOVERY_WORKSPACE_ID?.trim() || 'ws_redis_recovery'
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(workspaceId)) throw new Error('REDIS_RECOVERY_WORKSPACE_ID is invalid')
const workerServices = ['worker-sync', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-automation']
const headers = { accept: 'application/json', 'content-type': 'application/json', authorization: 'Bearer pilot-local-token', 'x-workspace-id': workspaceId }

function docker(args: string[]) { execFileSync('docker', [...compose, ...args], { stdio: 'ignore' }) }
const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))
async function request(path: string, init: RequestInit) {
  const response = await fetch(`${api}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } })
  const envelope = await response.json() as { data: any; error: unknown }
  if (!response.ok || envelope.error) throw new Error(`${path} failed: ${response.status}`)
  return envelope.data
}

async function main() {
  try {
    docker(['stop', ...workerServices])
    const product = await request('/v1/products/import', { method: 'POST', body: JSON.stringify({ platform: 'taobao', account_id: accountId, remote_id: `REDIS-RECOVERY-${Date.now()}`, title: 'Redis 恢复验收商品', sku_count: 1, stock: 1 }) })
    // Put the outbox event in PostgreSQL, then actually take Redis down before
    // starting the worker. The worker's restart policy must bring it back once
    // Redis becomes reachable; restarting a healthy Redis would test nothing.
    docker(['stop', 'redis'])
    docker(['start', 'worker-sync'])
    await sleep(2_000)
    docker(['start', 'redis'])
    const pool = new Pool({ connectionString: process.env.COMPOSE_DATABASE_URL ?? 'postgres://merchant:merchant_local_only@127.0.0.1:54329/merchant' })
    let published = false
    try {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const result = await pool.query<{ published_at: string | null }>(
          `SELECT published_at FROM outbox_events WHERE workspace_id = $1 AND aggregate_id = $2 AND event_type = 'state.snapshot' ORDER BY sequence DESC LIMIT 1`,
          [workspaceId, product.id],
        )
        published = Boolean(result.rows[0]?.published_at)
        if (published) break
        await new Promise(resolve => setTimeout(resolve, 250))
      }
    } finally { await pool.end() }
    if (!published) throw new Error('outbox event was not recovered after Redis restart')
    console.log(JSON.stringify({ profile: 'redis_loss_outbox_recovery', aggregateId: product.id, redisRestarted: true, outboxReplayed: true, cloudGate: false, status: 'pass' }))
  } finally {
    docker(['up', '-d', ...workerServices])
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
