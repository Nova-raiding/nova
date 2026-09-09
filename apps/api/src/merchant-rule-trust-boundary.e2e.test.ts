import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { grantContinuousFeatureEntitlementForTests, grantCreativePointsForTests, server } from './server.js'

async function start() {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

function resultOf(body: { data?: unknown }) {
  const data = body.data
  return data && typeof data === 'object' && 'result' in data
    ? (data as { result?: unknown }).result
    : data
}

describe('merchant rule trust boundary', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'merchant-rule-trust-boundary-secret')
    vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
  })

  afterEach(async () => {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
    vi.unstubAllEnvs()
  })

  it('does not expose manual fixture rules through merchant HTTP or MCP reads', async () => {
    await grantCreativePointsForTests('ws_demo')
    grantContinuousFeatureEntitlementForTests('ws_demo')
    const base = await start()
    const headers = { 'x-workspace-id': 'ws_demo' }

    const httpResponse = await fetch(`${base}/v1/rules`, { headers })
    const httpBody = await httpResponse.json() as { data?: unknown; error?: unknown }
    expect(httpResponse.status, JSON.stringify(httpBody)).toBe(200)
    expect(httpBody.error).toBeNull()
    expect(resultOf(httpBody)).toEqual([])

    const mcpResponse = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'manual-rule-boundary', method: 'rule.list', params: {} }),
    })
    const mcpBody = await mcpResponse.json() as { data?: unknown; error?: unknown }
    expect(mcpResponse.status, JSON.stringify(mcpBody)).toBe(200)
    expect(mcpBody.error).toBeNull()
    expect(resultOf(mcpBody)).toEqual([])

    const sharedOpsRoleWithoutWorkbench = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...headers, 'x-role': 'platform_ops', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'shared-ops-role-no-workbench', method: 'rule.list', params: {} }),
    })
    const sharedOpsBody = await sharedOpsRoleWithoutWorkbench.json() as { data?: unknown; error?: unknown }
    expect(sharedOpsRoleWithoutWorkbench.status, JSON.stringify(sharedOpsBody)).toBe(200)
    expect(sharedOpsBody.error).toBeNull()
    expect(resultOf(sharedOpsBody)).toEqual([])
  })
})
