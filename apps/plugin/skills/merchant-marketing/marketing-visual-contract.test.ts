import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const skillPath = new URL('./SKILL.md', import.meta.url)
const bridgePath = new URL('../../mcp/bridge.mjs', import.meta.url)

describe('merchant marketing visual and video contract', () => {
  it('routes detail page visuals and video requests by requested deliverable and live tool availability', async () => {
    const skill = await readFile(skillPath, 'utf8')
    const bridge = await readFile(bridgePath, 'utf8')

    expect(skill.slice(0, skill.indexOf('\n---', 4))).toMatch(/商品详情页设计图.*详情长图.*视频脚本.*视频成片/u)
    expect(skill).toContain('先按当前 MCP 会话实际返回的 `tools/list` 判断可执行的产物类型')
    expect(skill).toContain('用户要设计方案/视觉策划')
    expect(skill).toContain('用户明确要生成商品图片/详情长图')
    expect(skill).toContain('只有 MCP 返回真实 `images`/图片附件')
    expect(skill).toContain('用户要视频脚本或分镜')
    expect(skill).toContain('用户明确要视频成片')
    expect(skill).toContain('当前只能制作脚本/分镜，不能声称已渲染')
    expect(skill).toContain('只问一个问题，确认期望交付物')

    // Keep the user-facing route tied to tools the Bridge actually registers,
    // and to its fail-closed production video visibility gate.
    expect(bridge).toContain("'catalog.image.generate': {")
    expect(bridge).toContain("'catalog.image.get': {")
    expect(bridge).toContain("'multimodal.video.request': {")
    expect(bridge).toContain("'multimodal.video.get': {")
    expect(bridge).toContain("process.env.MERCHANT_ENABLE_LOCAL_VIDEO_CANDIDATES === 'true'")
    expect(bridge).toContain("'multimodal.video.request',\n])")
  })

  it('does not equate a script, storyboard, queued job, or text plan with a rendered visual deliverable', async () => {
    const skill = await readFile(skillPath, 'utf8')
    expect(skill).toContain('脚本技能提供的纯文本创作本身不是商品视频成片')
    expect(skill).toContain('不能把方案、文案、原图、占位组件或任务排队状态说成生成成品')
    expect(skill).toContain('仅有任务 ID、排队状态、文本方案或分镜时')
    expect(skill).toContain('保留真实查询路径，不重复创建任务')
  })
})
