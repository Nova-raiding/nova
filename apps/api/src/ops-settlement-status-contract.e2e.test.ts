import { randomUUID } from 'node:crypto'
import { request } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ModelUsageRepository } from '../../../packages/persistence/src/model-usage-repository.js'
import { createWorkerRequestProof } from '../../../packages/security/src/worker-request-proof.js'

const harness = vi.hoisted(() => ({
  modelUsage: null as null | Pick<ModelUsageRepository, 'record' | 'reserveDailyBudget'>,
}))

vi.mock('../../../packages/persistence/src/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../packages/persistence/src/index.js')>()
  class CapturingModelUsageRepository extends actual.MemoryModelUsageRepository {
    constructor() {
      super()
      harness.modelUsage = this
    }
  }
  return { ...actual, MemoryModelUsageRepository: CapturingModelUsageRepository }
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

async function callMcp(base: string, workspaceId: string, method: string, params: Record<string, unknown>, role = 'finance') {
  const body = JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params: { workspace_id: workspaceId, ...params } })
  return new Promise<{ data: { result?: Record<string, unknown> } | null; error: { code: string } | null }>((resolve, reject) => {
    const req = request(new URL('/mcp', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-workspace-id': workspaceId, 'x-actor-id': 'settlement-contract-test', 'x-role': role },
    }, response => {
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
  return new Promise<{ status: number; body: { error: { code: string } | null } }>((resolve, reject) => {
    const req = request(new URL(path, base), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: 'Bearer worker-token-test', 'x-workspace-id': workspaceId, ...proof.headers },
    }, response => {
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

async function authorizeAction(workspaceId: string, actionId: string, runKey: string) {
  await api.actionLedgerForTests.record({
    workspaceId,
    actionKey: actionId,
    actionKind: 'model_text',
    settlement: 'included_quota',
    units: 1,
    amountFen: 0,
    actorId: 'settlement-contract-test',
    description: '模型生成调用',
    settlementStatus: 'authorized',
  })
  await harness.modelUsage!.reserveDailyBudget({
    workspaceId,
    reservationKey: actionId,
    runKey,
    modality: 'text',
    model: 'relay-text-test',
    estimateCny: 0.1,
    estimateVersion: 'contract-test-v1',
    dailyLimitCny: 10,
    runLimitCny: 1,
  })
}

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('VITEST', 'true')
  vi.stubEnv('PORT', '0')
  vi.stubEnv('CONNECTOR_FIXTURE_MODE', 'true')
  vi.stubEnv('WORKER_API_CREDENTIALS', JSON.stringify({ generation: { token: 'worker-token-test', signing_secret: 'worker-signing-test' } }))
  api = await import('./server.js')
  await api.persistenceReady
  if (api.server.listening) await new Promise<void>((resolve, reject) => api.server.close(error => error ? reject(error) : resolve()))
})

afterAll(async () => {
  if (api?.server.listening) await new Promise<void>(resolve => api.server.close(() => resolve()))
  vi.unstubAllEnvs()
})

describe('Ops settlement status API contract', () => {
  it('keeps settled, pending, and unknown worker outcomes in the existing Ops query shape across receipt replay', async () => {
    const workspaceId = `ws_ops_settlement_contract_${randomUUID()}`
    const settledActionId = `model:settled:${randomUUID()}`
    const settledRunKey = `run:settled:${randomUUID()}`
    const pendingActionId = `model:pending:${randomUUID()}`

    await api.enableCommercialFixtureHarnessForTests()
    await api.grantCreativePointsForTests(workspaceId)
    await authorizeAction(workspaceId, settledActionId, settledRunKey)

    const pendingAction = await api.actionLedgerForTests.record({
      workspaceId,
      actionKey: pendingActionId,
      actionKind: 'model_text',
      settlement: 'wallet',
      units: 1,
      amountFen: 2,
      actorId: 'settlement-contract-test',
      description: '等待钱包结算的模型调用',
      settlementStatus: 'pending_receipt',
    })
    const pendingRunKey = `run:pending:${randomUUID()}`
    await harness.modelUsage!.reserveDailyBudget({
      workspaceId,
      reservationKey: pendingActionId,
      runKey: pendingRunKey,
      modality: 'text',
      model: 'relay-text-test',
      estimateCny: 0.1,
      estimateVersion: 'contract-test-v1',
      dailyLimitCny: 10,
      runLimitCny: 1,
    })
    const unknownActionId = `model:unknown:${randomUUID()}`
    await api.actionLedgerForTests.record({
      workspaceId,
      actionKey: unknownActionId,
      actionKind: 'model_text',
      settlement: 'wallet',
      units: 1,
      amountFen: 2,
      actorId: 'settlement-contract-test',
      description: 'Provider 结果未知，保留预留等待核对',
      providerRequestId: `provider-unknown:${randomUUID()}`,
      settlementStatus: 'pending_receipt',
    })
    expect(pendingAction.settlementStatus).toBe('pending_receipt')

    await harness.modelUsage!.record({
      workspaceId,
      actionId: pendingActionId,
      budgetReservationKey: pendingActionId,
      budgetRunKey: pendingRunKey,
      modality: 'text',
      model: 'relay-text-test',
      providerRequestId: `provider-pending:${randomUUID()}`,
      settlementStatus: 'pending_wallet',
      costCny: 0.02,
      customerChargeCny: 0.02,
      markupMultiplier: 1,
      pricingPolicyRevision: 1,
      lastError: { code: 'MODEL_USAGE_WALLET_SETTLEMENT_FAILED' },
    })

    vi.stubEnv('NODE_ENV', 'test')
    const base = await startApi()
    try {
      const receipt = {
        workspaceId,
        actionId: settledActionId,
        runKey: settledRunKey,
        modality: 'text',
        model: 'relay-text-test',
        providerRequestId: `provider-settled:${randomUUID()}`,
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
        costCny: 0.01,
        observedAt: '2026-09-25T00:00:00.000Z',
      }
      const firstReceipt = await postWorkerUsage(base, workspaceId, receipt)
      const replayedReceipt = await postWorkerUsage(base, workspaceId, receipt)
      expect(firstReceipt).toMatchObject({ status: 200, body: { error: null } })
      expect(replayedReceipt).toMatchObject({ status: 200, body: { error: null } })

      const summary = await callMcp(base, workspaceId, 'ops.model-usage.summary', { platform_scope: 'platform' }, 'platform_ops')
      expect(summary.error).toBeNull()
      const summaryResult = summary.data?.result
      expect(summaryResult).toMatchObject({
        scope: 'platform',
        recordCount: 2,
        unsettledRecordCount: 1,
        bySettlementStatus: { settled: 1, pending_wallet: 1 },
      })
      expect(summaryResult?.bySettlementStatus as Record<string, unknown> | undefined).not.toHaveProperty('unknown')

      const statement = await callMcp(base, workspaceId, 'billing.reconciliation', { limit: '20' })
      expect(statement.error).toBeNull()
      const statementResult = statement.data?.result
      expect(statementResult?.model_usage as Record<string, unknown> | undefined).toMatchObject({
        unsettled_records: 1,
        unsettled: [expect.objectContaining({ action_id: pendingActionId, settlement_status: 'pending_wallet' })],
      })
      const actionLedger = statementResult?.action_ledger as Record<string, unknown> | undefined
      expect(actionLedger?.by_kind_settlement_state as Record<string, unknown> | undefined).toMatchObject({
        'model_text:wallet:pending_receipt': 2,
      })
    } finally {
      await new Promise<void>((resolve, reject) => api.server.close(error => error ? reject(error) : resolve()))
      vi.stubEnv('NODE_ENV', 'production')
    }
  })
})
