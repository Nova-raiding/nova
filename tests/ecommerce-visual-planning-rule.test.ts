import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const sourceSkill = readFileSync(resolve(root, 'apps/plugin/skills/merchant-marketing/SKILL.md'), 'utf8')
const marketplaceSkill = readFileSync(resolve(root, '.codex-marketplace/plugins/merchant-marketing/skills/merchant-marketing/SKILL.md'), 'utf8')
const sourceBridge = readFileSync(resolve(root, 'apps/plugin/mcp/bridge.mjs'), 'utf8')
const marketplaceBridge = readFileSync(resolve(root, '.codex-marketplace/plugins/merchant-marketing/mcp/bridge.mjs'), 'utf8')

describe('e-commerce visual planning rule', () => {
  it('requires analysis before generating a full detail-image set', () => {
    expect(sourceSkill).toContain('拆解购买逻辑')
    expect(sourceSkill).toContain('六类图片')
    expect(sourceSkill).toContain('禁止编造')
    expect(sourceBridge).toContain('买家顾虑')
    expect(sourceBridge).toContain('六类图片方案')
    expect(sourceBridge).toContain('禁止编造')
    expect(sourceSkill).toContain('第一轮只输出面向商家的商品判断和图片方案，不调用图片生成')
    expect(sourceSkill).toContain('首屏利益图、核心参数图、结构细节图、使用场景图、稳定体验图、汇总收口图')
  })

  it('keeps the installable marketplace rule and bridge mirrors aligned', () => {
    expect(marketplaceSkill).toBe(sourceSkill)
    expect(marketplaceBridge).toBe(sourceBridge)
  })

  it('embeds the adapted open-source planning reference without adding a second generation path', async () => {
    const reference = readFileSync(resolve(root, 'apps/plugin/skills/merchant-marketing/references/ecommerce-detail-page-generator.md'), 'utf8')
    expect(reference).toContain('MCP、创意点、租户权限、人工审核和发布门禁')
    expect(reference).toContain('六类模块到大麦流程的映射')
    expect(reference).toContain('unconfirmed')
    expect(reference).toContain('不得调用宿主 `image_gen`')
    expect(reference).toContain('没有真实性 gate、人工审阅、内容审核和哈希校验')
    const mirrored = readFileSync(resolve(root, '.codex-marketplace/plugins/merchant-marketing/skills/merchant-marketing/references/ecommerce-detail-page-generator.md'), 'utf8')
    expect(mirrored).toBe(reference)
  })
})
