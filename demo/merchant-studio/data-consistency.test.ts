import { describe, expect, it } from 'vitest'
import { resolveDataConsistency } from './src/data-consistency.js'

describe('merchant data consistency card', () => {
  it('does not claim rules or publishing are ready before their real server steps', () => {
    const items = resolveDataConsistency({ apiConfigured: true, productsLoaded: true, productCount: 2, accountsLoaded: true, accountsError: false, selectedCount: 2, productsWithIdentity: 2, productsWithAssets: 1 })
    expect(items.find(item => item.id === 'rules')).toMatchObject({ status: 'neutral', nextStep: '进入任务并等待规则检查结果' })
    expect(items.find(item => item.id === 'publish')).toMatchObject({ status: 'neutral', nextStep: '完成生成、审核和二次发布确认' })
  })

  it('surfaces a store identity failure as actionable instead of green', () => {
    expect(resolveDataConsistency({ apiConfigured: true, productsLoaded: true, productCount: 2, accountsLoaded: false, accountsError: true, selectedCount: 0, productsWithIdentity: 0, productsWithAssets: 0 })[0]).toMatchObject({ status: 'amber', detail: '店铺身份读取失败', nextStep: '重试店铺发现' })
  })
})
