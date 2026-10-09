import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const bridgePath = fileURLToPath(new URL('./bridge.mjs', import.meta.url))

function nextLine(stream: NodeJS.ReadableStream): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString()
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      cleanup()
      try { resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, any>) } catch (error) { reject(error) }
    }
    const onError = (error: Error) => { cleanup(); reject(error) }
    const onEnd = () => { cleanup(); reject(new Error('local stdio bridge ended before its response')) }
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

describe('visual generation permission preflight through local stdio MCP', () => {
  it('returns API permission denials without retrying, polling, or falling back for image and video', async () => {
    const deniedMethods: string[] = []
    let providerRequests = 0
    const fixtureApi = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk.toString()
      if (req.url === '/provider/image' || req.url === '/provider/video') providerRequests += 1
      const payload = JSON.parse(body) as { method?: string }
      deniedMethods.push(String(payload.method))
      res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({
        error: {
          code: 'PERMISSION_DENIED',
          message: 'The current workspace role cannot generate media.',
          details: { provider_executed: false, reason_code: 'AUTHZ_SCOPE_MISMATCH' },
        },
      }))
    })
    fixtureApi.listen(0, '127.0.0.1')
    await once(fixtureApi, 'listening')
    const address = fixtureApi.address()
    if (!address || typeof address === 'string') throw new Error('fixture API did not bind')

    const child = spawn(process.execPath, [bridgePath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DEPLOY_ENV: 'local_desktop',
        MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`,
        MERCHANT_WORKSPACE_ID: 'ws_visual_permission_denied',
        MERCHANT_MCP_TOKEN: '',
        MERCHANT_MCP_REFRESH_TOKEN: '',
        MERCHANT_MCP_TOKEN_SOURCE: 'environment',
        MERCHANT_STRICT_AUTH: 'false',
        MERCHANT_MCP_WRITE_ENABLED: 'true',
        MERCHANT_ALLOW_FIXTURE_FALLBACK: 'false',
        MERCHANT_MCP_RETRY_ATTEMPTS: '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let id = 0
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = nextLine(child.stdout)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } })}\n`)
      return response
    }

    try {
      const confirmation = await call('workspace.interactive.confirm', { confirmation: 'I_CONFIRM_INTERACTIVE_WRITES' })
      expect(confirmation.result).toMatchObject({ isError: false, structuredContent: { enabled: true } })

      const deniedRequests = [
        ['catalog.image.generate', { product_id: 'unreviewed-product', mode: 'create', direction: 'fixture request', count: '1', idempotency_key: 'denied-image-1' }],
        ['multimodal.video.request', { prompt: 'fixture request', output: 'rendering', context_json: JSON.stringify({ product: { id: 'unreviewed-product', version: '1' }, brand: null, rules: [] }), idempotency_key: 'denied-video-1' }],
      ] as const
      for (const [method, args] of deniedRequests) {
        const response = await call(method, args)
        expect(response.result, method).toMatchObject({
          isError: true,
          structuredContent: { code: 'PERMISSION_DENIED', details: { reason_code: 'AUTHZ_SCOPE_MISMATCH' } },
        })
        expect(response.result.content[0].text).toContain('没有执行这一步的权限')
        expect(response.result).not.toHaveProperty('execution')
      }

      expect(deniedMethods).toEqual(['catalog.image.generate', 'multimodal.video.request'])
      expect(deniedMethods).not.toContain('catalog.image.get')
      expect(deniedMethods).not.toContain('multimodal.video.get')
      expect(providerRequests).toBe(0)
    } finally {
      child.kill()
      await once(child, 'exit').catch(() => undefined)
      fixtureApi.close()
      await once(fixtureApi, 'close').catch(() => undefined)
    }
  }, 15_000)
})
