import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CommercialPlanComparison, comparisonBenefitValue } from './CommercialPlanComparison'
import { normalizeCommercialCatalog, type CommercialCatalogItem } from './api'

const catalog = normalizeCommercialCatalog({ status: 'available', catalog: [1, 2, 3].map((rank, index) => ({ id: `sku-${rank}`, code: `approved-${rank}`, name: ['基础版', '成长版', '尊享版'][index], kind: 'monthly', version: 2, lifecycle: 'approved', executable: true, saleState: 'on_sale', priceFen: [200000, 500000, 1000000][index], payload: { name: ['基础版', '成长版', '尊享版'][index], planFamily: 'approved-family', tierRank: rank, cycle: { unit: 'month', count: 1 } }, benefits: [{ code: 'monthly_creative_points', quantity: [5000, 12500, 26000][index], rawUnit: 'point' }, { code: 'cloud_storage', quantity: rank * 1000000000, rawValue: String(rank), rawUnit: 'GB_DECIMAL' }, { code: 'feature.image_generation', quantity: rank > 1 ? 1 : 0, rawUnit: 'permission' }] })) }).catalog
describe('three-tier comparison uses approved rows as facts', () => {
  it('keeps family/rank from server payload and renders rights as rows with actual tier amounts', () => {
    expect(catalog[0]).toMatchObject({ plan_family: 'approved-family', tier_rank: 1 })
    const html = renderToStaticMarkup(createElement(CommercialPlanComparison, { catalog }))
    expect(html).toContain('每期套餐创意点')
    expect(html).toContain('图片生成与编辑')
    expect(html).toContain('¥2000.00')
    expect(html).toContain('¥5000.00')
    expect(html).toContain('¥10000.00')
    expect(html).toContain('26000点')
    expect(html).toContain('3GB')
    expect(html).toContain('不包含')
    expect(html).toContain('包含')
    expect(html).toContain('开通费用与首期套餐分别计费')
  })
  it('does not fill a missing or ambiguous premium with guessed rights or price', () => {
    const missing = renderToStaticMarkup(createElement(CommercialPlanComparison, { catalog: catalog.slice(0, 2) }))
    expect(missing).toContain('尊享版')
    expect(missing).toContain('未上架或版本待核实')
    expect(missing).not.toContain('26000点')
    expect(missing).not.toContain('¥10000.00')
    const ambiguous = renderToStaticMarkup(createElement(CommercialPlanComparison, { catalog: [...catalog, { ...catalog[2], sku_code: 'another-premium' }] }))
    expect(ambiguous).not.toContain('26000点')
  })
  it('does not label absent rights as zero or unverified permission as included', () => {
    expect(comparisonBenefitValue(undefined)).toBe('未列入此批准版本')
    expect(comparisonBenefitValue({ code: 'feature.image_generation', quantity: null, raw_value: 'true', raw_unit: 'permission' })).toBe('权限待核实')
    expect(renderToStaticMarkup(createElement(CommercialPlanComparison, { catalog: [{ ...catalog[0], approval_state: 'draft' } as CommercialCatalogItem] }))).toContain('当前不能构造三档可购对比')
  })
})
