/** Cross-replica Redis rate-limit smoke. Both API replicas must use the same REDIS_URL. */
const aUrl = (process.env.RATE_LIMIT_REPLICA_A_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '')
const replicaB = process.env.RATE_LIMIT_REPLICA_B_URL?.trim()
if (!replicaB) throw new Error('RATE_LIMIT_REPLICA_B_URL is required; provide the second API replica URL')
const bUrl = replicaB.replace(/\/$/, '')
const workspaceId = process.env.RATE_LIMIT_WORKSPACE_ID ?? `ws_rate_replica_${Date.now()}`
const token = process.env.RATE_LIMIT_API_TOKEN ?? 'pilot-local-token'

async function probe(base: string) {
  try {
    const response = await fetch(`${base}/v1/products`, { headers: { authorization: `Bearer ${token}`, 'x-workspace-id': workspaceId } })
    return response.status
  } catch (error) {
    throw new Error(`[distributed-rate-limit] replica unavailable: ${base} (${error instanceof Error ? error.message : String(error)})`)
  }
}

async function main() {
  const first = await probe(aUrl)
  const second = await probe(bUrl)
  const third = await probe(aUrl)
  if (![first, second, third].every(status => [200, 429].includes(status)) || third !== 429) {
    throw new Error(`[distributed-rate-limit] expected 200,200,429; got ${first},${second},${third}`)
  }
  console.log(JSON.stringify({ status: 'PASS', workspaceId, statuses: [first, second, third], replicas: [aUrl, bUrl] }, null, 2))
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
