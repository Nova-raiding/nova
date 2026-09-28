import { describe, expect, it } from 'vitest'
import { MerchantService } from './service.js'
import type { ContentGenerationInput } from '../../ai/src/generator.js'

describe('scoped brand task freeze', () => {
  it('passes the confirmed scope into the actual generation envelope and keeps its revision', async () => {
    let envelope: ContentGenerationInput | undefined
    const service = new MerchantService({
      fixtureMode: true,
      contentGenerator: { generate: async (input) => {
        envelope = input
        return { title: '已确认商品标题', detail: '只描述已确认商品事实。', sellingPoints: ['待审核表达'] }
      } },
    })
    const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao' })
    service.selectDirection(task.id, 'A', task.version)
    service.setScopedBrandForTask('ws_demo', task.id, {
      revision: 7,
      context: { accountId: 'store_1', seriesKey: 'series_1', assetId: 'asset_1' },
      values: { persona: '城市跑者', sellingPoints: '舒适轻盈的表达方向', color: '#123456' },
    })
    const confirmed = service.confirmProductionPlan('ws_demo', task.id, 'merchant', task.version)
    expect(confirmed.inputSnapshot?.scopedBrand).toMatchObject({ revision: 7, context: { seriesKey: 'series_1' }, values: { color: '#123456' } })
    expect(() => service.setScopedBrandForTask('ws_demo', task.id, null)).toThrowError(expect.objectContaining({ code: 'BRAND_SCOPE_FROZEN' }))
    await service.generateDraft(task.id)
    expect(envelope?.brandContext).toMatchObject({ revision: 7, accountId: 'store_1', seriesKey: 'series_1', assetId: 'asset_1', persona: '城市跑者', sellingPoints: '舒适轻盈的表达方向', color: '#123456' })
    expect(envelope?.brandVisualRules?.colors?.primary).toEqual(['#123456'])
  })
})
