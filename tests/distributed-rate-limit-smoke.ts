/** Cross-replica Redis rate-limit smoke. Both API replicas must use the same REDIS_URL. */
const aUrl = (process.env.RATE_LIMIT_REPLICA_A_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '')
const bUrl = (process.env.RATE_LIMIT_REPLICA_B_URL ?? 'http://127.0.0.1:8788').replace(/\/$/, '')
let workspaceId = process.env.RATE_LIMIT_WORKSPACE_ID?.trim() ?? ''
const token = process.env.RATE_LIMIT_API_TOKEN ?? 'pilot-local-token'

async function bootstrapWorkspace() {
  const response = await fetch(`${aUrl}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-workspace-bootstrap': 'true' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'workspace.bootstrap', params: { display_name: 'Distributed rate-limit smoke' } }),
  })
  const envelope = await response.json() as { data?: { result?: { workspaceId?: string } }; error?: { code?: string; message?: string } | null }
  if (!response.ok || !envelope.data?.result?.workspaceId) throw new Error(`[distributed-rate-limit] workspace bootstrap failed: ${envelope.error?.code ?? response.status} ${envelope.error?.message ?? ''}`)
  workspaceId = envelope.data.result.workspaceId
}

async function probe(base: string) {
  try {
    const response = await fetch(`${base}/v1/platform-accounts`, { headers: { authorization: `Bearer ${token}`, 'x-workspace-id': workspaceId } })
    return response.status
  } catch (error) {
    throw new Error(`[distributed-rate-limit] replica unavailable: ${base} (${error instanceof Error ? error.message : String(error)})`)
  }
}

async function main() {
  if (!workspaceId) await bootstrapWorkspace()
  const first = await probe(aUrl)
  const second = await probe(bUrl)
  const third = await probe(aUrl)
  if (![first, second, third].every(status => [200, 429].includes(status)) || third !== 429) {
    throw new Error(`[distributed-rate-limit] expected 200,200,429; got ${first},${second},${third}`)
  }
  console.log(JSON.stringify({ status: 'PASS', workspaceId, statuses: [first, second, third], replicas: [aUrl, bUrl] }, null, 2))
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
