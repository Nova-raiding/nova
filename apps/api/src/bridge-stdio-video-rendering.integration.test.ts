import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { trustedPlatformRuleTestRepository } from './platform-rule-test-fixture.js'

const videoRelay = vi.hoisted(() => ({
  generate: vi.fn(async (input: import('../../../packages/ai/src/video-generator.js').VideoGenerationInput) => {
    await input.beforeDispatch?.()
    await input.onAccepted?.({ ...input.usageContext, model: 'stdio-video-fixture', providerJobId: 'stdio-video-job', providerRequestId: 'stdio-video-request' })
    return { status: 'queued' as const, providerJobId: 'stdio-video-job', settlementStatus: 'pending_receipt' as const }
  }),
  getStatus: vi.fn(),
}))

vi.mock('../../../packages/ai/src/video-generator.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../packages/ai/src/video-generator.js')>(),
  createVideoGeneratorFromEnv: () => videoRelay,
}))

type RpcResponse = { jsonrpc?: string; id?: string | number; result?: any; error?: { code: number; message: string } }
type ApiModule = typeof import('./server.js')

const BRIDGE_PATH = fileURLToPath(new URL('../../plugin/mcp/bridge.mjs', import.meta.url))
let api: ApiModule
let base = ''

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
    api.server.once('error', onError)
    api.server.listen(0, '127.0.0.1', () => { api.server.removeListener('error', onError); resolve() })
  })
  const address = api.server.address()
  if (!address || typeof address === 'string') throw new Error('API server did not bind to loopback')
  return `http://127.0.0.1:${address.port}`
}

async function stopBridge(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill()
    await once(child, 'exit')
  }
}

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'stdio-video-rendering-integration-session-secret')
  vi.stubEnv('MODEL_RELAY_BASE_URL', 'https://relay.example.test')
  vi.stubEnv('VIDEO_MODEL_RELAY_API_KEY', 'stub-video-relay-key')
  vi.stubEnv('VIDEO_MODEL', 'stdio-video-fixture')
  api = await import('./server.js')
  await api.persistenceReady
  base = await startApi()
}, 30_000)

afterAll(async () => {
  if (api?.server.listening) await new Promise<void>(resolve => { api.server.close(() => resolve()); api.server.closeAllConnections() })
  api?.setRuleRepositoryForTests(undefined)
  vi.unstubAllEnvs()
})

describe('ChatGPT local stdio → API → video relay confirmation chain', () => {
  it('passes the exact one-time approval to the API and blocks reuse before the relay', async () => {
    const suffix = randomUUID().slice(0, 8)
    const workspaceId = `ws_stdio_video_${suffix}`
    const actorId = `stdio-video-owner-${suffix}`
    const token = `stdio-video-token-${suffix}`
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ [token]: { workspaces: [workspaceId], actor_id: actorId, roles: ['workspace_owner'] } }))
    await api.workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'workspace_owner', status: 'active', invitedBy: 'stdio-video-rendering-integration' })

    const account = api.service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `stdio-video-store-${suffix}`, credentialRef: `fixture://${workspaceId}/taobao` })
    const product = api.service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, localProductKey: `stdio-video-product-${suffix}`, title: '本地 stdio 视频链路测试商品', stock: 1 })
    api.service.confirmProductFacts(workspaceId, product.id)
    api.setRuleRepositoryForTests(await trustedPlatformRuleTestRepository(workspaceId, 'taobao'))
    await api.grantCreativePointsForTests(workspaceId)
    api.grantContinuousFeatureEntitlementForTests(workspaceId)

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
        MERCHANT_MCP_WRITE_ENABLED: 'true',
        MERCHANT_MCP_RETRY_ATTEMPTS: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const prompt = '根据已确认的商品事实生成通勤场景展示视频'
    const context = { brand: { id: `brand-${suffix}`, version: '1' }, product: { id: product.id, version: String(product.version) }, rules: [{ id: `rules-${suffix}`, version: '1' }] }
    const contextJson = JSON.stringify(context)

    try {
      const tools = await bridgeRequest(child, 'stdio-video-list', 'tools/list')
      expect((tools.result?.tools as Array<{ name: string }>).map(tool => tool.name)).toContain('multimodal.video.request')

      const unconfirmed = await bridgeRequest(child, 'stdio-video-unconfirmed', 'tools/call', { name: 'multimodal.video.request', arguments: { prompt, output: 'rendering', context_json: contextJson, idempotency_key: `stdio-video-${suffix}` } })
      expect(unconfirmed.result).toMatchObject({ isError: true, structuredContent: { code: 'INTERACTIVE_WRITE_DISABLED' } })
      expect(videoRelay.generate).not.toHaveBeenCalled()

      const confirmed = await bridgeRequest(child, 'stdio-video-confirm', 'tools/call', { name: 'workspace.interactive.confirm', arguments: { confirmation: 'I_CONFIRM_INTERACTIVE_WRITES', video_prompt: prompt, video_context_json: contextJson } })
      expect(confirmed.result).toMatchObject({ isError: false, structuredContent: { enabled: true, ticket: { intent_hash: expect.stringMatching(/^[a-f0-9]{64}$/u) } } })
      expect(confirmed.result.structuredContent.ticket.nonce_hash).toBeUndefined()

      const renderArgs = { prompt, output: 'rendering', context_json: contextJson, idempotency_key: `stdio-video-${suffix}` }
      const rendered = await bridgeRequest(child, 'stdio-video-render', 'tools/call', { name: 'multimodal.video.request', arguments: renderArgs })
      expect(rendered.result, JSON.stringify(rendered.result)).toMatchObject({ isError: false, structuredContent: { rendering: { status: 'queued', providerJobId: 'stdio-video-job' } } })
      expect(videoRelay.generate).toHaveBeenCalledOnce()
      expect(videoRelay.generate.mock.calls[0]?.[0]).toMatchObject({ prompt, usageContext: { workspaceId } })

      const replayWithConsumedTicket = await bridgeRequest(child, 'stdio-video-reuse-ticket', 'tools/call', { name: 'multimodal.video.request', arguments: { ...renderArgs, idempotency_key: `stdio-video-new-action-${suffix}` } })
      expect(replayWithConsumedTicket.result).toMatchObject({ isError: true, structuredContent: { code: 'INTERACTIVE_CONFIRMATION_TICKET_INVALID' } })
      expect(videoRelay.generate).toHaveBeenCalledOnce()
    } finally {
      await stopBridge(child)
      api.setRuleRepositoryForTests(undefined)
    }
  }, 30_000)
})
