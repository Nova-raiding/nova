import { afterEach, expect, it, vi } from 'vitest'
import type { ModelUsageRepository } from '../../../packages/persistence/src/index.js'
vi.mock('../../../packages/ai/src/platform-model-gate.js', async original => ({ ...await original<typeof import('../../../packages/ai/src/platform-model-gate.js')>(), evaluatePlatformModelBudgetEstimate: () => ({ ready: true, amountCny: 1, version: 'test-v1', reasons: [] }), evaluatePlatformModelCostGate: () => ({ ready: true, dailyCnyLimit: 10, reasons: [] }), evaluatePlatformModelTaskRequestCost: () => ({ ready: true, limitCny: 2, reasons: [] }) }))
import { createModelBudgetRuntime } from './model-budget-runtime.js'
afterEach(() => vi.unstubAllEnvs())
it('keeps failed budget release in reconciliation rather than declaring safe preflight cleanup', async () => {
  vi.stubEnv('VIDEO_MODEL', 'test-model')
  const releaseError = new Error('injected release failure')
  const release = vi.fn(async () => { throw releaseError })
  const invoke = vi.fn()
  const runtime = createModelBudgetRuntime({ isProduction: () => true, requirePlatformModelCostGate: () => {}, ready: async () => {}, repository: () => ({ reserveDailyBudget: async () => ({}), releaseDailyBudget: release }) as unknown as ModelUsageRepository, recheckBeforeProvider: async () => { throw new Error('preflight rejected') }, providerSucceededButSettlementPending: error => (error as { reconciliationRequired?: boolean })?.reconciliationRequired === true })
  await expect(runtime.withDailyModelBudget('video', { workspaceId: 'ws', actionId: 'action', runKey: 'run' }, invoke)).rejects.toMatchObject({ message: 'injected release failure', reconciliationRequired: true })
  expect(release).toHaveBeenCalledTimes(1)
  expect(invoke).not.toHaveBeenCalled()
})
