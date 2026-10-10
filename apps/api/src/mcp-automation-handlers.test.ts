import { describe, expect, it, vi } from 'vitest'
import { handleMcpAutomationMethod } from './mcp-automation-handlers.js'

const harness = () => {
  const policies = new Map<string, any>()
  const savePolicy = vi.fn(async (policy: any) => { policies.set(`${policy.workspaceId}:${policy.platform ?? ''}:${policy.accountId ?? ''}`, policy) })
  const recordOperationAudit = vi.fn(async () => undefined)
  const deps = {
    policies,
    validateScope: vi.fn(),
    policyKey: (workspaceId: string, platform?: string, accountId?: string) => `${workspaceId}:${platform ?? ''}:${accountId ?? ''}`,
    normalizeTime: (value: string | undefined) => value,
    savePolicy,
    executeScan: vi.fn(async () => ({})),
    runTick: vi.fn(async () => ({})),
    workspaceStoreDirectory: () => [],
    isPlatformOperations: () => false,
    requireOperationsRole: () => 'operator',
    requiresStrictAuth: () => false,
    actorIdForRequest: () => 'operator-1',
    required: (params: Record<string, unknown>, key: string) => {
      if (typeof params[key] !== 'string' || !params[key]) throw new Error(`missing ${key}`)
      return params[key] as string
    },
    recordOperationAudit,
  }
  return { deps: deps as never, policies, savePolicy, recordOperationAudit }
}

describe('automation.policy.update MCP scope contract', () => {
  it('rejects sync enablement without an explicit store before saving or auditing', async () => {
    const test = harness()
    await expect(handleMcpAutomationMethod(
      'automation.policy.update',
      { enabled: 'true', sync_enabled: 'true', reason: 'test unscoped sync' },
      {} as never,
      'workspace-1',
      test.deps,
    )).rejects.toMatchObject({ code: 'AUTOMATION_SYNC_SCOPE_REQUIRED', status: 400 })
    expect(test.savePolicy).not.toHaveBeenCalled()
    expect(test.recordOperationAudit).not.toHaveBeenCalled()
  })

  it('persists the selected platform and account with sync_enabled=true', async () => {
    const test = harness()
    const result = await handleMcpAutomationMethod(
      'automation.policy.update',
      { platform: 'taobao', account_id: 'store-7', enabled: 'true', sync_enabled: 'true', reason: 'test scoped sync' },
      {} as never,
      'workspace-1',
      test.deps,
    ) as { policy: Record<string, unknown> }

    expect(result.policy).toMatchObject({ workspaceId: 'workspace-1', platform: 'taobao', accountId: 'store-7', enabled: true, syncEnabled: true })
    expect(test.savePolicy).toHaveBeenCalledWith(expect.objectContaining({ platform: 'taobao', accountId: 'store-7', syncEnabled: true }))
    expect(test.recordOperationAudit).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'workspace-1', action: 'automation.policy.update' }))
  })
})
