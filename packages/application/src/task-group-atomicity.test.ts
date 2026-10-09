import { describe, expect, it } from 'vitest'
import { MerchantService } from './service.js'

describe('task group construction atomicity', () => {
  it('rolls back earlier task creations when a later group entry fails construction', () => {
    const service = new MerchantService({ seedFixture: false })
    const taobao = service.importProduct({ workspaceId: 'ws_group_partial', platform: 'taobao', title: '淘宝防晒衣', stock: 5 })
    const jd = service.importProduct({ workspaceId: 'ws_group_partial', platform: 'jd', title: '京东防晒衣', stock: 5 })
    const key = 'group-later-entry-failure'
    const invalidEntries = [
      { productId: taobao.id, platform: 'taobao' as const },
      { productId: jd.id, platform: 'jd' as const, canonicalProductId: 'canonical-without-listing' },
    ]

    expect(() => service.createTaskGroup({ workspaceId: 'ws_group_partial', entries: invalidEntries, idempotencyKey: key }))
      .toThrowError(expect.objectContaining({ code: 'CANONICAL_TASK_SCOPE_INCOMPLETE' }))
    expect(service.tasks.size).toBe(0)

    const retry = service.createTaskGroup({
      workspaceId: 'ws_group_partial',
      entries: [{ productId: taobao.id, platform: 'taobao' }, { productId: jd.id, platform: 'jd' }],
      idempotencyKey: key,
    })
    expect(retry.replayed).toBe(false)
    expect(retry.tasks).toHaveLength(2)
    expect(service.tasks.size).toBe(2)
  })
})
