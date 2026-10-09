import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelUsageRecord } from '../../../packages/persistence/src/model-usage-repository.js'

const fakeProvider = vi.hoisted(() => ({ calls: 0, lastInput: undefined as Record<string, any> | undefined }))

// Keep this vertical slice entirely local. The API sees the same provider
// boundary it uses in production, but its generator and settled usage receipt
// are deterministic fixtures; no model endpoint is contacted.
vi.mock('../../../packages/persistence/src/index.js', async original => {
  const actual = await original<typeof import('../../../packages/persistence/src/index.js')>()
  class FixtureUsageRepository extends actual.MemoryModelUsageRepository {
    override async listByAction(workspaceId: string, actionId: string): Promise<ModelUsageRecord[]> {
      if (!fakeProvider.calls) return []
      return [{
        id: 'fixture-model-receipt-1',
        receiptKey: 'fixture-model-receipt-1',
        receiptHash: 'f'.repeat(64),
        workspaceId,
        actionId,
        modality: 'text',
        model: 'fixture-text-model',
        providerRequestId: 'fixture-provider-request-1',
        inputTokens: 31,
        outputTokens: 44,
        totalTokens: 75,
        costCny: 0.001,
        settlementStatus: 'settled',
        attemptCount: 1,
        revision: 1,
        observedAt: '2026-10-09T00:00:00.000Z',
      }]
    }
  }
  return { ...actual, MemoryModelUsageRepository: FixtureUsageRepository }
})

vi.mock('../../../packages/ai/src/generator.js', async original => {
  const actual = await original<typeof import('../../../packages/ai/src/generator.js')>()
  return {
    ...actual,
    createContentGeneratorFromEnv: () => ({
      generate: async (input: Record<string, any>) => {
        fakeProvider.calls += 1
        fakeProvider.lastInput = input
        return {
          title: '京东合成商品候选标题',
          detail: '仅依据隔离 fixture 商品资料形成的待审核候选文案。',
          sellingPoints: ['合成资料候选卖点，须商家复核'],
          brief: {
            platform: 'jd', placement: 'fixture preview', targetDimensions: '未指定',
            visualHierarchy: ['商品'], productImageGuidance: '无图片素材', logoSafety: '未提供品牌素材',
            headline: '京东合成商品候选标题', subheadline: '待商家审核', coreSellingPoint: '待确认',
            cta: '了解商品', textDensity: '低', safeArea: '待确认', protectedAreas: ['商品主体'],
          },
        }
      },
    }),
  }
})

const bridgePath = fileURLToPath(new URL('./bridge.mjs', import.meta.url))
let api: typeof import('../../api/src/server.js')
let child: ChildProcessWithoutNullStreams | undefined

function nextLine(stream: NodeJS.ReadableStream): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString()
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      cleanup()
      try { resolve(JSON.parse(buffer.slice(0, newline))) } catch (error) { reject(error) }
    }
    const onError = (error: Error) => { cleanup(); reject(error) }
    const onEnd = () => { cleanup(); reject(new Error('stdio bridge ended before its response')) }
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

async function startApi() {
  if (!api.server.listening) {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      api.server.once('error', onError)
      api.server.listen(0, '127.0.0.1', () => { api.server.removeListener('error', onError); resolve() })
    })
  }
  const address = api.server.address()
  if (!address || typeof address === 'string') throw new Error('fixture API did not bind to loopback')
  return `http://127.0.0.1:${address.port}`
}

