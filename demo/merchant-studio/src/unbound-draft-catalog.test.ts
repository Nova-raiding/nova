import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { UnboundDraftCatalog } from './App'
import { catalogUnboundDraftProducts, buildCatalogPlatforms } from './catalog-data'
import type { Product } from './api'
const draft = { id: 'qa-blue', platform: 'taobao', title: '蓝色QA袋', stock: 0, skuCount: 0, price: 0, factsConfirmed: false, sourceAssetIds: ['asset-blue'], attributes: { unknown_facts: '材质尺寸库存均未知', source_sha256: 'source-hash', visual_observation: '蓝色袋体' } } as Product
const render = (products: Product[] | null, selectedProductId: string | null = null) => renderToStaticMarkup(createElement(UnboundDraftCatalog, { products, selectedProductId, readNote: '商品读取失败', onSelectProduct: () => {}, onBack: () => {}, onOpenKnowledge: () => {} }))
describe('unbound draft catalog navigation and honest readback', () => {
  it('keeps unread distinct from an empty successful read', () => {
    expect(catalogUnboundDraftProducts(null, 'taobao')).toBeNull()
    expect(render(null)).toContain('商品读取失败')
    expect(render(null)).not.toContain('当前平台尚无')
    expect(render([])).toContain('当前平台尚无未绑定草稿')
  })
  it('selects only the chosen platform and missing account identity', () => {
    const rows = [draft, {...draft,id:'bound',accountId:'store'}, {...draft,id:'other',platform:'jd'} as Product, {...draft,id:'blank',accountId:'  '}]
    expect(catalogUnboundDraftProducts(rows,'taobao')?.map(p=>p.id)).toEqual(['qa-blue','blank'])
    expect(buildCatalogPlatforms([],rows)).toEqual([]) // no artificial stores/platform accounts
  })
  it('shows persisted product identity and confirmed-fact status without claiming knowledge readiness', () => {
    expect(render([draft])).toContain('蓝色QA袋')
    expect(render([draft])).toContain('待确认')
    const html=render([{...draft,factsConfirmed:true}],draft.id)
    expect(html).toContain('已确认');expect(html).toContain('知识审核、权益和索引状态需另行核验')
    expect(html).toContain('不可同步或发布')
  })
  it('preserves source and unknown observations without promoting shell defaults', () => {
    const html=render([draft],draft.id)
    for (const text of ['材质尺寸库存均未知','source-hash','蓝色袋体','asset-blue']) expect(html).toContain(text)
    expect(html).not.toContain('库存 0');expect(html).not.toContain('¥');expect(html).not.toContain('视频播放')
    expect(html).toContain('前往素材库核对资料')
  })
  it('does not invent missing attributes or sources', () => {
    const html=render([{...draft,attributes:undefined,sourceAssetIds:[]}],draft.id)
    expect(html).toContain('未提供手工资料');expect(html).toContain('尚未记录来源素材')
  })
  it('connects the entry and existing knowledge navigation without a new route or store', () => {
    const source=readFileSync(new URL('./App.tsx',import.meta.url),'utf8')
    expect(source).toContain('if (showUnboundDrafts) return <UnboundDraftCatalog')
    expect(source).toContain('aria-label="未绑定草稿入口"')
    expect(source).toContain("onOpenKnowledge={() => navigateTo('products', { entry: 'knowledge' })}")
  })
})
