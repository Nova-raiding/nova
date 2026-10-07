import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceContentSetupRepository } from '../../../packages/persistence/src/workspace-content-setup-repository.js'
import { handleWorkspaceContentSetupConfirm } from './mcp-workspace-setup-handlers.js'

const params = { display_name: '  品牌内容工作区  ', platform: 'taobao', account_id: 'store-a', workspace_id: 'ws-spoofed' }
const store = { platform: 'taobao', accountId: 'store-a', dataMode: 'official_api', readable: true, label: '已核验淘宝店' }
const dependencies = (overrides: Partial<Parameters<typeof handleWorkspaceContentSetupConfirm>[2]> = {}) => {
  const confirm = vi.fn(async (input: Parameters<WorkspaceContentSetupRepository['confirm']>[0]) => ({ ...input, confirmedAt: '2026-10-07T00:00:00.000Z' }))
  return {
    confirm,
    deps: {
      required: (input: Record<string, unknown>, key: string) => {
        const value = input[key]
        if (typeof value !== 'string') throw new Error(`Missing ${key}`)
        return value
      },
      principal: { actorId: 'authenticated-owner', memberRole: 'workspace_owner' as const, workbench: 'workspace' as const },
      stores: () => [store],
      actorId: () => 'authenticated-owner',
      repository: { get: vi.fn(), confirm } as unknown as WorkspaceContentSetupRepository,
      ...overrides,
    },
  }
}

describe('workspace content setup API tenant boundary', () => {
  it('persists only the route workspace and authenticated actor, not caller-supplied identity fields', async () => {
    const f = dependencies()
    const result = await handleWorkspaceContentSetupConfirm('ws-authenticated', params, f.deps)

    expect(f.confirm).toHaveBeenCalledWith({ workspaceId: 'ws-authenticated', displayName: '品牌内容工作区', platform: 'taobao', accountId: 'store-a', actorId: 'authenticated-owner' })
    expect(result).toMatchObject({ status: 'confirmed', store: { platform: 'taobao', label: '已核验淘宝店' } })
  })

  it('rejects non-owner membership before resolving input or touching persistence', async () => {
    const required = vi.fn(() => 'should-not-be-read')
    const f = dependencies({ principal: { actorId: 'workspace-operator', memberRole: 'operator', workbench: 'workspace' } as never, required })

    await expect(handleWorkspaceContentSetupConfirm('ws-a', params, f.deps)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
    expect(required).not.toHaveBeenCalled()
    expect(f.confirm).not.toHaveBeenCalled()
  })

  it.each([
    ['unverified store', { ...store, dataMode: 'fixture' }],
    ['non-readable store', { ...store, readable: false }],
    ['different account', { ...store, accountId: 'store-b' }],
    ['different platform', { ...store, platform: 'jd' }],
  ])('rejects %s without writing', async (_label, unavailableStore) => {
    const f = dependencies({ stores: () => [unavailableStore] as never })

    await expect(handleWorkspaceContentSetupConfirm('ws-a', params, f.deps)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
    expect(f.confirm).not.toHaveBeenCalled()
  })

  it.each([
    ['empty after normalization', ' \t '],
    ['control characters', 'brand\u0000name'],
    ['overlong name', 'x'.repeat(121)],
  ])('rejects %s before writing', async (_label, displayName) => {
    const f = dependencies()

    await expect(handleWorkspaceContentSetupConfirm('ws-a', { ...params, display_name: displayName }, f.deps)).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })
    expect(f.confirm).not.toHaveBeenCalled()
  })

  it('propagates repository failure instead of returning a confirmed state', async () => {
    const failure = Object.assign(new Error('database write failed'), { code: 'TEST_WRITE_FAILURE' })
    const f = dependencies({ repository: { get: vi.fn(), confirm: vi.fn().mockRejectedValue(failure) } as unknown as WorkspaceContentSetupRepository })

    await expect(handleWorkspaceContentSetupConfirm('ws-a', params, f.deps)).rejects.toBe(failure)
  })
})
