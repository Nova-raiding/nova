import { describe, expect, it } from 'vitest'
import { MemoryOperationsRepository } from './operations-repository.js'
import { MemoryWorkspaceContentSetupRepository } from './workspace-content-setup-repository.js'

describe('MemoryWorkspaceContentSetupRepository', () => {
  it('persists the merchant-confirmed name and store scope with an audit event', async () => {
    const operations = new MemoryOperationsRepository()
    const repository = new MemoryWorkspaceContentSetupRepository(operations)
    expect(await repository.get('ws_merchant')).toBeUndefined()
    const first = await repository.confirm({ workspaceId: 'ws_merchant', displayName: '旗舰店内容工作区', platform: 'taobao', accountId: 'shop-1', actorId: 'owner-1' })
    expect(await repository.get('ws_merchant')).toEqual(first)
    expect((await operations.list('ws_merchant'))[0]).toMatchObject({ action: 'workspace.content_setup.confirm', actorId: 'owner-1', before: {}, after: { displayName: '旗舰店内容工作区', platform: 'taobao', accountId: 'shop-1' } })
    await repository.confirm({ workspaceId: 'ws_merchant', displayName: '品牌内容工作区', platform: 'tmall', accountId: 'shop-2', actorId: 'owner-1' })
    expect((await operations.list('ws_merchant'))[0]).toMatchObject({ before: { displayName: '旗舰店内容工作区' }, after: { displayName: '品牌内容工作区' } })
    expect(await repository.get('ws_other')).toBeUndefined()
  })
})
