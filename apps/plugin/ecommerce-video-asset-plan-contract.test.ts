import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

describe('photo-to-video planning stays a gated text deliverable', () => {
  it('routes a slideshow editing brief through confirmed Store Nova assets without claiming a render', () => {
    const videoSkill = read('apps/plugin/skills/ecommerce-video-marketing/SKILL.md')
    const packagedVideoSkill = read('.codex-marketplace/plugins/merchant-marketing/skills/ecommerce-video-marketing/SKILL.md')
    const merchantSkill = read('apps/plugin/skills/merchant-marketing/SKILL.md')
    const packagedMerchantSkill = read('.codex-marketplace/plugins/merchant-marketing/skills/merchant-marketing/SKILL.md')
    const bridge = read('apps/plugin/mcp/bridge.mjs')

    expect(videoSkill).toBe(packagedVideoSkill)
    expect(merchantSkill).toBe(packagedMerchantSkill)
    expect(videoSkill).toContain('照片素材轮播剪辑 brief')
    expect(videoSkill).toContain('asset.list')
    expect(videoSkill).toContain('每张图的顺序、时间段、转场、字幕来源和待核验项')
    expect(videoSkill).toContain('本技能不读取图片像素')
    expect(videoSkill).toContain('只输出可审阅的剪辑说明，不生成、编辑、上传或渲染媒体')
    expect(merchantSkill).toContain('照片素材轮播剪辑 brief')
    expect(merchantSkill).toContain('只有当前 `tools/list` 实际暴露视频渲染工具')
    expect(merchantSkill).toContain('当次用户确认及服务端工作区、素材权益、权限、费用、结算、归档和扫描门禁')
    expect(bridge).toContain("'asset.list': {")
    expect(bridge).toContain("'multimodal.video.request': {")
    expect(bridge).toContain("'multimodal.video.get': {")
    expect(videoSkill).not.toMatch(/\b(?:ffmpeg|npx|curl|fetch\(|https?:\/\/|API key|provider SDK)\b/iu)
  })
})
