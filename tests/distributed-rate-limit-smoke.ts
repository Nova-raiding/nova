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
  if (!response.ok || !envelope.data?.result?.workspaceId) {
    // Bootstrapping is a precondition of this smoke, not the property under
    // test, and the two ways to satisfy it are not discoverable from a bare
    // `INTERNAL_ERROR`. Name both, and name the observed blocker so an
    // operator does not read it as a rate-limit regression.
    throw new Error([
      `[distributed-rate-limit] workspace bootstrap failed: ${envelope.error?.code ?? response.status} ${envelope.error?.message ?? ''}`,
      `Provide RATE_LIMIT_WORKSPACE_ID=<existing workspace> to skip the bootstrap, or make ${aUrl}/mcp work.`,
      'A `permission denied for table platform_identities` here means the API is running a PostgresWorkspaceBootstrapRepository whose identity read went through the tenant role: infra/local/ensure-app-role.sql deliberately revokes that table from merchant_app, and the composition root must pass the operations pool for it. (That wiring was wrong until this branch fixed it — the note this replaces described the defect as permanent.)',
    ].join('\n'))
  }
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

/** Best-effort read of the limits the target advertises; diagnostics only. */
async function advertisedLimits(base: string) {
  try {
    const response = await fetch(`${base}/healthz`)
    const envelope = await response.json() as { data?: { capacity?: { apiRateLimitPerMinute?: number; opsApiRateLimitPerMinute?: number } } }
    const capacity = envelope.data?.capacity
    if (!capacity) return 'unavailable'
    return `api=${capacity.apiRateLimitPerMinute ?? 'unknown'} ops=${capacity.opsApiRateLimitPerMinute ?? 'unknown'}`
  } catch { return 'unavailable' }
}

async function main() {
  if (!workspaceId) await bootstrapWorkspace()
  const first = await probe(aUrl)
  const second = await probe(bUrl)
  const third = await probe(aUrl)
  if (![first, second, third].every(status => [200, 429].includes(status)) || third !== 429) {
    // 200,200,429 is a property of the whole deployment, not only of the
    // code: the counter is shared, but the threshold is configuration. Both
    // replicas must run with a 2-per-minute window, and which variable holds
    // that number depends on the role of the token. The declared local
    // tokens carry workspace_owner/merchant_admin/platform_ops, and any one
    // of those roles selects the ops bucket, so on the local Compose stack
    // the effective knob is OPS_API_RATE_LIMIT_PER_MINUTE.
    throw new Error([
      `[distributed-rate-limit] expected 200,200,429; got ${first},${second},${third}`,
      'Start both replicas with a 2-per-minute window: OPS_API_RATE_LIMIT_PER_MINUTE=2 for a token carrying workspace_owner/merchant_admin/platform_ops (the shipped local tokens do), or API_RATE_LIMIT_PER_MINUTE=2 together with a token without those roles.',
      `Advertised limits: ${aUrl} ${await advertisedLimits(aUrl)}; ${bUrl} ${await advertisedLimits(bUrl)}`,
      'Without a 2-per-minute window the observed statuses are 200,200,200 even when both replicas share one Redis counter.',
    ].join('\n'))
  }
  console.log(JSON.stringify({ status: 'PASS', workspaceId, statuses: [first, second, third], replicas: [aUrl, bUrl] }, null, 2))
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
