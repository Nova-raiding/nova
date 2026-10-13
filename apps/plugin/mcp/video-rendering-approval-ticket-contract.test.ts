import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const bridge = new URL('./bridge.mjs', import.meta.url)

describe('video rendering approval ticket bridge contract', () => {
  it('keeps the server nonce private and binds only the exact confirmed rendering context', async () => {
    const received: Array<{ method: string; params?: Record<string, unknown> }> = []
    let malformedTicket = false
    const upstream = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        const call = JSON.parse(body) as { method: string; params?: Record<string, unknown> }
        received.push(call)
        response.setHeader('content-type', 'application/json')
        const result = call.method === 'workspace.interactive.confirm'
          ? { enabled: true, scope: 'current_interactive_session', ticket: { nonce_hash: malformedTicket ? 'bad' : 'c'.repeat(64), intent_hash: call.params?.intent_hash, expires_at: malformedTicket ? 'not-a-time' : '2099-01-01T00:00:00.000Z' } }
          : { candidate_only: false, publishable: false, execution: { simulated: true, providerExecuted: false }, rendering: { status: 'not_configured' } }
        response.end(JSON.stringify({ data: { result }, error: null }))
      })
    })
    upstream.listen(0, '127.0.0.1')
    await once(upstream, 'listening')
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('mock API did not bind')
    const child = spawn(process.execPath, [bridge.pathname], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: 'test', DEPLOY_ENV: 'local_desktop', MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`, MERCHANT_WORKSPACE_ID: 'ws_video_approval', MERCHANT_MCP_TOKEN: 'local-test-token', MERCHANT_MCP_REFRESH_TOKEN: '', MERCHANT_MCP_TOKEN_SOURCE: 'environment', MERCHANT_STRICT_AUTH: 'true', MERCHANT_MCP_WRITE_ENABLED: 'true' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const nextLine = () => new Promise<any>((resolve, reject) => {
      let buffer = ''
      const onData = (chunk: Buffer | string) => { buffer += chunk.toString(); const newline = buffer.indexOf('\n'); if (newline < 0) return; cleanup(); resolve(JSON.parse(buffer.slice(0, newline))) }
      const onError = (error: Error) => { cleanup(); reject(error) }
      const cleanup = () => { child.stdout.off('data', onData); child.stdout.off('error', onError) }
      child.stdout.on('data', onData); child.stdout.once('error', onError)
    })
    const call = async (id: number, name: string, args: Record<string, unknown>) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`)
      return nextLine()
    }
    const prompt = '按已经确认的商品分镜生成成片'
    const context = { product: { id: 'product-a', version: '4' }, brand: { id: 'brand-a', version: '2' }, rules: [{ id: 'rule-a', version: '1' }], brief: { id: 'brief-a', version: '7' }, assets: [{ id: 'asset-a', version: '2', sha256: 'asset-hash' }], storyboardQuality: { scenes: [{ id: 'scene-1', visual: '展示蓝色商品' }] } }
    const context_json = JSON.stringify(context)
    try {
      const blocked = await call(1, 'multimodal.video.request', { prompt, output: 'rendering', context_json, idempotency_key: 'video-approval-1' })
      expect(blocked.result).toMatchObject({ isError: true, structuredContent: { code: 'INTERACTIVE_WRITE_DISABLED' } })
      expect(received).toHaveLength(0)

      const confirmation = await call(2, 'workspace.interactive.confirm', { confirmation: 'I_CONFIRM_INTERACTIVE_WRITES', video_prompt: prompt, video_context_json: context_json })
      expect(confirmation.result).toMatchObject({ isError: false, structuredContent: { enabled: true, ticket: { intent_hash: expect.stringMatching(/^[a-f0-9]{64}$/u) } } })
      expect(JSON.stringify(confirmation.result)).not.toContain('c'.repeat(64))
      const missingKey = await call(3, 'multimodal.video.request', { prompt, output: 'rendering', context_json })
      expect(missingKey.result).toMatchObject({ isError: true, structuredContent: { code: 'TOOL_ARGUMENTS_INVALID' } })
      expect(missingKey.result.structuredContent.message).toMatch(/idempotency_key/u)
      const blankKey = await call(4, 'multimodal.video.request', { prompt, output: 'rendering', context_json, idempotency_key: '   ' })
      expect(blankKey.result).toMatchObject({ isError: true, structuredContent: { code: 'TOOL_ARGUMENTS_INVALID' } })
      const malformedKey = await call(5, 'multimodal.video.request', { prompt, output: 'rendering', context_json, idempotency_key: 'bad/key' })
      expect(malformedKey.result).toMatchObject({ isError: true, structuredContent: { code: 'TOOL_ARGUMENTS_INVALID' } })
      expect(received.map(call => call.method)).toEqual(['workspace.interactive.confirm'])

      const exact = await call(6, 'multimodal.video.request', { prompt, output: 'rendering', context_json, idempotency_key: 'video-approval-1' })
      expect(exact.result).toMatchObject({ isError: false, structuredContent: { execution: { providerExecuted: false } } })
      expect(received.map(call => call.method)).toEqual(['workspace.interactive.confirm', 'multimodal.video.request'])
      expect(received[0]?.params).toMatchObject({ intent_hash: confirmation.result.structuredContent.ticket.intent_hash })
      expect(received[1]?.params).toMatchObject({ confirmation_ticket_nonce_hash: 'c'.repeat(64), confirmation_ticket_intent_hash: confirmation.result.structuredContent.ticket.intent_hash })

      const changedContext = { ...context, storyboardQuality: { scenes: [{ id: 'scene-1', visual: '展示红色商品' }] } }
      malformedTicket = true
      const malformed = await call(4, 'workspace.interactive.confirm', { confirmation: 'I_CONFIRM_INTERACTIVE_WRITES', video_prompt: prompt, video_context_json: JSON.stringify(changedContext) })
      expect(malformed.result).toMatchObject({ isError: true, structuredContent: { code: 'VIDEO_CONFIRMATION_TICKET_INVALID' } })
      const changed = await call(5, 'multimodal.video.request', { prompt, output: 'rendering', context_json: JSON.stringify(changedContext), idempotency_key: 'video-approval-2' })
      expect(changed.result).toMatchObject({ isError: true, structuredContent: { code: 'VIDEO_RENDERING_CONFIRMATION_REQUIRED' } })
      expect(received.map(call => call.method)).toEqual(['workspace.interactive.confirm', 'multimodal.video.request', 'workspace.interactive.confirm'])
    } finally {
      child.kill()
      await once(child, 'exit').catch(() => undefined)
      upstream.close()
      await once(upstream, 'close').catch(() => undefined)
    }
  }, 5_000)
})