function startBridge(input: { baseUrl: string; workspaceId: string; tokenSource: string; token?: string }) {
  child = spawn(process.execPath, [bridgePath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DEPLOY_ENV: 'test',
      MERCHANT_MCP_BASE_URL: input.baseUrl,
      MERCHANT_WORKSPACE_ID: input.workspaceId,
      MERCHANT_ACTOR_ID: 'local-content-chain-owner',
      MERCHANT_MCP_TOKEN_SOURCE: input.tokenSource,
      ...(input.token ? { MERCHANT_MCP_TOKEN: input.token } : {}),
      MERCHANT_MCP_REFRESH_TOKEN: '',
      MERCHANT_STRICT_AUTH: 'true',
      MERCHANT_ALLOW_FIXTURE_FALLBACK: 'false',
      MERCHANT_MCP_RETRY_ATTEMPTS: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return child
}

async function rpc(process: ChildProcessWithoutNullStreams, id: number, method: string, params?: Record<string, unknown>) {
  const response = nextLine(process.stdout)
  process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`)
  const parsed = await response
  expect(parsed.id).toBe(id)
  return parsed
}

async function callTool(process: ChildProcessWithoutNullStreams, id: number, name: string, args: Record<string, unknown> = {}) {
  return rpc(process, id, 'tools/call', { name, arguments: args })
}

async function stopBridge() {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit')
    child.kill()
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1000))])
  }
  child = undefined
}

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('DEPLOY_ENV', 'test')
  vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'local-content-chain-e2e-session-secret')
  vi.stubEnv('AI_MODEL', 'fixture-text-model')
  api = await import('../../api/src/server.js')
}, 90_000)

beforeEach(() => {
  fakeProvider.calls = 0
  fakeProvider.lastInput = undefined
})

afterEach(async () => {
  await stopBridge()
  if (api?.server.listening) await new Promise<void>(resolve => api.server.close(() => resolve()))
  vi.unstubAllEnvs()
})

describe('local stdio → loopback API merchant content workflow gates', { timeout: 30_000 }, () => {
  it('imports a manual JD candidate and blocks generation until imported knowledge passes review, rights, and indexing gates', async () => {
    const workspaceId = `ws_local_content_chain_${randomUUID()}`
    const token = `local-content-chain-token-${randomUUID()}`
    const actorId = 'local-content-chain-owner'
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ [token]: { workspaces: [workspaceId], actor_id: actorId, roles: ['workspace_owner'] } }))
    await api.workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: 'isolated local content-chain owner', role: 'workspace_owner', status: 'active', invitedBy: 'local-content-chain-e2e' })
    await api.grantCreativePointsForTests(workspaceId, 100)
    api.grantContinuousFeatureEntitlementForTests(workspaceId)

    const baseUrl = await startApi()
    const bridge = startBridge({ baseUrl, workspaceId, tokenSource: 'environment', token })
    expect((await rpc(bridge, 0, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'local-content-chain-e2e', version: '1' } })).result.protocolVersion).toBe('2025-06-18')
    const tools = (await rpc(bridge, 1, 'tools/list', {})).result.tools.map((tool: { name: string }) => tool.name)
    expect(tools).toEqual(expect.arrayContaining(['catalog.search', 'catalog.import', 'catalog.facts.confirm', 'task.create.draft', 'task.select_direction', 'task.plan.confirm', 'content.generate', 'content.review', 'content.export']))
    expect(tools).not.toContain('publish.confirm')

    const interactiveConfirmation = await callTool(bridge, 2, 'workspace.interactive.confirm', { confirmation: 'I_CONFIRM_INTERACTIVE_WRITES' })
    expect(interactiveConfirmation.result.isError, JSON.stringify(interactiveConfirmation.result)).toBe(false)

    const imported = await callTool(bridge, 3, 'catalog.import', {
      platform: 'jd', draft_only: 'true', local_product_key: `manual-${workspaceId}`,
      title: '京东合成商品候选', category: '服饰', price: '199.00', stock: '8',
      attributes_json: JSON.stringify({ material: '合成测试资料', color: '雾蓝' }),
    })
    expect(imported.result.isError, JSON.stringify(imported.result)).toBe(false)
    const importedProduct = imported.result.structuredContent
    const productId = importedProduct.product_id as string
    expect(importedProduct).toMatchObject({ platform: 'jd', draft_only: true, publishable: false, candidate_status: '未绑定商品、仅草稿、不可发布' })
    expect(importedProduct.accountId).toBeUndefined()
    expect(importedProduct.knowledge).toMatchObject({ approvalStatus: 'pending', rightsStatus: 'unknown', indexState: 'queued' })

    const searched = await callTool(bridge, 4, 'catalog.search', { platform: 'jd', scope: 'workspace' })
    expect(searched.result.isError, JSON.stringify(searched.result)).toBe(false)
    expect(JSON.stringify(searched.result.structuredContent)).toContain(productId)

    const facts = await callTool(bridge, 5, 'catalog.facts.confirm', { product_id: productId })
    expect(facts.result.isError, JSON.stringify(facts.result)).toBe(false)
    const taskResponse = await callTool(bridge, 6, 'task.create.draft', { product_id: productId, platform: 'jd', request_text: '生成基于已确认资料的京东商品详情候选' })
    expect(taskResponse.result.isError, JSON.stringify(taskResponse.result)).toBe(false)
    const task = taskResponse.result.structuredContent
    expect(task).toMatchObject({ candidateOnly: true, candidate_only: true, storeContext: null, productId, product_id: productId })
    expect(task.accountId).toBeUndefined()

    const direction = await callTool(bridge, 7, 'task.select_direction', { task_id: task.id, direction_id: 'A' })
    expect(direction.result.isError, JSON.stringify(direction.result)).toBe(false)
    const plan = await callTool(bridge, 8, 'task.plan.confirm', { task_id: task.id })
    expect(plan.result.isError, JSON.stringify(plan.result)).toBe(false)
    expect(plan.result.structuredContent.state).toBe('plan_confirmed')

    const generated = await callTool(bridge, 9, 'content.generate', { task_id: task.id, idempotency_key: `fixture-generation-${workspaceId}` })
    expect(generated.result.isError, JSON.stringify(generated.result)).toBe(true)
    expect(generated.result.structuredContent).toMatchObject({
      code: 'KNOWLEDGE_REVIEW_REQUIRED',
      message: '商品知识尚未通过审批或权益确认，请先完成知识资产审核，再生成内容。',
    })
    expect(generated.result.content[0].text).toContain('知识资产审核')
    expect(generated.result.structuredContent).not.toHaveProperty('execution')
    expect(JSON.stringify(generated.result)).not.toContain('fixture-provider-request-1')
    expect(fakeProvider.calls).toBe(0)
    expect(fakeProvider.lastInput).toBeUndefined()

    const currentTask = await callTool(bridge, 10, 'task.history', { product_id: productId })
    expect(currentTask.result.isError, JSON.stringify(currentTask.result)).toBe(false)
    const persistedTask = currentTask.result.structuredContent.items.find((item: { id: string }) => item.id === task.id)
    expect(persistedTask).toMatchObject({ state: 'plan_confirmed', candidateOnly: true })
    expect(persistedTask.accountId).toBeUndefined()
    expect(persistedTask.contentVersionId).toBeUndefined()
    const versions = await callTool(bridge, 11, 'content.versions', { task_id: task.id })
    expect(versions.result.isError, JSON.stringify(versions.result)).toBe(false)
    expect(versions.result.structuredContent).toEqual([])
    expect(api.service.listContentVersions(workspaceId, task.id)).toEqual([])
  })

  it('fails the whole content tool sequence before HTTP when credentials are unavailable', async () => {
    const requests: string[] = []
    const fixtureServer = await import('node:http').then(({ createServer }) => createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`)
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    }))
    fixtureServer.listen(0, '127.0.0.1')
    await once(fixtureServer, 'listening')
    const address = fixtureServer.address()
    if (!address || typeof address === 'string') throw new Error('credential fixture did not bind')
    const bridge = startBridge({ baseUrl: `http://127.0.0.1:${address.port}`, workspaceId: 'ws_missing_credential_fixture', tokenSource: 'unsupported-fixture-source' })
    try {
      await rpc(bridge, 20, 'initialize', {})
      const sequence = [
        ['catalog.search', { platform: 'jd', scope: 'workspace' }],
        ['catalog.import', { platform: 'jd', draft_only: 'true', title: 'fixture' }],
        ['catalog.facts.confirm', { product_id: 'fixture-product' }],
        ['task.create.draft', { product_id: 'fixture-product', platform: 'jd' }],
        ['task.select_direction', { task_id: 'fixture-task', direction_id: 'A' }],
        ['task.plan.confirm', { task_id: 'fixture-task' }],
        ['content.generate', { task_id: 'fixture-task', idempotency_key: 'fixture-missing-token' }],
        ['content.review', { content_version_id: 'fixture-version' }],
        ['content.export', { content_version_id: 'fixture-version', format: 'manifest' }],
      ] as const
      for (const [index, [name, args]] of sequence.entries()) {
        const response = await callTool(bridge, 21 + index, name, args)
        expect(response.result, name).toMatchObject({ isError: true, structuredContent: { code: 'MCP_CREDENTIAL_SOURCE_INVALID' } })
      }
      expect(requests).toEqual([])
      expect(fakeProvider.calls).toBe(0)
    } finally {
      await stopBridge()
      await new Promise<void>(resolve => fixtureServer.close(() => resolve()))
    }
  })
})
