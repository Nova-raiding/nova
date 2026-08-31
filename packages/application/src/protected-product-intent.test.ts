import { describe, expect, it } from 'vitest'
import { validateProtectedProductIntent, type ProtectedProductAttribute } from './protected-product-intent.js'

describe('protected product intent validator', () => {
  it.each<[ProtectedProductAttribute, string, string]>([
    ['color', '把商品颜色改成蓝色', 'Change the product color to blue'],
    ['structure', '重塑产品结构并拉长轮廓', 'Reshape the product structure'],
    ['material', '把产品材质换成金属', 'Replace the product material with metal'],
    ['logo', '去掉包装上的 Logo', 'Remove the logo on the package'],
    ['packaging_text', '修改瓶身包装文字', 'Rewrite the text on the packaging'],
    ['certification_mark', '删除认证标识', 'Remove the certification mark'],
    ['accessories', '新增商品配件', 'Replace the product accessories'],
  ])('blocks %s mutation in Chinese and English', (attribute, chinese, english) => {
    for (const request of [chinese, english]) {
      const result = validateProtectedProductIntent(request)
      expect(result.allowed).toBe(false)
      expect(result.findings).toContainEqual(expect.objectContaining({ attribute, severity: 'error', code: `PROTECTED_PRODUCT_${attribute.toUpperCase()}_MUTATION` }))
    }
  })

  it('allows background, lighting and composition changes while returning immutable constraints', () => {
    const result = validateProtectedProductIntent('把背景颜色改成暖灰，调整光影和构图，增加留白')
    expect(result.allowed).toBe(true)
    expect(result.findings).toEqual([])
    expect(result.safeModifications.map(item => item.category)).toEqual(['background', 'lighting', 'composition'])
    expect(result.immutableConstraints.map(item => item.attribute)).toEqual(['color', 'structure', 'material', 'logo', 'packaging_text', 'certification_mark', 'accessories'])
    expect(result.promptConstraints.zh).toContain('保持商品本体颜色')
    expect(result.promptConstraints.en).toContain('Keep the product color')
  })

  it.each([
    '不要改变商品颜色、结构或材质，只调整背景光影',
    '保留包装文字和认证标识原样，优化构图',
    '请勿移除商品配件，也不要修改 Logo',
    'Do not change the product color, structure, or material; improve the lighting only',
    'Keep the packaging text and certification mark unchanged while adjusting the background',
    "Don't remove the original accessories or alter the product logo",
    'Change the background without changing the product color',
  ])('understands preservation and negation without a false positive: %s', request => {
    expect(validateProtectedProductIntent(request)).toMatchObject({ allowed: true, findings: [] })
  })

  it('still blocks an affirmative mutation next to a negated safe edit', () => {
    const result = validateProtectedProductIntent('不要改变背景，但是把商品颜色改成红色')
    expect(result.allowed).toBe(false)
    expect(result.findings).toEqual([expect.objectContaining({ attribute: 'color' })])
  })

  it.each([
    ['logo', '修改 Logo'],
    ['logo', 'Remove the logo'],
    ['packaging_text', '重写包装文案'],
    ['packaging_text', 'Rewrite the packaging copy'],
  ] satisfies Array<[ProtectedProductAttribute, string]>)('blocks context-light %s mutation: %s', (attribute, request) => {
    expect(validateProtectedProductIntent(request).findings).toContainEqual(expect.objectContaining({ attribute }))
  })

  it.each([
    'Change the background color and increase the lighting color temperature',
    '使用大理石材质的背景，保持商品不动',
    '裁切画面并改变相机视角，不修改产品',
    'Enhance the lighting, crop the frame, and use a blue backdrop',
  ])('does not confuse safe scene language with a product mutation: %s', request => {
    expect(validateProtectedProductIntent(request).allowed).toBe(true)
  })

  it('detects implicit product recoloring and reshaping without an explicit attribute noun', () => {
    expect(validateProtectedProductIntent('把商品改成红色').findings).toContainEqual(expect.objectContaining({ attribute: 'color' }))
    expect(validateProtectedProductIntent('Make the item blue').findings).toContainEqual(expect.objectContaining({ attribute: 'color' }))
    expect(validateProtectedProductIntent('把产品拉长一点').findings).toContainEqual(expect.objectContaining({ attribute: 'structure' }))
  })

  it.each<[ProtectedProductAttribute, string]>([
    ['color', '把鞋子改红'],
    ['material', '换成皮革'],
    ['accessories', '去掉配件'],
    ['packaging_text', '改包装字'],
  ])('fails closed for omitted product attribute %s: %s', (attribute, request) => {
    expect(validateProtectedProductIntent(request).findings).toContainEqual(expect.objectContaining({ attribute }))
  })

  it('detects protected attributes joined by Chinese enumeration punctuation', () => {
    const result = validateProtectedProductIntent('修改商品颜色、结构、材质、Logo 和配件')
    expect(result.findings.map(item => item.attribute)).toEqual(['color', 'structure', 'material', 'logo', 'accessories'])
  })

  it('detects protected attributes joined by English conjunctions', () => {
    const result = validateProtectedProductIntent('Change the product color and material and remove its accessories')
    expect(result.findings.map(item => item.attribute)).toEqual(['color', 'material', 'accessories'])
  })

  it.each([
    '不要不修改商品颜色',
    "Don't leave its color unchanged",
    '不要改背景，但把鞋子改红',
  ])('blocks double negation or an affirmative mutation after contrast: %s', request => {
    expect(validateProtectedProductIntent(request).allowed).toBe(false)
  })

  it.each([
    '不是要改商品颜色，而是只改背景',
    '并非要换产品材质，只是调整光影',
    'Not asking to change its color; adjust the scene instead',
  ])('allows explicitly rejected product mutations followed by a safe target: %s', request => {
    expect(validateProtectedProductIntent(request)).toMatchObject({ allowed: true, findings: [] })
  })

  it.each<[ProtectedProductAttribute, string]>([
    ['color', 'Make it red'],
    ['material', 'Turn it into leather'],
    ['structure', 'Alter its shape'],
    ['packaging_text', 'Rewrite its packaging text'],
    ['accessories', 'Remove its accessories'],
  ])('blocks English pronoun mutation of %s: %s', (attribute, request) => {
    expect(validateProtectedProductIntent(request).findings).toContainEqual(expect.objectContaining({ attribute }))
  })

  it.each([
    '把背景换成皮革质感',
    '把场景改成红色',
    'Remove accessories from the background scene',
    'Change the background material to wood',
  ])('keeps explicit scene and background targets allowed: %s', request => {
    expect(validateProtectedProductIntent(request).allowed).toBe(true)
  })

  it('returns deeply immutable policy output suitable for generation and local-edit prompts', () => {
    const result = validateProtectedProductIntent('adjust lighting only')
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.findings)).toBe(true)
    expect(Object.isFrozen(result.immutableConstraints)).toBe(true)
    expect(Object.isFrozen(result.immutableConstraints[0])).toBe(true)
    expect(Object.isFrozen(result.promptConstraints)).toBe(true)
  })
})
