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
    const merchantSkill = read('skills/merchant-marketing/SKILL.md')
    const imageReference = read('skills/merchant-marketing/references/product-image-workflow.md')
    const videoSkill = read('skills/ecommerce-video-marketing/SKILL.md')
    const marketplaceVideoSkill = read('../../.codex-marketplace/plugins/merchant-marketing/skills/ecommerce-video-marketing/SKILL.md')
    const storyboardSkill = read('skills/storyboard-prompt-assistant/SKILL.md')

    expect(manifest.skills).toBe('./skills/')
    for (const path of [
      'skills/merchant-marketing/SKILL.md',
      'skills/merchant-marketing/references/product-image-workflow.md',
      'skills/ecommerce-video-marketing/SKILL.md',
      'skills/storyboard-prompt-assistant/SKILL.md',
    ]) expect(packager).toContain(`'${path}'`)

    expect(imageReference).toContain('只能使用当前 `tools/list` 中可用的 Merchant Marketing MCP 工具及现有服务端中转')
    expect(imageReference).toContain('禁止调用宿主生图工具、第三方 provider')
    expect(merchantSkill).toContain('只有当前 `tools/list` 实际暴露视频渲染工具时')
    expect(merchantSkill).toContain('查询同一 provider job')
    expect(merchantSkill).toContain('创意点扣费、成本证据')
    expect(merchantSkill).toContain('对象归档、病毒扫描和商品保真复核')
    expect(videoSkill).toContain('本技能不能替代成片')
    expect(videoSkill).toContain('无证据时删除或明确标注“待核验”')
    expect(videoSkill).toContain('所有镜头时长之和严格等于用户指定总时长')
    expect(marketplaceVideoSkill).toBe(videoSkill)
    expect(storyboardSkill).toContain('This skill produces text, never a rendered video.')

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
