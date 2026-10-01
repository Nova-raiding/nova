import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const bridge = new URL('./bridge.mjs', import.meta.url)

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

describe('local stdio plugin host boundary', () => {
  it('completes initialize → tools/list → tools/call and fails closed without credentials', async () => {
    let upstreamRequests = 0
    const upstream = createServer((_req, res) => {
      upstreamRequests += 1
      res.statusCode = 500
      res.end('unexpected upstream request')
    })
    upstream.listen(0, '127.0.0.1')
    await once(upstream, 'listening')
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind')

    const child = spawn(process.execPath, [bridge.pathname], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DEPLOY_ENV: 'local_desktop',
        MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`,
        MERCHANT_WORKSPACE_ID: 'ws_host_boundary',
        MERCHANT_MCP_TOKEN: '',
        MERCHANT_MCP_REFRESH_TOKEN: '',
        MERCHANT_MCP_TOKEN_SOURCE: 'environment',
        MERCHANT_STRICT_AUTH: 'true',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })}\n`)
      expect((await nextLine(child.stdout)).result).toMatchObject({
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'merchant-marketing' },
      })

      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
      const listed = await nextLine(child.stdout)
      expect(listed.error).toBeUndefined()
      expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining(['workspace.health', 'onboarding.status']))

      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'workspace.health', arguments: {} } })}\n`)
      const called = await nextLine(child.stdout)
      expect(called.result).toMatchObject({
        isError: true,
        structuredContent: { code: 'MCP_AUTH_REQUIRED', recovery: { state: 'authentication_required', user_action_required: true } },
      })
      expect(called.result.content[0].text).toContain('本次未完成请求')
      expect(upstreamRequests).toBe(0)
    } finally {
      child.kill()
      await once(child, 'exit').catch(() => undefined)
      upstream.close()
      await once(upstream, 'close').catch(() => undefined)
    }
  })
})
