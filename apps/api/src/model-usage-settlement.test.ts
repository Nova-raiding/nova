import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { request } from 'node:http'
import type { ModelUsageRepository } from '../../../packages/persistence/src/model-usage-repository.js'
import { createWorkerRequestProof } from '../../../packages/security/src/worker-request-proof.js'

const harness = vi.hoisted(() => ({
  modelUsage: null as null | {
    record(input: Record<string, unknown>): Promise<Record<string, unknown> & { id: string; revision: number }>
    recordUsageAndSettleBudget(input: Record<string, unknown>): Promise<unknown>
    list(workspaceId: string, limit?: number): Promise<Array<Record<string, unknown>>>
    reserveDailyBudget(input: Record<string, unknown>): Promise<unknown>
    settleDailyBudget(input: Record<string, unknown>): Promise<unknown>
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
  budgetSettlements: [] as Array<Record<string, unknown>>,
  budgetReleases: [] as Array<Record<string, unknown>>,
}))

vi.mock('../../../packages/persistence/src/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../packages/persistence/src/index.js')>()

  class CapturingModelUsageRepository extends actual.MemoryModelUsageRepository {
    constructor() {
      super()
      harness.modelUsage = this as unknown as typeof harness.modelUsage
    }

    override async settleDailyBudget(input: Parameters<ModelUsageRepository['settleDailyBudget']>[0]) {
      harness.budgetSettlements.push({ ...input })
      return super.settleDailyBudget(input)
    }

    override async recordUsageAndSettleBudget(input: Parameters<ModelUsageRepository['recordUsageAndSettleBudget']>[0]) {
      harness.budgetSettlements.push({ workspaceId: input.workspaceId, reservationKey: input.budgetReservationKey, actualCostCny: input.costCny, providerRequestId: input.providerRequestId })
      return super.recordUsageAndSettleBudget(input)
    }

    override async releaseDailyBudget(input: Parameters<ModelUsageRepository['releaseDailyBudget']>[0]) {
      harness.budgetReleases.push({ ...input })
      return super.releaseDailyBudget(input)
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
  const proof = createWorkerRequestProof({ secret: 'worker-signing-test', role: 'generation', method: 'POST', requestTarget: path, workspaceId, body })
  return new Promise<{ status: number; body: { data: unknown; error: { code: string } | null } }>((resolve, reject) => {
    const req = request(new URL(path, base), { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: 'Bearer worker-token-test', 'x-workspace-id': workspaceId, ...proof.headers } }, response => {
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
  const factSourceId = 'product:usage-settlement:v1'
  return new Response(JSON.stringify({
    id: harness.providerRequestId,
    choices: [{ message: { content: JSON.stringify({
      title: '结算测试标题',
      detail: '只使用已确认商品事实的测试文案。',
      sellingPoints: ['事实可追溯'],
      modules: [{
        key: 'facts',
        title: '商品事实',
        purpose: '展示已确认商品事实',
        body: '只使用已确认商品事实的测试文案。',
        factSourceIds: [factSourceId],
        contentKind: 'fact',
        decisionContract: {
          buyerQuestion: '商品信息是否有事实依据？',
          pageTask: '展示可追溯的商品事实',
          claim: { text: '商品信息来自已确认事实', factSourceIds: [factSourceId], platforms: ['taobao'], limitations: ['仅用于模型用量结算回归'] },
          evidence: { type: 'parameter', sourceIds: [factSourceId], status: 'verified' },
          visualContract: { requiredElements: ['商品事实'], protectedElements: [], prohibitedImplications: ['不得编造未确认事实'], accessibilityText: '已确认商品事实' },
          priority: 1,
          optional: false,
        },
      }],
    }) } }],
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

async function authorizeAction(workspaceId: string, actionId: string, settlement: 'wallet' | 'included_quota' | 'entitlement', runKey = actionId) {
  await harness.actionLedger!.record({
    workspaceId,
    actionKey: actionId,
    actionKind: 'model_text',
    settlement,
    state: 'settled',
    units: 1,
    amountFen: settlement === 'entitlement' ? 0 : 1,
    actorId: 'settlement-test',
    description: '模型生成调用',
    reservedAmountFen: settlement === 'entitlement' ? 0 : 1,
    multiplier: 1,
    settlementStatus: 'authorized',
  })
  await harness.modelUsage!.reserveDailyBudget({ workspaceId, reservationKey: actionId, runKey, modality: 'text', model: 'relay-text-test', estimateCny: 1, estimateVersion: 'test-v1', dailyLimitCny: 100, runLimitCny: 10 })
}

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('VITEST', 'true')
  vi.stubEnv('PORT', '0')
  vi.stubEnv('CONNECTOR_FIXTURE_MODE', 'true')
  vi.stubEnv('MODEL_RELAY_BASE_URL', 'https://relay.example.test/v1')
  vi.stubEnv('MODEL_RELAY_ALLOWED_HOSTS', 'relay.example.test')
  vi.stubEnv('MODEL_RELAY_API_KEY', 'test-relay-key')
  vi.stubEnv('AI_MODEL', 'relay-text-test')
  vi.stubEnv('MODEL_RPM_LIMIT', '60')
  vi.stubEnv('MODEL_TPM_LIMIT', '120000')
  vi.stubEnv('MODEL_DAILY_CNY_LIMIT', '100')
  vi.stubEnv('MODEL_MAX_TASK_COST_CNY', '10')
  vi.stubEnv('MODEL_TEXT_MAX_REQUEST_CNY', '1')
  vi.stubEnv('MODEL_COST_ESTIMATE_VERSION', 'test-v1')
  vi.stubEnv('MODEL_RELAY_TEXT_COST_EVIDENCE', 'true')
  vi.stubEnv('WORKER_API_CREDENTIALS', JSON.stringify({ generation: { token: 'worker-token-test', signing_secret: 'worker-signing-test' } }))
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
  harness.budgetSettlements = []
  harness.budgetReleases = []
})

afterAll(async () => {
  if (api?.server.listening) await new Promise<void>(resolve => api.server.close(() => resolve()))
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('API model usage settlement invariants', () => {
  it('rejects a provider usage receipt without an action id', async () => {
    const workspaceId = `ws_worker_usage_missing_action_${Date.now()}`
    const base = await startApi()
    try {
      const response = await postWorkerUsage(base, workspaceId, { modality: 'text', model: 'relay-text', providerRequestId: `missing-action-${Date.now()}`, inputTokens: 1, outputTokens: 1, totalTokens: 2, costCny: 0.01 })
      expect(response).toMatchObject({ status: 400, body: { error: { code: 'INVALID_REQUEST' } } })
    } finally {
      await new Promise<void>(resolve => api.server.close(() => resolve()))
    }
  })

  it('rejects a provider usage receipt without a run key before settlement', async () => {
    const workspaceId = `ws_worker_usage_missing_run_${Date.now()}`
    const base = await startApi()
    try {
      const response = await postWorkerUsage(base, workspaceId, { workspaceId, actionId: `model:missing-run-${Date.now()}`, modality: 'text', model: 'relay-text', providerRequestId: `missing-run-${Date.now()}`, inputTokens: 1, outputTokens: 1, totalTokens: 2, costCny: 0.01 })
      expect(response).toMatchObject({ status: 400, body: { error: { code: 'INVALID_REQUEST' } } })
      expect(await harness.modelUsage!.list(workspaceId, 10)).toHaveLength(0)
    } finally {
      await new Promise<void>(resolve => api.server.close(() => resolve()))
    }
  })

  it('rejects a provider usage receipt whose action authorization does not exist', async () => {
    const workspaceId = `ws_worker_usage_unknown_action_${Date.now()}`
    const base = await startApi()
    try {
      const response = await postWorkerUsage(base, workspaceId, {
        workspaceId,
        actionId: `model:unknown-${Date.now()}`,
        runKey: `run:unknown-${Date.now()}`,
        modality: 'text',
        model: 'relay-text',
        providerRequestId: `unknown-action-${Date.now()}`,
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        costCny: 0.01,
      })
      expect(response).toMatchObject({ status: 409, body: { error: { code: 'MODEL_USAGE_ACTION_NOT_AUTHORIZED' } } })
      expect(await harness.modelUsage!.list(workspaceId, 10)).toHaveLength(0)
    } finally {
      await new Promise<void>(resolve => api.server.close(() => resolve()))
    }
  })

  it('accepts an idempotent worker relay receipt through the internal settlement boundary', async () => {
    const workspaceId = `ws_worker_usage_${Date.now()}`
    const actionId = `model:generation:worker-${Date.now()}`
    const runKey = `task:worker-${Date.now()}`
    const providerRequestId = `worker-relay-${Date.now()}`
    await authorizeAction(workspaceId, actionId, 'included_quota', runKey)
    const base = await startApi()
    try {
      const payload = { workspaceId, actionId, runKey, contextLinkId: 'context_link_worker', contextHash: 'a'.repeat(64), modality: 'text', model: 'relay-text', providerRequestId, inputTokens: 20, outputTokens: 8, totalTokens: 28, costCny: 0.04, observedAt: '2026-08-28T00:00:00.000Z' }
      const first = await postWorkerUsage(base, workspaceId, payload)
      const replay = await postWorkerUsage(base, workspaceId, payload)
      expect(first).toMatchObject({ status: 200, body: { error: null } })
      expect(replay).toMatchObject({ status: 200, body: { error: null } })
      const rows = await harness.modelUsage!.list(workspaceId, 10)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ receiptKey: providerRequestId, actionId, budgetRunKey: runKey, contextLinkId: 'context_link_worker', contextHash: 'a'.repeat(64), totalTokens: 28, costCny: 0.04, settlementStatus: 'settled' })
    } finally {
      await new Promise<void>(resolve => api.server.close(() => resolve()))
    }
  })

  it('blocks delivery when provider cost evidence is missing', async () => {
    const workspaceId = `ws_missing_cost_${Date.now()}`
    const actionId = `model:missing-cost-${Date.now()}`

    await expect(generate(workspaceId, actionId)).rejects.toMatchObject({ code: 'AI_GENERATION_FAILED' })

    expect(harness.refundCalls).toBe(0)
  })

  it('settles each repair-attempt receipt without reusing the original wallet authorization', async () => {
    const workspaceId = `ws_worker_repair_${Date.now()}`
    const actionId = `model:generation:repair-${Date.now()}`
    const firstReceipt = `worker-first-${Date.now()}`
    const repairReceipt = `worker-repair-${Date.now()}`
    await authorizeAction(workspaceId, actionId, 'wallet')
    vi.stubEnv('NODE_ENV', 'test')
    const base = await startApi()
    try {
      const common = { workspaceId, actionId, runKey: actionId, modality: 'text', model: 'relay-text', inputTokens: 20, outputTokens: 8, totalTokens: 28, costCny: 0.04, observedAt: '2026-08-28T00:00:00.000Z' }
      expect(await postWorkerUsage(base, workspaceId, { ...common, providerRequestId: firstReceipt })).toMatchObject({ status: 200, body: { error: null } })
      expect(await postWorkerUsage(base, workspaceId, { ...common, providerRequestId: repairReceipt })).toMatchObject({ status: 200, body: { error: null } })
    } finally {
      await new Promise<void>(resolve => api.server.close(() => resolve()))
      vi.stubEnv('NODE_ENV', 'production')
    }
    const rows = await harness.modelUsage!.list(workspaceId, 10)
    expect(rows).toHaveLength(2)
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerRequestId: firstReceipt, settlementStatus: 'settled' }),
      expect.objectContaining({ providerRequestId: repairReceipt, settlementStatus: 'settled' }),
    ]))
    expect(await harness.actionLedger!.get(workspaceId, actionId)).toMatchObject({ settlementStatus: 'settled', providerRequestId: firstReceipt })
    expect(await harness.actionLedger!.get(workspaceId, `model-usage:${repairReceipt}`)).toMatchObject({ settlement: 'wallet', settlementStatus: 'settled', providerRequestId: repairReceipt })
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
    expect(await harness.actionLedger!.get(workspaceId, actionId)).toMatchObject({ settlement: 'included_quota', amountFen: 0, settlementStatus: 'settled', providerRequestId: harness.providerRequestId })
    expect(rows[0]).toMatchObject({ customerChargeCny: 0 })
    expect(harness.walletSettlementCalls).toBe(1)
    expect(harness.refundCalls).toBe(0)
    expect(harness.budgetSettlements).toContainEqual(expect.objectContaining({ workspaceId, reservationKey: actionId, actualCostCny: 0.02, providerRequestId: harness.providerRequestId }))
  })

  it('settles entitlement-funded usage without creating a wallet charge', async () => {
    const workspaceId = `ws_entitlement_settled_${Date.now()}`
    const actionId = `image:entitlement-${Date.now()}`
    harness.costCny = 0.02
    await authorizeAction(workspaceId, actionId, 'entitlement')

    await expect(generate(workspaceId, actionId)).resolves.toMatchObject({ title: '结算测试标题' })

    const rows = await harness.modelUsage!.list(workspaceId, 10)
    expect(rows[0]).toMatchObject({ actionId, costCny: 0.02, customerChargeCny: 0, settlementStatus: 'settled' })
    expect(await harness.actionLedger!.get(workspaceId, actionId)).toMatchObject({ settlement: 'entitlement', amountFen: 0, settlementStatus: 'settled', providerRequestId: harness.providerRequestId })
    expect(harness.walletSettlementCalls).toBe(1)
    expect(harness.refundCalls).toBe(0)
  })

  it('supports image-addon action ids during model usage reconciliation with historical image settlement records', async () => {
    const workspaceId = `ws_image_addon_compat_${Date.now()}`
    const actionId = `image-addon:legacy-${Date.now()}`
    const fallbackActionId = `image:${actionId.slice('image-addon:'.length)}`
    const runKey = `task:${actionId}`
    const providerRequestId = `addon-receipt-${Date.now()}`
    await harness.modelUsage!.reserveDailyBudget({ workspaceId, reservationKey: actionId, runKey, modality: 'image', model: 'relay-image-test', estimateCny: 1, estimateVersion: 'test-v1', dailyLimitCny: 100, runLimitCny: 10 })
    await harness.actionLedger!.record({
      workspaceId,
      actionKey: fallbackActionId,
      actionKind: 'model_image',
      settlement: 'entitlement',
      state: 'settled',
      units: 1,
      amountFen: 0,
      actorId: 'settlement-test',
      description: '历史动作迁移兼容',
      reservedAmountFen: 0,
      multiplier: 1,
      settlementStatus: 'authorized',
    })
    const pending = await harness.modelUsage!.record({
      workspaceId,
      actionId,
      budgetReservationKey: actionId,
      budgetRunKey: runKey,
      modality: 'image',
      model: 'relay-image-test',
      providerRequestId,
      costCny: 0.02,
      markupMultiplier: 1,
      customerChargeCny: 0,
      pricingPolicyRevision: 1,
      settlementStatus: 'pending_wallet',
    })

    const base = await startApi()
    try {
      vi.stubEnv('NODE_ENV', 'test')
      const response = await callMcp(base, workspaceId, 'billing.model-usage.resolve', { usage_id: pending.id, revision: String(pending.revision), decision: 'retry', reason: '历史 key 兼容核验', evidence_ref: 'ledger://compat/1' })
      vi.stubEnv('NODE_ENV', 'production')
      expect(response.error).toBeNull()
      expect(response.data?.result).toMatchObject({ settlement_status: 'settled' })
      const rows = await harness.modelUsage!.list(workspaceId, 10)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ actionId, settlementStatus: 'settled', costCny: 0.02, customerChargeCny: 0 })
      expect(await harness.actionLedger!.get(workspaceId, fallbackActionId)).toMatchObject({ settlementStatus: 'settled', settlement: 'entitlement', providerRequestId })
      expect(await harness.actionLedger!.get(workspaceId, actionId)).toBeUndefined()
      expect(harness.walletSettlementCalls).toBe(1)
      expect(harness.refundCalls).toBe(0)
    } finally {
      vi.stubEnv('NODE_ENV', 'production')
      await new Promise<void>(resolve => api.server.close(() => resolve()))
    }
  })

  it('reconciles a pending entitlement receipt without falling back to wallet settlement', async () => {
    const workspaceId = `ws_entitlement_reconcile_${Date.now()}`
    const actionId = `image:entitlement-reconcile-${Date.now()}`
    const providerRequestId = `entitlement-provider-${Date.now()}`
    await authorizeAction(workspaceId, actionId, 'entitlement')
    const pending = await harness.modelUsage!.record({ workspaceId, actionId, budgetReservationKey: actionId, budgetRunKey: actionId, modality: 'text', model: 'relay-text-test', providerRequestId, costCny: 0.02, customerChargeCny: 0, markupMultiplier: 1, pricingPolicyRevision: 1, settlementStatus: 'pending_wallet' })

    vi.stubEnv('NODE_ENV', 'test')
    const base = await startApi()
    try {
      const result = await callMcp(base, workspaceId, 'billing.model-usage.resolve', { usage_id: pending.id, revision: String(pending.revision), decision: 'retry', reason: '权益授权与成本预算已核对', evidence_ref: 'ledger://entitlement-check/1' })
      expect(result.error).toBeNull()
      expect(result.data?.result).toMatchObject({ settlement_status: 'settled' })
    } finally {
      await new Promise<void>(resolve => api.server.close(() => resolve()))
      vi.stubEnv('NODE_ENV', 'production')
    }
    expect(await harness.actionLedger!.get(workspaceId, actionId)).toMatchObject({ settlement: 'entitlement', amountFen: 0, settlementStatus: 'settled', providerRequestId })
  })

  it('releases an active reservation when the provider invocation fails', async () => {
    const workspaceId = `ws_provider_failure_${Date.now()}`
    const actionId = `model:provider-failure-${Date.now()}`
    vi.mocked(fetch).mockRejectedValueOnce(new Error('relay unavailable'))
    await expect(generate(workspaceId, actionId)).rejects.toBeDefined()
    expect(harness.budgetReleases).toContainEqual(expect.objectContaining({ workspaceId, reservationKey: actionId }))
    expect(harness.budgetSettlements).toHaveLength(0)
  })

  it('keeps an actual-cost overrun durable and does not release it after provider success', async () => {
    const workspaceId = `ws_actual_overrun_${Date.now()}`
    const actionId = `model:actual-overrun-${Date.now()}`
    harness.costCny = 101
    await authorizeAction(workspaceId, actionId, 'included_quota')
    await expect(generate(workspaceId, actionId)).rejects.toMatchObject({ code: 'MODEL_TASK_COST_ACTUAL_EXCEEDED', details: expect.objectContaining({ provider_succeeded: true, reconciliation_required: true }) })
    expect(harness.budgetReleases).toHaveLength(0)
    await expect(harness.modelUsage!.settleDailyBudget({ workspaceId, reservationKey: actionId, actualCostCny: 101, providerRequestId: harness.providerRequestId })).rejects.toMatchObject({ code: 'MODEL_TASK_COST_ACTUAL_EXCEEDED' })
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

  it('never reuses a refunded provider action key', async () => {
    const workspaceId = `ws_released_retry_${Date.now()}`
    const actionId = `model:released-retry-${Date.now()}`
    await authorizeAction(workspaceId, actionId, 'wallet')
    await harness.actionLedger!.refund({ workspaceId, actionKey: actionId, reason: 'provider 调用前失败' })

    await expect(api.assertProviderActionCanStart(workspaceId, actionId)).rejects.toMatchObject({
      code: 'MODEL_ACTION_ALREADY_STARTED',
      details: { settlement_status: 'refunded' },
    })
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
