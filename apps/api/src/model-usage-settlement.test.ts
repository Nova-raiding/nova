import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  modelUsage: null as null | {
    list(workspaceId: string, limit?: number): Promise<Array<Record<string, unknown>>>
  },
  actionLedger: null as null | {
    record(input: Record<string, unknown>): Promise<Record<string, unknown>>
    get(workspaceId: string, actionKey: string): Promise<Record<string, unknown> | undefined>
    refund(input: { workspaceId: string; actionKey: string; reason: string }): Promise<Record<string, unknown>>
  },
  providerRequestId: 'relay-request-default',
  costCny: undefined as number | undefined,
  walletSettlementCalls: 0,
  refundCalls: 0,
  modelCalls: 0,
}))

vi.mock('../../../packages/persistence/src/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../packages/persistence/src/index.js')>()

  class CapturingModelUsageRepository extends actual.MemoryModelUsageRepository {
    constructor() {
      super()
      harness.modelUsage = this as unknown as typeof harness.modelUsage
    }
  }

  class CapturingActionLedgerRepository extends actual.MemoryActionLedgerRepository {
    constructor() {
      super()
      harness.actionLedger = this as unknown as typeof harness.actionLedger
    }

    override async settleProviderUsage(input: { workspaceId: string; actionKey: string; providerRequestId?: string; actualAmountFen: number }) {
      harness.walletSettlementCalls += 1
      return super.settleProviderUsage(input)
    }

    override async refund(input: { workspaceId: string; actionKey: string; reason: string }) {
      harness.refundCalls += 1
      return super.refund(input)
    }
  }

  return {
    ...actual,
    MemoryModelUsageRepository: CapturingModelUsageRepository,
    MemoryActionLedgerRepository: CapturingActionLedgerRepository,
  }
})

type ApiModule = typeof import('./server.js')
let api: ApiModule

function relayResponse() {
  harness.modelCalls += 1
  const usage: Record<string, number> = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  if (harness.costCny !== undefined) usage.cost_cny = harness.costCny
  return new Response(JSON.stringify({
    id: harness.providerRequestId,
    choices: [{ message: { content: JSON.stringify({ title: '结算测试标题', detail: '只使用已确认商品事实的测试文案。', sellingPoints: ['事实可追溯'] }) } }],
    usage,
  }), { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': harness.providerRequestId } })
}

function fixtureProduct() {
  const product = [...api.service.products.values()].find(candidate => candidate.factsConfirmed)
  if (!product) throw new Error('expected a confirmed fixture product')
  return product
}

async function generate(workspaceId: string, actionId: string) {
  const product = fixtureProduct()
  const owned = api.service.importProduct({
    workspaceId,
    platform: product.platform,
    localProductKey: `usage-settlement-${workspaceId}`,
    title: product.title,
    stock: product.stock,
    skuCount: product.skuCount,
    price: product.price,
    category: product.category,
    attributes: product.attributes,
  })
  api.service.confirmProductFacts(workspaceId, owned.id)
  return api.service.generateOneSentenceText({ workspaceId, productId: owned.id, prompt: '生成一句事实安全文案', actionId })
}

async function authorizeAction(workspaceId: string, actionId: string, settlement: 'wallet' | 'included_quota') {
  await harness.actionLedger!.record({
    workspaceId,
    actionKey: actionId,
    actionKind: 'model_text',
    settlement,
    state: 'settled',
    units: 1,
    amountFen: 1,
    actorId: 'settlement-test',
    description: '模型生成调用',
    reservedAmountFen: 1,
    multiplier: 1,
    settlementStatus: settlement === 'wallet' ? 'authorized' : 'settled',
  })
}

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('VITEST', 'true')
  vi.stubEnv('PORT', '0')
  vi.stubEnv('CONNECTOR_FIXTURE_MODE', 'true')
  vi.stubEnv('MODEL_RELAY_BASE_URL', 'https://relay.example.test/v1')
  vi.stubEnv('MODEL_RELAY_API_KEY', 'test-relay-key')
  vi.stubEnv('AI_MODEL', 'relay-text-test')
  vi.stubEnv('PLUGIN_VERSION', '1.0.0-test')
  vi.stubEnv('SKILL_BUNDLE_VERSION', '1.0.0-test')
  vi.stubEnv('MCP_VERSION', '1.0.0-test')
  vi.stubEnv('CONNECTOR_BUILD', '1.0.0-test')
  vi.stubEnv('PROMPT_BUNDLE_VERSION', '1.0.0-test')
  vi.stubGlobal('fetch', vi.fn(async () => relayResponse()))

  api = await import('./server.js')
  await api.persistenceReady
  if (!api.server.listening) await new Promise<void>((resolve, reject) => { api.server.once('listening', resolve); api.server.once('error', reject) })
  await new Promise<void>((resolve, reject) => api.server.close(error => error ? reject(error) : resolve()))
})

