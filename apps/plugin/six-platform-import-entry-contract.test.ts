import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const sourceMain = readFileSync(resolve(root, 'apps/plugin/skills/merchant-marketing/SKILL.md'), 'utf8')
const sourceImport = readFileSync(resolve(root, 'apps/plugin/skills/six-platform-public-import/SKILL.md'), 'utf8')
const mirrorMain = readFileSync(resolve(root, '.codex-marketplace/plugins/merchant-marketing/skills/merchant-marketing/SKILL.md'), 'utf8')
const mirrorImport = readFileSync(resolve(root, '.codex-marketplace/plugins/merchant-marketing/skills/six-platform-public-import/SKILL.md'), 'utf8')
const sourceImageGuide = readFileSync(resolve(root, 'apps/plugin/skills/merchant-marketing/references/product-image-workflow.md'), 'utf8')
const mirrorImageGuide = readFileSync(resolve(root, '.codex-marketplace/plugins/merchant-marketing/skills/merchant-marketing/references/product-image-workflow.md'), 'utf8')
const sourceShotGuide = readFileSync(resolve(root, 'apps/plugin/skills/ecommerce-video-marketing/references/shot_guide.md'), 'utf8')
const mirrorShotGuide = readFileSync(resolve(root, '.codex-marketplace/plugins/merchant-marketing/skills/ecommerce-video-marketing/references/shot_guide.md'), 'utf8')

describe('six platform import stays behind the merchant entry gate', () => {
  it('requires the main skill to verify identity and workspace before routing public links', () => {
    for (const main of [sourceMain, mirrorMain]) {
      expect(main).toBe(sourceMain)
      expect(main).toMatch(/six-platform-public-import/u)
      expect(main).toMatch(/(?:身份|商家).{0,30}(?:工作区|workspace)|(?:工作区|workspace).{0,30}(?:身份|商家)/u)
    }
  })

  it('does not advertise the helper as an independent business entry', () => {
    for (const helper of [sourceImport, mirrorImport]) {
      expect(helper).toBe(sourceImport)
      const description = helper.match(/^description:\s*(.+)$/mu)?.[1] ?? ''
      const gateStart = helper.indexOf('本技能不是独立业务入口')
      const gateEnd = helper.indexOf('\n\n', gateStart)
      const gate = helper.slice(gateStart, gateEnd)
      expect(description).toMatch(/merchant-marketing/u)
      expect(description).toMatch(/主入口|唯一业务入口/u)
      expect(gate).toMatch(/onboarding\.status/u)
      expect(gate).toMatch(/workspace\.interactive\.confirm/u)
      expect(helper).toMatch(/draft_only\s*=\s*["']?true/u)
      expect(helper).toMatch(/pending/u)
      expect(helper).toMatch(/不得.*(?:Cookie|同步|发布)/su)
      expect(gate).toMatch(/onboarding\.status.*确认绑定后路由调用/u)
      expect(gate).toMatch(/调用 `catalog\.import` 前.*`workspace\.interactive\.confirm`/u)
    }
  })

  it('keeps image and video planning examples evidence-led in both package trees', () => {
    expect(mirrorImageGuide).toBe(sourceImageGuide)
    expect(sourceImageGuide).toMatch(/缩略图/u)
    expect(sourceImageGuide).toMatch(/必须修改/u)
    expect(sourceImageGuide).toMatch(/待验证假设/u)
    expect(sourceImageGuide).not.toMatch(/点击率.{0,12}(?:预测|保证)/u)
    expect(mirrorShotGuide).toBe(sourceShotGuide)
    expect(sourceShotGuide).toMatch(/虚构示意/u)
    expect(sourceShotGuide).not.toMatch(/准时出粮|皮肤瞬间吸收|远程控制功能|打开APP|使用APP控制|宠物健康快乐|工作再忙也能照顾好宠物|推镜头：从传统/u)
  })
})
