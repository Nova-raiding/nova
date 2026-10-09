import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
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
    expect(skill).toContain('用户明确要求生成商品图片/详情长图')
    expect(skill).toContain('只有 MCP 返回真实 `images`/图片附件')
    expect(skill).toContain('用户要视频脚本或分镜')
    expect(skill).toContain('用户明确要视频成片')
    expect(skill).toContain('当前只能制作脚本/分镜，不能声称已渲染')
    expect(skill).toContain('只问一个问题，确认期望交付物')

    // Keep the user-facing route tied to tools the Bridge actually registers;
    // the API remains authoritative for production video gates.
    expect(bridge).toContain("'catalog.image.generate': {")
    expect(bridge).toContain("'catalog.image.get': {")
    expect(bridge).toContain("'multimodal.video.request': {")
    expect(bridge).toContain("'multimodal.video.get': {")
  })

  it('does not equate a script, storyboard, queued job, or text plan with a rendered visual deliverable', async () => {
    const skill = await readFile(skillPath, 'utf8')
    expect(skill).toContain('脚本技能提供的纯文本创作本身不是商品视频成片')
    expect(skill).toContain('不能把方案、文案、原图、占位组件或任务排队状态说成生成成品')
    expect(skill).toContain('仅有任务 ID、排队状态、文本方案或分镜时')
    expect(skill).toContain('只有 MCP 返回真实图片附件时才原样展示')
    expect(skill).toContain('本地 fixture 仅在明确的演示上下文展示')
    expect(skill).toContain('仅当 MCP 返回真实图片附件时，才将图片原样展示给商家')
    expect(skill).toContain('仅有排队状态、任务 ID、文本方案或无图片附件时')
    expect(skill).not.toContain('无论结果来自真实 provider、排队任务还是本地 fixture，都必须把图片直接展示')
    expect(skill).toContain('保留真实查询路径，不重复创建任务')
  })

  it('keeps ambiguous design requests and incomplete plan confirmation out of generation', async () => {
    const skill = await readFile(skillPath, 'utf8')
    const videoSkill = await readFile(new URL('../ecommerce-video-marketing/SKILL.md', import.meta.url), 'utf8')
    const storyboardSkill = await readFile(new URL('../storyboard-prompt-assistant/SKILL.md', import.meta.url), 'utf8')

    expect(skill).toContain('“设计/设计一下”本身不等于要求生成图片')
    expect(skill).toContain('补充商品事实、要求代查资料或泛泛说“继续”都不算方案确认')
    expect(skill).toContain('从零创作用 `mode=create`')
    expect(skill).toContain('基于已上传素材优化用 `mode=optimize`')
    expect(skill).toContain('未绑定模式（不传 `product_id`）无论 `mode=create` 还是 `mode=optimize`，都必须传用户确认的 `title` 和 `asset.upload` 返回的真实 `asset_ids_json`')
    expect(skill).toContain('仅在服务端明确启用演示未扫描策略时，独立候选才可使用 `unscanned` 素材，并须明确标注为“演示环境候选、尚未扫描”')
    expect(videoSkill).toContain('仅当 merchant-marketing 主技能已将当前请求路由为可审阅脚本/分镜文本')
    expect(storyboardSkill).toContain('For Store Nova merchant-product workflows, use this skill only after `merchant-marketing` has routed the request to script/storyboard text')
  })

  it('keeps ecommerce image prompt recipes on the Store Nova relay and synchronized with the install mirror', async () => {
    const recipePath = resolve(process.cwd(), 'apps/plugin/skills/merchant-marketing/references/ecommerce-detail-page-generator/prompt-recipes.md')
    const mirrorRecipePath = resolve(process.cwd(), '.codex-marketplace/plugins/merchant-marketing/skills/merchant-marketing/references/ecommerce-detail-page-generator/prompt-recipes.md')
    const [recipe, mirrorRecipe] = await Promise.all([
      readFile(recipePath, 'utf8'),
      readFile(mirrorRecipePath, 'utf8'),
    ])

    expect(recipe).toBe(mirrorRecipe)
    expect(recipe).toContain('prompt-planning and review templates only')
    expect(recipe).toContain('`catalog.image.generate`')
    expect(recipe).toContain('Store Nova server-side model relay')
    expect(recipe).toContain('Do not select or call a provider from this reference')
    expect(recipe).not.toMatch(/imagegen|image_gen|GPTIMAGE_API_KEY|GPTIMAGE_BASE_URL|third.party provider|外部网关|第三方 API/iu)
  })
})
