import { describe, expect, it } from 'vitest'
import { createFakeConnector } from './index.js'

describe('social commerce fixture connectors', () => {
  it.each(['xiaohongshu', 'douyin'] as const)('supports social store authorization, sync and draft validation', async platform => {
    const connector = createFakeConnector(platform, { configured: true, allowFakeWrites: true })
    const authorization = await connector.authorize({ workspaceId: 'ws_social', actorId: 'actor', redirectUri: 'https://merchant.test/callback', state: 'state' })
    expect(authorization.mode).toBe('fixture')
    const page = await connector.syncProducts({ workspaceId: 'ws_social', accountId: platform + '-account' })
    expect(page.simulated).toBe(true)
    expect(page.items[0]?.remoteId).toContain(platform === 'xiaohongshu' ? 'XHS' : 'DY')
    expect(connector.validateWrite({ fields: { title: '新商品', category: '服饰', price: 169, stock: 10 }, idempotencyKey: 'social-1' })).toEqual([])
  })
})
