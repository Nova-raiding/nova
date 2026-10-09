import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const pluginRoot = new URL('../apps/plugin/', import.meta.url)
const marketplaceRoot = new URL('../.codex-marketplace/plugins/merchant-marketing/', import.meta.url)
const readPluginFile = (path: string) => readFileSync(new URL(path, pluginRoot), 'utf8')
const sha256 = (root: URL, path: string) => createHash('sha256').update(readFileSync(new URL(path, root))).digest('hex')

async function discoveredToolNames(root: URL) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('mcp/bridge.mjs', root))], {
    cwd: fileURLToPath(root),
    env: {
      ...process.env,
      MERCHANT_MCP_BASE_URL: 'https://merchant.example.com',
      MERCHANT_WORKSPACE_ID: 'ws_mirror_runtime_test',
      MERCHANT_MCP_WRITE_ENABLED: 'false',
      MERCHANT_MCP_TOKEN_SOURCE: 'environment',
      MERCHANT_MCP_TOKEN: '',
      MERCHANT_MCP_REFRESH_TOKEN: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  try {
    const response = new Promise<Record<string, any>>((resolve, reject) => {
      let buffer = ''
      child.stdout.on('data', chunk => {
        buffer += String(chunk)
        const newline = buffer.indexOf('\n')
        if (newline >= 0) resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, any>)
      })
      child.once('error', reject)
      child.once('exit', code => { if (code && buffer.indexOf('\n') < 0) reject(new Error(`bridge exited before discovery: ${code}`)) })
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })}\n`)
    const payload = await response
    return (payload.result?.tools as Array<{ name: string }>).map(tool => tool.name).sort()
  } finally {
    child.kill()
  }
}

describe('Codex plugin package', () => {
  it('keeps the installable marketplace mirror byte-identical to the source package', () => {
    const mirroredFiles = [
      '.codex-plugin/plugin.json', '.mcp.json', 'README.md', 'host-evidence-contract.test.ts',
      'mcp/bridge.mjs', 'mcp/bridge.sh', 'mcp/managed-token.mjs', 'mcp/bridge.test.ts', 'mcp/merchant-conversation-flow.test.ts', 'package.json',
      'scripts/verify-installed-bridge.mjs',
      'skills/merchant-marketing/SKILL.md',
      'skills/merchant-marketing/references/product-image-workflow.md',
      'skills/merchant-marketing/references/ecommerce-detail-page-generator.md',
      'skills/merchant-marketing/references/ecommerce-detail-page-generator/category-playbooks.md',
      'skills/merchant-marketing/references/ecommerce-detail-page-generator/page-spec.schema.json',
      'skills/merchant-marketing/references/ecommerce-detail-page-generator/platform-profiles.json',
      'skills/merchant-marketing/references/ecommerce-detail-page-generator/platform-style-guide.md',
      'skills/merchant-marketing/references/ecommerce-detail-page-generator/prompt-recipes.md',
      'skills/ecommerce-video-marketing/SKILL.md',
      'skills/ecommerce-video-marketing/references/video_templates.md',
      'skills/ecommerce-video-marketing/references/video_guide.md',
      'skills/ecommerce-video-marketing/references/shot_guide.md',
      'skills/ecommerce-video-marketing/references/culture_adaptation.md',
      'skills/storyboard-prompt-assistant/SKILL.md',
      'ui/image-local-edit.html', 'ui/recharge.html',
    ]
    for (const file of mirroredFiles) expect(sha256(marketplaceRoot, file), file).toBe(sha256(pluginRoot, file))
    expect(existsSync(new URL('scheduled/weekly-four-platform-digest.json', marketplaceRoot))).toBe(false)
  })

  it('executes discovery from both source and local-source adapter bridge roots', async () => {
    const sourceTools = await discoveredToolNames(pluginRoot)
    const marketplaceTools = await discoveredToolNames(marketplaceRoot)
    expect(sourceTools.length).toBeGreaterThan(0)
    expect(marketplaceTools).toEqual(sourceTools)
    expect(sourceTools.some(name => name.startsWith('ops.'))).toBe(false)
    for (const name of ['platform.connect', 'catalog.sync', 'automation.scan', 'publish.confirm']) expect(sourceTools).not.toContain(name)
  }, 15_000)

  it('keeps README scoped to runtime discovery instead of a stale fixed tool count', () => {
    const readme = readPluginFile('README.md')
    expect(readme).toContain('实际工具以当前连接的 `tools/list` 与运行态契约测试为准')
    expect(readme).not.toMatch(/tools\/list` (?:实测)?为 \d+ 个 MCP 工具/u)
  })

  it('declares a confirmation-gated MCP plugin and entry skill', () => {
    const manifest = JSON.parse(readPluginFile('.codex-plugin/plugin.json')) as { id: string; skills: string; mcpServers: string; interface: { longDescription: string } }
    expect(manifest.id).toBe('merchant-marketing')
    expect(manifest.skills).toBe('./skills/')
    expect(manifest.mcpServers).toBe('./.mcp.json')
    expect(manifest.interface.longDescription).toMatch(/内容生产、审核与导出/)
    expect(manifest.interface.longDescription).toMatch(/不提供库存\/订单同步和自动发布/)
  })

  it('keeps the ChatGPT launch descriptor local-stdio-only and secret-free', () => {
    const manifest = JSON.parse(readPluginFile('.codex-plugin/plugin.json')) as {
      mcpServers?: unknown
    }
    const mcp = JSON.parse(readPluginFile('.mcp.json')) as {
      mcpServers?: Record<string, {
        command?: unknown
        args?: unknown
        cwd?: unknown
        env?: unknown
        env_vars?: unknown
        url?: unknown
        headers?: unknown
      }>
    }
    expect(manifest.mcpServers).toBe('./.mcp.json')
    expect(Object.keys(mcp.mcpServers ?? {})).toEqual(['merchant-marketing'])

    const server = mcp.mcpServers?.['merchant-marketing']
    expect(server).toMatchObject({ command: 'node', args: ['./mcp/bridge.mjs'], cwd: '.' })
    expect(server).not.toHaveProperty('env')
    expect(server).not.toHaveProperty('url')
    expect(server).not.toHaveProperty('headers')

    const envVars = server?.env_vars
    expect(Array.isArray(envVars)).toBe(true)
    expect(new Set(envVars as string[]).size).toBe((envVars as string[]).length)
    expect(envVars).toEqual(expect.arrayContaining([
      'MERCHANT_MCP_BASE_URL',
      'MERCHANT_WORKSPACE_ID',
      'MERCHANT_MCP_TOKEN',
      'MERCHANT_MCP_TOKEN_SOURCE',
      'MERCHANT_STRICT_AUTH',
    ]))
    expect(envVars).not.toEqual(expect.arrayContaining(['MERCHANT_ACTOR_ID', 'MERCHANT_MCP_ROLE']))
    expect(JSON.stringify(mcp)).not.toMatch(/(?:access[_-]?token|client[_-]?secret|private[_-]?key|password)\s*:/iu)
  })

  it('requires Chinese merchant-facing replies in the installed entry skill', () => {
    expect(readPluginFile('skills/merchant-marketing/SKILL.md')).toContain('所有面向商家的自然语言回复、表格标题与列名、状态说明、错误解释、下一步提示和生成候选文案统一使用简体中文')
  })

  it('keeps native entry prompts within the Codex host limit and inside the content workflow', () => {
    const manifest = JSON.parse(readPluginFile('.codex-plugin/plugin.json')) as {
      interface?: { defaultPrompt?: unknown }
    }
    expect(Array.isArray(manifest.interface?.defaultPrompt)).toBe(true)
    const prompts = (manifest.interface?.defaultPrompt as unknown[])
      .filter((value): value is string => typeof value === 'string')
      .map(value => value.trim())

    expect(prompts).toEqual([
      '@Store Nova 开始使用：从公开商品链接或手工资料开始，带我完成内容生产、审核和导出',
      '用我上传的商品图片做一张可审阅主图；还没有图片就先告诉我怎么上传',
      '为我的商品策划第一份营销素材，先核对我提供的商品资料',
    ])
    expect(prompts.length).toBeLessThanOrEqual(3)
    expect(prompts.join('\n')).not.toMatch(/同步|发布|Automation|四步流程/u)
  })
})
