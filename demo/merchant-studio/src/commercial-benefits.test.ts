import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CommercialBenefitSnapshot, commercialBenefitName, commercialBenefitValue, commercialBenefitsSummary } from './CommercialBenefits'

const frozenBenefits = [
  { code: 'feature.image_generation', quantity: 1 },
  { code: 'feature.publish', quantity: 0 },
  { code: 'monthly_creative_points', quantity: 5000, rawUnit: 'point', rawValue: null },
]

describe('commercial benefit snapshots use registered names and preserve source facts', () => {
  it('renders included and excluded registered features in plain Chinese', () => {
    expect(commercialBenefitName('feature.image_generation')).toBe('图片生成与编辑')
    expect(commercialBenefitValue(frozenBenefits[0])).toBe('包含')
    expect(commercialBenefitValue(frozenBenefits[1])).toBe('不包含')
    expect(commercialBenefitsSummary(frozenBenefits)).toBe('图片生成与编辑：包含；发布：不包含；每期套餐创意点：5000点')
  })

  it('keeps permission uncertainty explicit and does not leak unknown feature codes into the summary', () => {
    expect(commercialBenefitValue({ code: 'feature.future', quantity: null })).toBe('权限待核实')
    expect(commercialBenefitsSummary([{ code: 'feature.future', quantity: null }])).toBe('未登记功能权限：权限待核实')
  })

  it('labels normalized storage bytes accurately when a friendly raw quantity is unavailable', () => {
    expect(commercialBenefitValue({ code: 'cloud_storage', quantity: null, rawValue: null, rawUnit: 'GB_DECIMAL', normalizedValue: 1000000000 })).toBe('1000000000字节')
  })

  it('shows the exact frozen benefit source in an expandable raw snapshot', () => {
    const html = renderToStaticMarkup(createElement(CommercialBenefitSnapshot, { benefits: frozenBenefits }))
    const visibleSummary = html.split('<details>')[0]
    expect(visibleSummary).toContain('图片生成与编辑：包含')
    expect(visibleSummary).toContain('发布：不包含')
    expect(visibleSummary).not.toContain('feature.image_generation')
    expect(html).toContain('feature.image_generation')
    expect(html).toContain('&quot;quantity&quot;: 1')
  })
})
