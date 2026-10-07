import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { server, workspaceMembers } from './server.js'

type RpcResponse = { jsonrpc?: string; id?: string | number; result?: any; error?: { code: number; message: string; data?: { code?: string } } }

const BRIDGE_PATH = fileURLToPath(new URL('../../plugin/mcp/bridge.mjs', import.meta.url))

function nextLine(stream: NodeJS.ReadableStream): Promise<RpcResponse> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString()
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      cleanup()
      try { resolve(JSON.parse(buffer.slice(0, newline)) as RpcResponse) } catch (error) { reject(error) }
    }
    const onError = (error: Error) => { cleanup(); reject(error) }
    const onEnd = () => { cleanup(); reject(new Error('stdio bridge ended before the response')) }
    const cleanup = () => {
      stream.off('data', onData)
      stream.off('error', onError)
      stream.off('end', onEnd)
    }
    stream.on('data', onData)
    stream.once('error', onError)
    stream.once('end', onEnd)
  })
}

async function bridgeRequest(child: ChildProcessWithoutNullStreams, id: string, method: string, params?: Record<string, unknown>) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`)
  const response = await nextLine(child.stdout)
  expect(response.id).toBe(id)
  return response
}

async function startApi() {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('API server did not bind to loopback')
  return `http://127.0.0.1:${address.port}`
}

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'stdio-native-mcp-integration-session-secret')
})

afterAll(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  vi.unstubAllEnvs()
})

describe('local stdio bridge to loopback native MCP integration', () => {
  it('projects tools/list, forwards a safe read, and preserves an API authorization error envelope', async () => {
    const suffix = randomUUID().slice(0, 8)
    const workspaceId = `ws_stdio_mcp_${Date.now()}_${suffix}`
    const actorId = `stdio-mcp-${suffix}`
    const token = `stdio-mcp-token-${suffix}`
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      [token]: { workspaces: [workspaceId], actor_id: actorId, roles: ['operator'] },
    }))
    await workspaceMembers.upsert({
      workspaceId,
      externalSubject: actorId,
      displayName: 'stdio bridge native MCP integration',
      role: 'operator',
      status: 'active',
      invitedBy: 'stdio-mcp-integration',
    })
    const base = await startApi()
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DEPLOY_ENV: 'test',
        MERCHANT_MCP_BASE_URL: base,
        MERCHANT_WORKSPACE_ID: workspaceId,
        MERCHANT_MCP_TOKEN: token,
        MERCHANT_MCP_TOKEN_SOURCE: 'environment',
        MERCHANT_STRICT_AUTH: 'true',
        MERCHANT_MCP_RETRY_ATTEMPTS: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    try {
      const headers = {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-ops-workbench': 'workspace',
        'x-workspace-id': workspaceId,
      }
      const apiListResponse = await fetch(`${base}/mcp`, {
        method: 'POST', headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 'api-list', method: 'tools/list', params: {} }),
      })
      expect(apiListResponse.status).toBe(200)
      const apiList = await apiListResponse.json() as RpcResponse
      expect(apiList).toMatchObject({ jsonrpc: '2.0', id: 'api-list', result: { tools: expect.any(Array) } })

      const stdioList = await bridgeRequest(child, 'stdio-list', 'tools/list')
      expect(stdioList.error).toBeUndefined()
      const bridgeTools = stdioList.result.tools as Array<{ name: string; description: string; inputSchema: unknown; annotations: unknown }>
      const apiTools = apiList.result.tools as Array<{ name: string; description: string; inputSchema: unknown; annotations: unknown }>
      const bridgeBillingList = bridgeTools.find(tool => tool.name === 'billing.recharge.list')
      const apiBillingList = apiTools.find(tool => tool.name === 'billing.recharge.list')
      expect(apiBillingList).toBeDefined()
      expect(bridgeBillingList?.name).toBe(apiBillingList!.name)
      expect(bridgeBillingList?.inputSchema).toMatchObject({ type: 'object' })
      expect(apiBillingList!.inputSchema).toMatchObject({ type: 'object' })
      expect(bridgeBillingList?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
      expect(apiBillingList!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
      expect(bridgeBillingList!.description.length).toBeGreaterThan(0)
      expect(bridgeTools.some(tool => tool.name.startsWith('ops.'))).toBe(false)

      const read = await bridgeRequest(child, 'stdio-read', 'tools/call', { name: 'billing.recharge.list', arguments: {} })
      expect(read, JSON.stringify(read)).toMatchObject({
        jsonrpc: '2.0',
        result: { isError: false, structuredContent: { scope: 'mine' } },
      })

      const forbidden = await bridgeRequest(child, 'stdio-forbidden', 'tools/call', {
        name: 'billing.recharge.list', arguments: { scope: 'workspace' },
      })
      expect(forbidden).toMatchObject({
        jsonrpc: '2.0',
        result: { isError: true, structuredContent: { code: 'FORBIDDEN' } },
      })
      expect(forbidden.error).toBeUndefined()
    } finally {
      child.kill()
      await new Promise<void>(resolve => child.once('exit', () => resolve()))
    }
  }, 30_000)
})
