import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { ModelUsageRecord } from '../../../packages/persistence/src/model-usage-repository.js'

const state = vi.hoisted(() => ({ generated: false }))
vi.mock('../../../packages/persistence/src/index.js', async original => {
  const actual = await original<typeof import('../../../packages/persistence/src/index.js')>()
  class Usage extends actual.MemoryModelUsageRepository {
    override async listByAction(workspaceId: string, actionId: string): Promise<ModelUsageRecord[]> {
      if (!state.generated) return []
      return [0, 1].map(index => ({ id: `receipt-${index}`, receiptKey: `receipt-${index}`, receiptHash: `hash-${index}`, workspaceId, actionId, modality: 'text', model: 'test-model', providerRequestId: `provider-${index}`, inputTokens: index ? 470 : 358, outputTokens: index ? 1870 : 1707, totalTokens: index ? 2340 : 2065, costCny: index ? 0.000710 : 0.000642, settlementStatus: 'settled', attemptCount: 1, revision: 1, observedAt: `2026-10-05T01:53:${index ? '41' : '20'}Z` }))
    }
  }
  return { ...actual, MemoryModelUsageRepository: Usage }
})
vi.mock('../../../packages/ai/src/generator.js', async original => {
  const actual = await original<typeof import('../../../packages/ai/src/generator.js')>()
  return { ...actual, createContentGeneratorFromEnv: () => ({ generate: async () => {
    state.generated = true
    return { title: '创意标题', detail: '待商家确认的文案方向', sellingPoints: ['待确认的表达方向'], brief: { platform: 'general', placement: '预览', targetDimensions: '按目标平台版位规范配置，未配置时由设计确认', visualHierarchy: ['主题'], productImageGuidance: '待确认素材', logoSafety: '待确认', headline: '创意标题', subheadline: '待确认', coreSellingPoint: '待确认', cta: '了解更多', textDensity: '低', safeArea: '待确认', protectedAreas: ['商品主体'] } }
  } }) }
})
let api: typeof import('./server.js')
let base: string
beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('AI_MODEL', 'test-model')
  api = await import('./server.js')
  await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
  const address = api.server.address()
  if (!address || typeof address === 'string') throw new Error('missing HTTP address')
  base = `http://127.0.0.1:${address.port}`
})
afterAll(async () => {
  if (api?.server.listening) await new Promise<void>(resolve => api.server.close(() => resolve()))
  vi.unstubAllEnvs()
})
it('projects all repair receipts through the real MCP HTTP draft response', async () => {
  const workspaceId = 'ws_http_evidence_aggregation'
  await api.grantCreativePointsForTests(workspaceId, 5)
  api.grantContinuousFeatureEntitlementForTests(workspaceId)
  const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'content.draft.generate', params: { draft: 'true', idempotency_key: 'aggregate-http', draft_title: '创意主题' } }) })
  const body = await response.json()
  expect(body.error).toBeNull()
  expect(response.status).toBe(200)
  expect(body.data.result.execution).toMatchObject({ providerExecuted: true, settlementStatus: 'settled', providerRequestId: 'provider-1', providerRequestIds: ['provider-1', 'provider-0'], providerRequestCount: 2, costCny: 0.001352, usage: { inputTokens: 828, outputTokens: 3577, totalTokens: 4405 } })
})