beforeEach(() => {
  harness.providerRequestId = `relay-request-${Date.now()}-${Math.random()}`
  harness.costCny = undefined
  harness.walletSettlementCalls = 0
  harness.refundCalls = 0
  harness.modelCalls = 0
})

afterAll(async () => {
  if (api?.server.listening) await new Promise<void>(resolve => api.server.close(() => resolve()))
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('API model usage settlement invariants', () => {
  it('persists missing provider cost as pending_cost before blocking delivery', async () => {
    const workspaceId = `ws_missing_cost_${Date.now()}`
    const actionId = `model:missing-cost-${Date.now()}`

    await expect(generate(workspaceId, actionId)).rejects.toMatchObject({
      code: 'MODEL_USAGE_COST_MISSING',
      details: expect.objectContaining({ provider_succeeded: true }),
    })

    const rows = await harness.modelUsage!.list(workspaceId, 10)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      receiptKey: harness.providerRequestId,
      actionId,
      settlementStatus: 'pending_cost',
      lastError: { code: 'MODEL_USAGE_COST_MISSING' },
    })
    expect(rows[0]).not.toHaveProperty('costCny')
    expect(harness.refundCalls).toBe(0)
  })

  it('marks a costed provider receipt settled after included-quota settlement succeeds', async () => {
    const workspaceId = `ws_settled_${Date.now()}`
    const actionId = `model:settled-${Date.now()}`
    harness.costCny = 0.02
    await authorizeAction(workspaceId, actionId, 'included_quota')

    await expect(generate(workspaceId, actionId)).resolves.toMatchObject({ title: '结算测试标题' })

    const rows = await harness.modelUsage!.list(workspaceId, 10)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ receiptKey: harness.providerRequestId, actionId, costCny: 0.02, settlementStatus: 'settled' })
    expect(await harness.actionLedger!.get(workspaceId, actionId)).toMatchObject({ settlement: 'included_quota', settlementStatus: 'settled' })
    expect(harness.walletSettlementCalls).toBe(0)
    expect(harness.refundCalls).toBe(0)
  })

  it('keeps a costed receipt pending_wallet and does not refund when wallet settlement fails', async () => {
    const workspaceId = `ws_pending_wallet_${Date.now()}`
    const actionId = `model:pending-wallet-${Date.now()}`
    harness.costCny = 0.03
    await authorizeAction(workspaceId, actionId, 'wallet')

    await expect(generate(workspaceId, actionId)).rejects.toMatchObject({
      code: 'MODEL_USAGE_SETTLEMENT_PENDING',
      details: expect.objectContaining({ provider_succeeded: true, receipt_key: harness.providerRequestId }),
    })

    const rows = await harness.modelUsage!.list(workspaceId, 10)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      receiptKey: harness.providerRequestId,
      actionId,
      costCny: 0.03,
      settlementStatus: 'pending_wallet',
      lastError: { code: 'MODEL_USAGE_WALLET_SETTLEMENT_FAILED', message: 'billing debit not found' },
    })
    expect(await harness.actionLedger!.get(workspaceId, actionId)).toMatchObject({ state: 'settled', settlementStatus: 'pending_receipt' })
    expect(harness.walletSettlementCalls).toBe(0)
    expect(harness.refundCalls).toBe(0)
  })

  it('blocks a repeated provider action while its durable settlement is pending', async () => {
    const workspaceId = `ws_repeat_block_${Date.now()}`
    const actionId = `model:repeat-block-${Date.now()}`
    await authorizeAction(workspaceId, actionId, 'wallet')

    await expect(api.assertProviderActionCanStart(workspaceId, actionId)).rejects.toMatchObject({
      code: 'MODEL_ACTION_ALREADY_STARTED',
      status: 409,
      details: { settlement_status: 'authorized' },
    })
    expect(harness.modelCalls).toBe(0)
  })

  it('does not hide a later business validation behind a released provider action', async () => {
    const workspaceId = `ws_released_retry_${Date.now()}`
    const actionId = `model:released-retry-${Date.now()}`
    await authorizeAction(workspaceId, actionId, 'wallet')
    await harness.actionLedger!.refund({ workspaceId, actionKey: actionId, reason: 'provider 调用前失败' })

    await expect(api.assertProviderActionCanStart(workspaceId, actionId)).resolves.toBeUndefined()
  })

  it('replays the same provider receipt idempotently without a second settlement or ledger row', async () => {
    const workspaceId = `ws_replay_${Date.now()}`
    const actionId = `model:replay-${Date.now()}`
    harness.costCny = 0.04

    await expect(generate(workspaceId, actionId)).resolves.toBeDefined()
    await expect(generate(workspaceId, actionId)).resolves.toBeDefined()

    const rows = await harness.modelUsage!.list(workspaceId, 10)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ receiptKey: harness.providerRequestId, settlementStatus: 'settled', revision: 2 })
    expect(harness.modelCalls).toBe(2)
    expect(harness.walletSettlementCalls).toBe(0)
    expect(harness.refundCalls).toBe(0)
  })
})
