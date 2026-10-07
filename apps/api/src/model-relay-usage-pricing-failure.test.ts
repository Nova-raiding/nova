import { describe, expect, it, vi } from 'vitest'
import type { RelayUsageRecord } from '../../../packages/ai/src/relay-usage.js'
import { createRelayUsageRuntime, type RelayUsageRuntimeDependencies } from './model-relay-usage-runtime.js'

describe('relay usage pricing failure', () => {
  it('records video usage as pending cost and raises an alert when pricing lookup fails', async () => {
    const recordUsage = vi.fn(async () => ({ id: 'usage-pending-cost', revision: 1, settlementStatus: 'pending_cost' }))
    const resolveUsage = vi.fn()
    const upsertAlert = vi.fn(async (alert: unknown) => ({ ...alert as object, id: 'alert-cost-missing' }))
    const persistAlertNotification = vi.fn(async () => undefined)
    const usage = {
      workspaceId: 'ws_video_pricing_failure',
      modality: 'video',
      model: 'video-relay-model',
      providerRequestId: 'provider-video-request-1',
      providerAttemptId: 'video-attempt-1',
      inputTokens: 12,
      outputTokens: 4,
      totalTokens: 16,
      observedAt: '2026-10-07T10:00:00.000Z',
    } satisfies RelayUsageRecord
    const persistence = {
      modelUsage: { record: recordUsage, resolve: resolveUsage },
      alerts: { upsert: upsertAlert },
    }
    const deps = {
      isProduction: () => false,
      persistenceReady: async () => undefined,
      persistence: () => persistence,
      memoryCommercialExtensions: () => ({ getModelMarkupPolicy: async () => ({ multiplier: 1, revision: 7 }) }),
      memoryAlerts: () => ({ upsert: upsertAlert }),
      relayPricing: {
        quote: vi.fn(async () => { throw Object.assign(new Error('pricing snapshot unavailable'), { code: 'RELAY_PRICING_UNAVAILABLE' }) }),
      },
      getActionLedgerWithHistoricalImageCompat: vi.fn(),
      persistOperationalAlertNotification: persistAlertNotification,
      modelBillingReservations: () => new Map(),
      recordActionSettlement: vi.fn(),
      settlePluginWalletDebit: vi.fn(),
      settleLegacyRmbProviderUsage: vi.fn(),
    } as unknown as RelayUsageRuntimeDependencies

    const { recordRelayUsage } = createRelayUsageRuntime(deps)

    await expect(recordRelayUsage(usage)).rejects.toMatchObject({ code: 'MODEL_USAGE_COST_MISSING' })

    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      receiptKey: 'provider-video-request-1',
      workspaceId: usage.workspaceId,
      modality: 'video',
      model: usage.model,
      providerRequestId: usage.providerRequestId,
      settlementStatus: 'pending_cost',
      lastError: { code: 'RELAY_PRICING_UNAVAILABLE', message: 'pricing snapshot unavailable' },
      metadata: { provider_attempt_id: usage.providerAttemptId, settlement_reason: 'RELAY_PRICING_UNAVAILABLE' },
    }))
    expect(upsertAlert).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: usage.workspaceId,
      alertKey: 'model-cost-missing:provider-video-request-1',
      code: 'RELAY_PRICING_UNAVAILABLE',
      severity: 'high',
      entityType: 'model_usage',
      entityId: 'usage-pending-cost',
      evidence: expect.objectContaining({ provider_request_id: usage.providerRequestId }),
    }))
    expect(resolveUsage).not.toHaveBeenCalled()
    expect(deps.settlePluginWalletDebit).not.toHaveBeenCalled()
    expect(deps.settleLegacyRmbProviderUsage).not.toHaveBeenCalled()
    expect(persistAlertNotification).toHaveBeenCalledWith(expect.objectContaining({ id: 'alert-cost-missing' }))
  })
})
