import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { request } from 'node:http'
import { createHmac } from 'node:crypto'

const harness = vi.hoisted(() => ({
  modelUsage: null as null | {
    record(input: Record<string, unknown>): Promise<Record<string, unknown> & { id: string; revision: number }>
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

async function startApi() {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    api.server.once('error', onError)
    api.server.listen(0, '127.0.0.1', () => { api.server.removeListener('error', onError); resolve() })
  })
  const address = api.server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

async function callMcp(base: string, workspaceId: string, method: string, params: Record<string, unknown>) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { workspace_id: workspaceId, ...params } })
  return new Promise<{ data: { result?: Record<string, unknown> } | null; error: { code: string; details?: Record<string, unknown> } | null }>((resolve, reject) => {
    const target = new URL('/mcp', base)
    const req = request(target, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-workspace-id': workspaceId, 'x-actor-id': 'finance-operator', 'x-role': 'finance' } }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch (error) { reject(error) }
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

async function postWorkerUsage(base: string, workspaceId: string, payload: Record<string, unknown>) {
  const body = JSON.stringify(payload)
  const path = '/v1/internal/model-usage'
  const signature = createHmac('sha256', 'worker-signing-test').update(`POST\n${path}\n${workspaceId}`).digest('hex')
  return new Promise<{ status: number; body: { data: unknown; error: { code: string } | null } }>((resolve, reject) => {
    const req = request(new URL(path, base), { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: 'Bearer worker-token-test', 'x-workspace-id': workspaceId, 'x-worker-workspace-signature': signature } }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => {
        try { resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }) }
        catch (error) { reject(error) }
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

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
  vi.stubEnv('WORKER_API_TOKEN', 'worker-token-test')
  vi.stubEnv('WORKER_API_SIGNING_SECRET', 'worker-signing-test')
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
  it('accepts an idempotent worker relay receipt through the internal settlement boundary', async () => {
    const workspaceId = `ws_worker_usage_${Date.now()}`
    const actionId = `model:generation:worker-${Date.now()}`
    const providerRequestId = `worker-relay-${Date.now()}`
    await authorizeAction(workspaceId, actionId, 'included_quota')
    const base = await startApi()
    try {
      const payload = { workspaceId, actionId, modality: 'text', model: 'relay-text', providerRequestId, inputTokens: 20, outputTokens: 8, totalTokens: 28, costCny: 0.04, observedAt: '2026-08-28T00:00:00.000Z', metadata: { context_hash: 'a'.repeat(64) } }
      const first = await postWorkerUsage(base, workspaceId, payload)
      const replay = await postWorkerUsage(base, workspaceId, payload)
      expect(first).toMatchObject({ status: 200, body: { error: null } })
      expect(replay).toMatchObject({ status: 200, body: { error: null } })
      const rows = await harness.modelUsage!.list(workspaceId, 10)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ receiptKey: providerRequestId, actionId, totalTokens: 28, costCny: 0.04, settlementStatus: 'settled', metadata: { context_hash: 'a'.repeat(64) } })
    } finally {
      await new Promise<void>(resolve => api.server.close(() => resolve()))
    }
  })

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

  it('returns authoritative decisions and requires reason plus evidence for manual resolution', async () => {
    const workspaceId = `ws_manual_resolution_${Date.now()}`
    const pending = await harness.modelUsage!.record({ workspaceId, modality: 'text', model: 'relay-text', providerRequestId: `req-manual-${Date.now()}`, settlementStatus: 'pending_cost' })
    const retryable = await harness.modelUsage!.record({ workspaceId, modality: 'text', model: 'relay-text', providerRequestId: `req-retry-${Date.now()}`, costCny: 0.02, customerChargeCny: 0.05, settlementStatus: 'pending_wallet' })
    vi.stubEnv('NODE_ENV', 'test')
    const base = await startApi()
    try {
      const reconciliation = await callMcp(base, workspaceId, 'billing.reconciliation', { limit: '10' })
      expect(reconciliation.error).toBeNull()
      expect(reconciliation.data?.result).toMatchObject({
        model_usage: {
          unsettled: expect.arrayContaining([
            expect.objectContaining({ id: pending.id, allowed_decisions: ['waive', 'manual_attention'] }),
            expect.objectContaining({ id: retryable.id, allowed_decisions: ['retry', 'manual_attention'] }),
          ]),
        },
      })

      const missingReason = await callMcp(base, workspaceId, 'billing.model-usage.resolve', { usage_id: pending.id, revision: String(pending.revision), decision: 'manual_attention', evidence_ref: 'ticket://OPS-100' })
      expect(missingReason.error?.code).toBe('INVALID_REQUEST')
      const missingEvidence = await callMcp(base, workspaceId, 'billing.model-usage.resolve', { usage_id: pending.id, revision: String(pending.revision), decision: 'manual_attention', reason: '等待财务人工核对' })
      expect(missingEvidence.error?.code).toBe('INVALID_REQUEST')

      const resolved = await callMcp(base, workspaceId, 'billing.model-usage.resolve', { usage_id: pending.id, revision: String(pending.revision), decision: 'manual_attention', reason: '等待财务人工核对', evidence_ref: 'ticket://OPS-100' })
      expect(resolved.error).toBeNull()
      expect(resolved.data?.result).toMatchObject({ settlement_status: 'manual_attention', allowed_decisions: ['waive'], resolution_reason: '等待财务人工核对', resolution_evidence_ref: 'ticket://OPS-100' })

      const repeated = await callMcp(base, workspaceId, 'billing.model-usage.resolve', { usage_id: pending.id, revision: String((resolved.data?.result as { revision: number }).revision), decision: 'manual_attention', reason: '重复转人工', evidence_ref: 'ticket://OPS-101' })
      expect(repeated.error).toMatchObject({ code: 'MODEL_USAGE_DECISION_NOT_ALLOWED', details: { settlement_status: 'manual_attention', allowed_decisions: ['waive'] } })

      const retried = await callMcp(base, workspaceId, 'billing.model-usage.resolve', { usage_id: retryable.id, revision: String(retryable.revision), decision: 'retry', reason: '钱包状态已人工核对，可安全重试', evidence_ref: 'ledger://wallet-check/100' })
      expect(retried.error).toBeNull()
      expect(retried.data?.result).toMatchObject({ settlement_status: 'settled', allowed_decisions: [], resolution_reason: '钱包状态已人工核对，可安全重试', resolution_evidence_ref: 'ledger://wallet-check/100' })
    } finally {
      await new Promise<void>(resolve => api.server.close(() => resolve()))
      vi.stubEnv('NODE_ENV', 'production')
    }
  })
})
