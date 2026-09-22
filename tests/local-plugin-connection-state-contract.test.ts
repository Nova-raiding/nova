import { describe, expect, it } from 'vitest'
import { MemoryLocalPluginConnectionRepository } from '../packages/persistence/src/local-plugin-connection-repository.js'

describe('local plugin one-click request state contract', () => {
  it('supports status polling from pending through authorized to exchanged', async () => {
    let now = Date.parse('2026-09-22T09:00:00.000Z')
    const repository = new MemoryLocalPluginConnectionRepository(() => now, 60_000)
    const created = await repository.create({ accountId: 'account_a', identityId: 'identity_a', workspaceId: 'ws_a' })

    await expect(repository.getForAccount({ id: created.id, accountId: 'account_a', workspaceId: 'ws_a' }))
      .resolves.toMatchObject({ status: 'pending' })
    now += 1_000
    await repository.authorize({ id: created.id, accountId: 'account_a', identityId: 'identity_a', workspaceId: 'ws_a' })
    await expect(repository.getForAccount({ id: created.id, accountId: 'account_a', workspaceId: 'ws_a' }))
      .resolves.toMatchObject({ status: 'authorized', authorizedAt: '2026-09-22T09:00:01.000Z' })
    now += 1_000
    await repository.markExchanged({ id: created.id, accountId: 'account_a', workspaceId: 'ws_a' })
    await expect(repository.getForAccount({ id: created.id, accountId: 'account_a', workspaceId: 'ws_a' }))
      .resolves.toMatchObject({ status: 'exchanged', exchangedAt: '2026-09-22T09:00:02.000Z' })
  })

  it('hides another account or workspace request and rejects workspace swapping', async () => {
    const repository = new MemoryLocalPluginConnectionRepository()
    const created = await repository.create({ accountId: 'account_a', identityId: 'identity_a', workspaceId: 'ws_a' })

    await expect(repository.getForAccount({ id: created.id, accountId: 'account_b', workspaceId: 'ws_a' })).resolves.toBeUndefined()
    await expect(repository.getForAccount({ id: created.id, accountId: 'account_a', workspaceId: 'ws_b' })).resolves.toBeUndefined()
    await expect(repository.authorize({ id: created.id, accountId: 'account_a', identityId: 'identity_a', workspaceId: 'ws_b' }))
      .rejects.toMatchObject({ code: 'LOCAL_PLUGIN_CONNECTION_INVALID' })
    await expect(repository.markExchanged({ id: created.id, accountId: 'account_a', workspaceId: 'ws_b' }))
      .rejects.toMatchObject({ code: 'LOCAL_PLUGIN_CONNECTION_INVALID' })
  })

  it('expires both pending and authorized requests and rejects replay', async () => {
    let now = 1_000
    const repository = new MemoryLocalPluginConnectionRepository(() => now, 10)
    const pending = await repository.create({ accountId: 'account_a', identityId: 'identity_a', workspaceId: 'ws_a' })
    const authorized = await repository.create({ accountId: 'account_a', identityId: 'identity_a', workspaceId: 'ws_a' })
    await repository.authorize({ id: authorized.id, accountId: 'account_a', identityId: 'identity_a', workspaceId: 'ws_a' })

    now = 1_011
    await expect(repository.getForAccount({ id: pending.id, accountId: 'account_a', workspaceId: 'ws_a' })).resolves.toMatchObject({ status: 'expired' })
    await expect(repository.getForAccount({ id: authorized.id, accountId: 'account_a', workspaceId: 'ws_a' })).resolves.toMatchObject({ status: 'expired' })
    await expect(repository.authorize({ id: pending.id, accountId: 'account_a', identityId: 'identity_a', workspaceId: 'ws_a' }))
      .rejects.toMatchObject({ code: 'LOCAL_PLUGIN_CONNECTION_INVALID' })
    await expect(repository.markExchanged({ id: authorized.id, accountId: 'account_a', workspaceId: 'ws_a' }))
      .rejects.toMatchObject({ code: 'LOCAL_PLUGIN_CONNECTION_INVALID' })
  })
})
