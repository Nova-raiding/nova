import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const pluginRoot = new URL('./', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, pluginRoot), 'utf8')

function nextLine(stream: NodeJS.ReadableStream): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString()
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      cleanup()
      try { resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, any>) } catch (error) { reject(error) }
    }
    const onError = (error: Error) => { cleanup(); reject(error) }
    const onEnd = () => { cleanup(); reject(new Error('local stdio bridge ended before tools/list')) }
    const cleanup = () => {
      stream.off('data', onData)
      stream.off('error', onError)
      stream.off('end', onEnd)
    }
    stream.on('data', onData)
    stream.once('error', onError)
    stream.once('end', onEnd)
  })
}

describe('installed e-commerce image/video workflow contract', () => {
  it('ships the planning skills with their guarded local MCP image and video surfaces', async () => {
    const manifest = JSON.parse(read('.codex-plugin/plugin.json')) as { skills: string }
    const packager = read('scripts/package-local-plugin.mjs')
    const imageWorkflowSkill = read('skills/ecommerce-image-workflow/SKILL.md')
    const marketplaceImageWorkflowSkill = read('../../.codex-marketplace/plugins/merchant-marketing/skills/ecommerce-image-workflow/SKILL.md')
    const merchantSkill = read('skills/merchant-marketing/SKILL.md')
    const marketplaceMerchantSkill = read('../../.codex-marketplace/plugins/merchant-marketing/skills/merchant-marketing/SKILL.md')
    const imageReference = read('skills/merchant-marketing/references/product-image-workflow.md')
    const marketplaceImageReference = read('../../.codex-marketplace/plugins/merchant-marketing/skills/merchant-marketing/references/product-image-workflow.md')
    const videoSkill = read('skills/ecommerce-video-marketing/SKILL.md')
    const marketplaceVideoSkill = read('../../.codex-marketplace/plugins/merchant-marketing/skills/ecommerce-video-marketing/SKILL.md')
    const storyboardSkill = read('skills/storyboard-prompt-assistant/SKILL.md')
    const marketplaceStoryboardSkill = read('../../.codex-marketplace/plugins/merchant-marketing/skills/storyboard-prompt-assistant/SKILL.md')

    expect(manifest.skills).toBe('./skills/')
    for (const path of [
      'skills/ecommerce-image-workflow/SKILL.md',
      'skills/merchant-marketing/SKILL.md',
      'skills/merchant-marketing/references/product-image-workflow.md',
      'skills/ecommerce-video-marketing/SKILL.md',
      'skills/storyboard-prompt-assistant/SKILL.md',
    ]) expect(packager).toContain(`'${path}'`)

    expect(imageWorkflowSkill).toBe(marketplaceImageWorkflowSkill)
    expect(imageWorkflowSkill).toContain('一组主图或详情套图')
    expect(imageWorkflowSkill).toContain('不假定有批量能力')
    expect(imageWorkflowSkill).toContain('实际上传、生成、查询和交付只通过')
    expect(imageWorkflowSkill).not.toContain('这次要做哪一种电商图？')

    expect(imageReference).toContain('只能使用当前 `tools/list` 中可用的 Merchant Marketing MCP 工具及现有服务端中转')
    expect(imageReference).toContain('禁止调用宿主生图工具、第三方 provider')
    expect(merchantSkill).toContain('参考中的像素级检查是人工复核清单，只有 MCP/服务端实际返回相应机器检查证据时才可声称机器 QA 通过')
    expect(imageReference).toContain('以上是人工复核清单，不是机器像素检测。只有当前 Store Nova MCP/服务端对该候选实际返回尺寸、像素 QA 项目及结果等机器证据时')
    expect(imageReference).toContain('不得把人工观察、对话清单、模型自述或普通生成成功响应冒充工具验证')
    expect(imageReference).toBe(marketplaceImageReference)
    expect(imageReference).toContain('套图候选清单与续作')
    expect(imageReference).toContain('风格参考只提炼抽象方向')
    expect(imageReference).toContain('不得逐像素复刻参考图或复制其品牌标识、原文案和独特版式')
    expect(imageReference).toBe(marketplaceImageReference)
    expect(imageReference).toContain('清单只是对话中的规划与跟进记录，不是服务端状态')
    expect(imageReference).toContain('queued 槽位只查询同一任务，禁止重新提交')
    expect(imageReference).toContain('清单本身不能触发批量调用')
    expect(imageReference).toContain('不能用清单推断任务成功、扫描通过或审核通过')
    expect(imageReference).toContain('production/staging/preview 中非排队的模型成功响应还必须含当前 bridge 契约要求的真实 `providerExecuted`、`provider_request_id`、非空 `usage` 和数值 `cost_cny`')
    expect(imageReference).toContain('缺项时 bridge 失败关闭')
    expect(imageReference).toContain('内部 relay 证据，不在商家对话展示，也不要求商家提供金额')
    expect(imageReference).toContain('服务端成本门禁或结算失败、状态未知/未结算')
    expect(imageReference).toContain('授权 MCP/账务工具实际返回并允许展示')
    expect(imageReference).toContain('具体 provider 成本')
    expect(imageReference).toContain('商户不需要看到或提供精确金额')
    expect(imageReference).toContain('不得估算')
    expect(merchantSkill).toContain('只有当前 `tools/list` 实际暴露视频渲染工具时')
    expect(merchantSkill).toContain('`creative.brief.durationSeconds` 只表示分镜计划时长')
    expect(merchantSkill).toContain('用户指定的总时长、镜头节奏、慢揭示等叙事意图及已核验的平台规则优先')
    expect(merchantSkill).toContain('2–6 秒镜头和开场 3 秒均为可调整的创作建议，不是合规或渲染门禁')
    expect(merchantSkill).toContain('当前视频渲染 MCP 不接收可指定的时长参数，也不返回可验证的实际成片时长或生效渲染配置')
    expect(merchantSkill).toContain('不得在渲染前或完成后声称成片时长符合用户指定值')
    expect(merchantSkill).toContain('只有授权 MCP 或经授权的素材检查实际返回成片时长时才能报告该值；否则必须标注“成片时长待核验”')
    expect(merchantSkill).toContain('### 同平台竞品视觉参考（可选）')
    expect(merchantSkill).toContain('只接收并保存调用方提供的结构化分析，不会自行读取网页')
    expect(merchantSkill).toContain('跳过竞品分析，不把它作为图片生成阻断项')
    expect(merchantSkill).toContain('只按本商品已确认事实、可用素材和服务端规则、权限、权益、成本及审核门禁继续')
    expect(merchantSkill).not.toContain('停在“竞品预检阻断”')
    expect(merchantSkill).toContain('查询同一 provider job')
    expect(merchantSkill).toContain('视频渲染只有在服务端成本预检通过且用量结算状态为已结算后才可作为完成结果')
    expect(merchantSkill).toContain('非排队的模型成功响应还必须符合当前 bridge 契约')
    expect(merchantSkill).toContain('包含真实 `providerExecuted`、`provider_request_id`、非空 `usage` 和数值 `cost_cny`')
    expect(merchantSkill).toContain('缺项时 bridge 会失败关闭')
    expect(merchantSkill).toContain('该成本证据用于服务端与 bridge 验证，不在对话中展示，也不要求商家提供精确金额')
    expect(merchantSkill).toContain('只有授权 MCP/账务工具实际返回并允许展示时才向商家说明具体金额')
    expect(merchantSkill).toContain('对象归档、病毒扫描和商品保真复核')
    expect(merchantSkill).toContain('服务端返回真实的对象归档状态与病毒扫描状态；两者必须分别有明确的通过证据才可记录为通过')
    expect(merchantSkill).toBe(marketplaceMerchantSkill)
    expect(videoSkill).toContain('本技能不能替代成片')
    expect(videoSkill).toContain('无证据时删除或明确标注“待核验”')
    expect(videoSkill).toContain('所有镜头时长之和严格等于用户指定总时长')
    expect(videoSkill).toContain('不读取或分析图片附件、不构建知识图谱、不查询竞品/行业数据')
    expect(videoSkill).toContain('不从常识、示例或图片外观推断商品事实')
    expect(videoSkill).toContain('只有实际数据源返回了可核验结果才可引用')
    expect(marketplaceVideoSkill).toBe(videoSkill)
    expect(storyboardSkill).toContain('This skill produces text, never a rendered video.')
    expect(storyboardSkill).toContain('generic creative text, not provider-validated parameters, an executable request, or evidence that a video renderer accepts them')
    expect(storyboardSkill).toContain('A storyboard alone never means rendering started or succeeded.')
    expect(storyboardSkill).toContain('User-specified total duration, shot rhythm, slow reveal, and other narrative intent take priority')
    expect(storyboardSkill).toContain('not a compliance or rendering gate')
    expect(marketplaceStoryboardSkill).toBe(storyboardSkill)

    const child = spawn(process.execPath, [fileURLToPath(new URL('mcp/bridge.mjs', pluginRoot))], {
      cwd: fileURLToPath(pluginRoot),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DEPLOY_ENV: 'local_desktop',
        MERCHANT_MCP_BASE_URL: 'https://merchant.example.test',
        MERCHANT_WORKSPACE_ID: 'ws_visual_workflow_contract',
        MERCHANT_MCP_TOKEN: '',
        MERCHANT_MCP_REFRESH_TOKEN: '',
        MERCHANT_MCP_TOKEN_SOURCE: 'environment',
        MERCHANT_STRICT_AUTH: 'true',
        MERCHANT_MCP_WRITE_ENABLED: 'false',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })}\n`)
      const response = await nextLine(child.stdout)
      const tools = (response.result?.tools as Array<{ name: string }> | undefined)?.map(tool => tool.name) ?? []
      expect(response.error).toBeUndefined()
      expect(tools).toEqual(expect.arrayContaining([
        'catalog.image.generate', 'catalog.image.get', 'multimodal.video.request', 'multimodal.video.get',
      ]))
    } finally {
      child.kill()
      await once(child, 'exit').catch(() => undefined)
    }
  }, 15_000)
})
