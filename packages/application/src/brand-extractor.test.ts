import { describe, expect, it } from 'vitest'
import { extractBrandCandidates } from './brand-extractor.js'

describe('brand candidate extraction', () => {
  it('extracts structured and text fields with provenance and mandatory confirmation', () => {
    const result = extractBrandCandidates([
      { id: 'asset_manual', name: '品牌确认表.json', parseStatus: 'succeeded', extractedFactsSource: 'manual', extractedFacts: { 品牌名称: '云朵轻户外', 品牌调性: ['克制', '清晰'], 禁用词: '顶级、最强' } },
      { id: 'asset_guide', name: '品牌手册.pdf', parseStatus: 'succeeded', extractedFactsSource: 'parser', extractedFacts: { text: '品牌定位：城市轻户外\n目标人群：25-35 岁通勤用户\n品牌色：松石绿、米白' } },
    ], '2026-08-25T00:00:00.000Z')
    expect(result.fields.name).toMatchObject({ value: '云朵轻户外', confidence: 0.98, confirmationRequired: true, sources: [{ assetId: 'asset_manual', reference: '品牌名称' }] })
    expect(result.fields.positioning).toMatchObject({ value: '城市轻户外', confidence: 0.68, status: 'needs_confirmation' })
    expect(result.fields.colors?.value).toEqual(['松石绿', '米白'])
    expect(result.warnings).toContain('所有自动提取字段都必须由商家确认后才能写入品牌档案。')
  })

  it('surfaces conflicts instead of silently choosing one asset', () => {
    const result = extractBrandCandidates([
      { id: 'a1', name: '旧手册.json', parseStatus: 'succeeded', extractedFacts: { 品牌定位: '专业户外' } },
      { id: 'a2', name: '新手册.json', parseStatus: 'succeeded', extractedFacts: { 品牌定位: '城市轻户外' } },
      { id: 'a3', name: '未读取.png', parseStatus: 'pending' },
    ])
    expect(result.fields.positioning).toMatchObject({ status: 'conflict', alternatives: [{ value: '专业户外' }, { value: '城市轻户外' }] })
    expect(result.ignoredAssets).toEqual([{ assetId: 'a3', assetName: '未读取.png', reason: '素材尚未读取并确认' }])
    expect(result.warnings).toContain('不同素材存在冲突值，不能自动合并；请逐字段选择。')
  })
})
