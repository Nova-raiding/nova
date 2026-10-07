import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { server as apiServer } from '../../api/src/server.js'
import { afterEach, describe, expect, it } from 'vitest'

const bridge = new URL('./bridge.mjs', import.meta.url)
let child: ChildProcessWithoutNullStreams | undefined

async function listen(server: ReturnType<typeof createServer> | typeof apiServer) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind')
  return `http://127.0.0.1:${address.port}`
}

async function nextLine(stream: NodeJS.ReadableStream): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString()
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      cleanup()
      resolve(JSON.parse(buffer.slice(0, newline)))
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

async function readJson(request: IncomingMessage) {
  let body = ''
  for await (const chunk of request) body += chunk.toString()
  return JSON.parse(body)
}

function close(server: ReturnType<typeof createServer> | typeof apiServer) {
  return new Promise<void>(resolve => {
    if (!server.listening) return resolve()
    server.close(() => resolve())
  })
}

afterEach(async () => {
  if (child && child.exitCode === null) {
    child.kill()
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 1000))])
  }
  child = undefined
  await close(apiServer)
})

describe('plugin bridge ↔ API MCP transport contract', () => {
  it('sends a legacy business-method RPC and consumes the API application envelope', async () => {
    const apiBase = await listen(apiServer)
    let forwardedRequest: { method?: string; url?: string; headers: IncomingMessage['headers']; body: any } | undefined
    let apiResponse: { status: number; contentType: string | undefined; body: any } | undefined
    const proxy = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const body = await readJson(req)
        forwardedRequest = { method: req.method, url: req.url, headers: req.headers, body }
        const headers = new Headers()
        for (const [key, value] of Object.entries(req.headers)) {
          if (key === 'host' || value === undefined) continue
          headers.set(key, Array.isArray(value) ? value.join(', ') : value)
        }
        const upstream = await fetch(`${apiBase}${req.url}`, {
          method: req.method,
          headers,
          body: JSON.stringify(body),
        })
        const responseBody = await upstream.json()
        apiResponse = { status: upstream.status, contentType: upstream.headers.get('content-type') ?? undefined, body: responseBody }
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
        res.end(JSON.stringify(responseBody))
      } catch (error) {
        res.statusCode = 502
        res.end(error instanceof Error ? error.message : String(error))
      }
    })
    const proxyBase = await listen(proxy)

    child = spawn(process.execPath, [bridge.pathname], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DEPLOY_ENV: 'local_desktop',
        MERCHANT_MCP_BASE_URL: proxyBase,
        MERCHANT_WORKSPACE_ID: 'ws_demo',
        MERCHANT_MCP_TOKEN_SOURCE: 'environment',
        MERCHANT_MCP_TOKEN: 'bridge-contract-test-token',
        MERCHANT_MCP_REFRESH_TOKEN: '',
        MERCHANT_ALLOW_FIXTURE_FALLBACK: 'true',
        MERCHANT_MCP_RETRY_ATTEMPTS: '1',
        MERCHANT_MCP_TIMEOUT_MS: '10000',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`)
      expect((await nextLine(child.stdout)).result.protocolVersion).toBe('2025-06-18')

      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'workspace.health', arguments: {} } })}\n`)
      const called = await nextLine(child.stdout)

      expect(forwardedRequest).toMatchObject({
        method: 'POST',
        url: '/mcp',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'mcp-protocol-version': '2025-06-18',
          'x-ops-workbench': 'workspace',
          'x-workspace-id': 'ws_demo',
        },
        body: {
          jsonrpc: '2.0',
          method: 'workspace.health',
          params: { workspace_id: 'ws_demo' },
        },
      })
      expect(typeof forwardedRequest?.body.id).toBe('string')
      expect(forwardedRequest?.body.method).not.toBe('tools/call')
      expect(apiResponse).toMatchObject({
        status: 200,
        body: {
          data: {
            result: {
              mcp: { status: 'ready', transport: '/mcp' },
              workspace: { id: 'ws_demo', status: 'ready' },
            },
          },
        },
      })
      expect(apiResponse?.body).not.toHaveProperty('result')
      // The API envelope is checked above. The bridge intentionally projects
      // workspace.health into its merchant-facing next-step state instead of
      // exposing that API object verbatim.
      expect(called.result.isError).toBe(false)
      expect(called.result.structuredContent).toEqual(expect.objectContaining({ conversation_state: expect.any(Object) }))
    } finally {
      if (child.exitCode === null) child.kill()
      await close(proxy)
    }
  })
})
