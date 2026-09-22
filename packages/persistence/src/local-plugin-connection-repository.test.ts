import { describe, expect, it } from 'vitest'
import { MemoryLocalPluginConnectionRepository } from './local-plugin-connection-repository.js'

describe('local plugin connection requests', () => {
  it('binds account, identity and workspace and consumes the request once', async () => {
    let now = Date.parse('2026-09-22T00:00:00Z')
    const repo = new MemoryLocalPluginConnectionRepository(() => now, 1_000)
    const request = await repo.create({ accountId: 'a1', identityId: 'i1', workspaceId: 'ws_1' })
    await expect(repo.authorize({ id: request.id, accountId: 'a1', identityId: 'i1', workspaceId: 'ws_other' })).rejects.toMatchObject({ code: 'LOCAL_PLUGIN_CONNECTION_INVALID' })
    await expect(repo.authorize({ id: request.id, accountId: 'a1', identityId: 'i1', workspaceId: 'ws_1' })).resolves.toMatchObject({ status: 'authorized' })
    await expect(repo.authorize({ id: request.id, accountId: 'a1', identityId: 'i1', workspaceId: 'ws_1' })).rejects.toMatchObject({ code: 'LOCAL_PLUGIN_CONNECTION_INVALID' })
    await expect(repo.markExchanged({ id: request.id, accountId: 'a1', workspaceId: 'ws_1' })).resolves.toMatchObject({ status: 'exchanged' })
    await expect(repo.markExchanged({ id: request.id, accountId: 'a1', workspaceId: 'ws_1' })).rejects.toMatchObject({ code: 'LOCAL_PLUGIN_CONNECTION_INVALID' })
    now += 5_000
    await expect(repo.getForAccount({ id: request.id, accountId: 'a1', workspaceId: 'ws_1' })).resolves.toMatchObject({ status: 'exchanged' })
  })

  it('expires pending requests fail closed', async () => {
    let now = 0
    const repo = new MemoryLocalPluginConnectionRepository(() => now, 10)
    const request = await repo.create({ accountId: 'a1', identityId: 'i1', workspaceId: 'ws_1' })
    now = 11
    await expect(repo.getForAccount({ id: request.id, accountId: 'a1', workspaceId: 'ws_1' })).resolves.toMatchObject({ status: 'expired' })
    await expect(repo.authorize({ id: request.id, accountId: 'a1', identityId: 'i1', workspaceId: 'ws_1' })).rejects.toMatchObject({ code: 'LOCAL_PLUGIN_CONNECTION_INVALID' })
  })

  it('supersedes the prior active request for the same account and workspace', async () => {
    const repo = new MemoryLocalPluginConnectionRepository()
    const first = await repo.create({ accountId: 'a1', identityId: 'i1', workspaceId: 'ws_1' })
    const second = await repo.create({ accountId: 'a1', identityId: 'i1', workspaceId: 'ws_1' })
    await expect(repo.getForAccount({ id: first.id, accountId: 'a1', workspaceId: 'ws_1' })).resolves.toMatchObject({ status: 'expired' })
    await expect(repo.getForAccount({ id: second.id, accountId: 'a1', workspaceId: 'ws_1' })).resolves.toMatchObject({ status: 'pending' })
  })
})
