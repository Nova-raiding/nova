import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { server, workspaceMembers } from './server.js'

type RpcResponse = {
  jsonrpc?: string
  id?: string | number | null
  result?: { protocolVersion?: string; capabilities?: { tools?: Record<string, unknown> }; tools?: Array<{ name: string }> }
  error?: { code: number; message: string }
}

const BRIDGE_PATH = fileURLToPath(new URL('../../plugin/mcp/bridge.mjs', import.meta.url))
const PROTOCOL_VERSION = '2025-06-18'

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

async function bridgeRequest(
  child: ChildProcessWithoutNullStreams,
  request: { jsonrpc: '2.0'; id: string | number; method: string; params?: Record<string, unknown> },
) {
  child.stdin.write(`${JSON.stringify(request)}\n`)
  const response = await nextLine(child.stdout)
  expect(response.id).toBe(request.id)
  return response
}

async function startApi() {
  if (!server.listening) {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      server.once('error', onError)
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolve() })
    })
  }
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('API server did not bind to loopback')
  return `http://127.0.0.1:${address.port}`
}

beforeAll(() => {
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'stdio-mcp-initialize-contract-session-secret')
})

afterAll(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  vi.unstubAllEnvs()
})

describe('API and local stdio MCP initialization contract', () => {
  it('keeps protocol negotiation aligned and suppresses initialized-notification output', async () => {
    const suffix = randomUUID().slice(0, 8)
    const workspaceId = `ws_stdio_init_${suffix}`
    const actorId = `stdio-init-${suffix}`
    const token = `stdio-init-token-${suffix}`
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ [token]: { workspaces: [workspaceId], actor_id: actorId, roles: ['operator'] } }))
    await workspaceMembers.upsert({
      workspaceId,
      externalSubject: actorId,
      displayName: 'stdio MCP initialization contract',
      role: 'operator',
      status: 'active',
      invitedBy: 'stdio-mcp-initialize-contract',
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
        MERCHANT_MCP_RETRY_ATTEMPTS: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const childExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })

    try {
      const headers = {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-ops-workbench': 'workspace',
        'x-workspace-id': workspaceId,
      }
      const apiInitialize = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0', id: 0, method: 'initialize',
          params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'contract-test', version: '1' } },
        }),
      })
      expect(apiInitialize.status).toBe(200)
      const apiResponse = await apiInitialize.json() as RpcResponse
      expect(apiResponse).toMatchObject({
        jsonrpc: '2.0', id: 0, result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'merchant-marketing' },
        },
      })

      const stdioInitialize = await bridgeRequest(child, {
        jsonrpc: '2.0', id: 0, method: 'initialize',
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'contract-test', version: '1' } },
      })
      expect(stdioInitialize).toMatchObject({
        jsonrpc: '2.0', id: 0, result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'merchant-marketing' },
        },
      })

      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`)
      const listed = await bridgeRequest(child, { jsonrpc: '2.0', id: 'after-initialize', method: 'tools/list', params: {} })
      expect(listed.error).toBeUndefined()
      expect(listed.result?.tools?.length).toBeGreaterThan(0)
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill()
      await childExit
    }
  }, 30_000)
})
