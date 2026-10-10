import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')
const merchantSkill = read('apps/plugin/skills/merchant-marketing/SKILL.md')
const merchantPackaged = read('.codex-marketplace/plugins/merchant-marketing/skills/merchant-marketing/SKILL.md')
const imageSkill = read('apps/plugin/skills/ecommerce-image-workflow/SKILL.md')
const imagePackaged = read('.codex-marketplace/plugins/merchant-marketing/skills/ecommerce-image-workflow/SKILL.md')
const storyboardSkill = read('apps/plugin/skills/storyboard-prompt-assistant/SKILL.md')
const storyboardPackaged = read('.codex-marketplace/plugins/merchant-marketing/skills/storyboard-prompt-assistant/SKILL.md')
const pluginReadme = read('apps/plugin/README.md')
const marketplaceReadme = read('.codex-marketplace/plugins/merchant-marketing/README.md')

describe('Store Nova visual planning skills preserve product evidence and execution gates', () => {
  it('keeps source and packaged merchant visual workflows identical', () => {
    expect(merchantPackaged).toBe(merchantSkill)
    expect(imagePackaged).toBe(imageSkill)
    expect(storyboardPackaged).toBe(storyboardSkill)
    expect(marketplaceReadme).toBe(pluginReadme)
  })

  it('locks product identity and assigns every visual reference a bounded role', () => {
    expect(imageSkill).toContain('商品身份锁定')
    expect(imageSkill).toContain('参考素材角色')
    expect(imageSkill).toContain('商品实物依据')
    expect(imageSkill).toContain('风格参考')
    expect(imageSkill).toContain('场景参考')
    expect(imageSkill).toContain('不能把风格参考中的商品、Logo、文字、价格、认证、评价或场景关系当作当前商品事实')
  })

  it('routes whole-image optimization separately from local region editing', () => {
    expect(imageSkill).toContain('调整、重绘或重新编排整张画布时，走 `catalog.image.generate` 的 `mode=optimize`')
    expect(imageSkill).toContain('只要求修改明确指定的局部区域、并保持其余画面不变时，才走 `multimodal.image.edit`')
    expect(merchantSkill).toContain('仅修改指定区域且保持其余画面不变时，走下方 `multimodal.image.edit` 局部编辑路由')
    expect(merchantSkill).toContain('整图调整/重绘继续使用 `catalog.image.generate` 的 `mode=optimize`')
    expect(merchantSkill).toContain('不要把 `mode=optimize` 当作局部编辑入口')
  })

  it('requires continuous timing, shot-to-shot action anchors, and an explicit audio mode', () => {
    expect(storyboardSkill).toContain('Store Nova 商品分镜约束')
    expect(storyboardSkill).toContain('连续、不重叠、无空档的时间码')
    expect(storyboardSkill).toContain('前镜结束状态与后镜开场状态')
    expect(storyboardSkill).toContain('画面内人物说话、画外配音或无人声')
    expect(storyboardSkill).toContain('无人声时不得补入人声')
    expect(storyboardSkill).toContain('商品/SKU 身份锚点')
  })

  it('keeps planning text-only and routes all media execution back through Store Nova MCP', () => {
    expect(storyboardSkill).toContain('本节只产出可审阅文本，不生成参考图、视频或媒体文件')
    expect(storyboardSkill).toContain('实际媒体操作仍只通过 Merchant Marketing MCP')
    expect(imageSkill).toContain('实际上传、生成、查询和交付只通过')
    expect(imageSkill).toContain('不调用宿主图片工具、第三方 provider/API/CLI 或本地生成脚本')
    expect(pluginReadme).toContain('商品/SKU 身份锚点、参考素材角色')
  })
})
