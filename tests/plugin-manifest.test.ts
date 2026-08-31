import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
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
      MERCHANT_MCP_BASE_URL: 'http://127.0.0.1:9',
      MERCHANT_WORKSPACE_ID: 'ws_mirror_runtime_test',
      MERCHANT_MCP_WRITE_ENABLED: 'false',
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

function lineDeclaresForbidden(document: string, term: string) {
  return document.split(/\r?\n/u).some(line =>
    line.toLowerCase().includes(term.toLowerCase()) && /(禁止|不得|严禁|不可|不允许)/u.test(line),
  )
}

function markdownSection(document: string, headingPattern: RegExp) {
  const lines = document.split(/\r?\n/u)
  const start = lines.findIndex(line => /^#{1,6}\s+/u.test(line) && headingPattern.test(line))
  if (start < 0) return ''
  const depth = lines[start]!.match(/^#+/u)![0].length
  const endOffset = lines.slice(start + 1).findIndex(line => {
    const heading = line.match(/^(#+)\s+/u)
    return Boolean(heading && heading[1]!.length <= depth)
  })
  return lines.slice(start, endOffset < 0 ? undefined : start + 1 + endOffset).join('\n')
}

function expectReadOnlySixPlatformPrompt(prompt: string) {
  const normalized = prompt.toLowerCase()
  for (const aliases of [['jd', '京东'], ['taobao', '淘宝'], ['tmall', '天猫'], ['pinduoduo', '拼多多']]) {
    expect(aliases.some(alias => normalized.includes(alias)), `prompt 必须覆盖平台 ${aliases.join('/')}`).toBe(true)
  }
  for (const platform of ['xiaohongshu', 'douyin']) expect(normalized).toContain(platform)
  expect(prompt).toContain('只读')
  expect(prompt).toMatch(/(禁止|不得|严禁|不允许|不执行)[^。\n]*(写入|写操作)|(写入|写操作)[^。\n]*(禁止|不得|严禁|不允许|不执行)/u)

  const namedTools = [...prompt.matchAll(/\b[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+\b/gu)].map(match => match[0])
  expect([...new Set(namedTools)].sort()).toEqual(['workspace.health', 'workspace.metrics'])
  for (const writeTool of ['publish.confirm', 'publish.prepare', 'catalog.sync.start', 'platform.connect', 'billing.recharge.create']) {
    expect(prompt).not.toContain(writeTool)
  }

  expect(prompt).toContain('store/account')
  expect(prompt).toMatch(/(隔离|分组)[^。\n]*(不得|禁止)[^。\n]*混算/u)
  expect(prompt).toContain('comparisonAvailable=false')
  expect(prompt).toContain('comparisonReason=baseline_unavailable')
  expect(prompt).toMatch(/仅当宿主明确提供上一运行的结构化结果/u)
  expect(prompt).toMatch(/否则[^。\n]*只报告当前[^。\n]*不得声称风险新增、升级、持续或已恢复/u)
}

describe('Codex plugin package', () => {
  it('keeps the installable marketplace mirror byte-identical to the source package', () => {
    const mirroredFiles = [
      '.codex-plugin/plugin.json', '.mcp.json', 'README.md', 'install-smoke.test.ts',
      'mcp/bridge.mjs', 'mcp/bridge.sh', 'mcp/bridge.test.ts', 'package.json',
      'scheduled/daily-store-risk-scan.json', 'scheduled/weekly-six-platform-digest.json',
      'skills/merchant-marketing/SKILL.md', 'skills/merchant-marketing/references/automations.md',
      'ui/image-local-edit.html', 'ui/recharge.html',
    ]
    for (const file of mirroredFiles) expect(sha256(marketplaceRoot, file), file).toBe(sha256(pluginRoot, file))
    expect(existsSync(new URL('scheduled/weekly-four-platform-digest.json', marketplaceRoot))).toBe(false)
  })

  it('executes discovery from both source and marketplace bridge roots', async () => {
    const sourceTools = await discoveredToolNames(pluginRoot)
    const marketplaceTools = await discoveredToolNames(marketplaceRoot)
    expect(sourceTools).toHaveLength(150)
    expect(marketplaceTools).toEqual(sourceTools)
    expect(sourceTools.some(name => name.startsWith('ops.'))).toBe(false)
  })

  it('keeps README runtime tool-count claims aligned with discovery', async () => {
    const tools = await discoveredToolNames(pluginRoot)
    const readme = readPluginFile('README.md')
    expect(readme).toContain(`tools/list\` 为 ${tools.length} 个 MCP 工具`)
    expect(readme).not.toContain('tools/list` 为 149 个 MCP 工具')
  })

  it('declares a confirmation-gated MCP plugin and entry skill', () => {
    const manifest = JSON.parse(readPluginFile('.codex-plugin/plugin.json')) as { id: string; skills: string; mcpServers: string; interface: { longDescription: string } }
    expect(manifest.id).toBe('merchant-marketing')
    expect(manifest.skills).toBe('./skills/')
    expect(manifest.mcpServers).toBe('./.mcp.json')
    expect(manifest.interface.longDescription).toMatch(/确认/)
  })

  it('keeps native entry prompts within the Codex host limit and exposes one combined Automation entry', () => {
    const manifest = JSON.parse(readPluginFile('.codex-plugin/plugin.json')) as {
      interface?: { defaultPrompt?: unknown }
    }
    expect(Array.isArray(manifest.interface?.defaultPrompt)).toBe(true)
    const prompts = (manifest.interface?.defaultPrompt as unknown[])
      .filter((value): value is string => typeof value === 'string')
      .map(value => value.trim())

    expect(prompts).toEqual([
      '开始使用大麦：先读取当前工作区和店铺连接状态，再让我选择一家店铺',
      '查看插件钱包余额；余额不足时告诉我唯一的下一步',
      '开始商品营销：先让我选择一个平台和商品，然后每一步都等我确认',
    ])
    expect(prompts.length).toBeLessThanOrEqual(3)
  })

  it('links the skill to an explicit native Automation safety contract', () => {
    const skill = readPluginFile('skills/merchant-marketing/SKILL.md')
    expect(skill).toContain('references/automations.md')
    expect(existsSync(new URL('skills/merchant-marketing/references/automations.md', pluginRoot))).toBe(true)
  })

  it('limits unattended Automations to six domestic platforms and an explicit read-only allowlist', () => {
    const automation = readPluginFile('skills/merchant-marketing/references/automations.md')

    const platformScope = automation.split(/\n\s*\n/u).find(paragraph => paragraph.includes('覆盖') && ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'].every(platform => paragraph.toLowerCase().includes(platform)))
    expect(platformScope, '平台范围必须在同一段明确声明覆盖六个平台').toBeTruthy()

    const allowlist = markdownSection(automation, /只读.{0,12}(工具)?白名单|白名单.{0,12}只读/u).toLowerCase()
    expect(allowlist, 'automations.md 必须包含独立的“只读工具白名单”章节').not.toBe('')
    for (const tool of ['workspace.health', 'workspace.metrics']) {
      expect(allowlist).toContain(tool)
    }
    for (const forbidden of ['catalog.search', 'task.history', 'publish.confirm', 'catalog.sync.start', 'platform.connect', 'billing']) expect(allowlist).not.toContain(forbidden)

    for (const forbidden of ['publish.confirm', 'catalog.sync.start', 'platform.connect', 'billing']) {
      expect(lineDeclaresForbidden(automation, forbidden), `${forbidden} 必须在同一行明确标记为禁止`).toBe(true)
    }
    expect(automation).toMatch(/(禁止|不得|严禁|不允许)[^。\n]*(任何|所有)[^。\n]*写操作[^。\n]*无人值守|无人值守[^。\n]*(禁止|不得|严禁|不允许)[^。\n]*写操作/us)
  })

  it('ships minimal native Automation definitions with fixed schedules and fail-closed comparison prompts', () => {
    const expected = {
      'daily-store-risk-scan.json': { type: 'daily', time: '09:00' },
      'weekly-six-platform-digest.json': { type: 'weekly', days: ['SA'], time: '09:30' },
    } as const
    const scheduledDirectory = new URL('scheduled/', pluginRoot)
    expect(existsSync(scheduledDirectory)).toBe(true)

    const jsonFiles = readdirSync(scheduledDirectory).filter(file => file.endsWith('.json'))
    for (const filename of jsonFiles) expect(filename).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*\.json$/u)
    expect(jsonFiles.sort()).toEqual(Object.keys(expected).sort())

    for (const [filename, schedule] of Object.entries(expected)) {
      const definition = JSON.parse(readPluginFile(`scheduled/${filename}`)) as Record<string, unknown>
      expect(Object.keys(definition).sort()).toEqual(['name', 'prompt', 'schedule'])
      expect(typeof definition.name).toBe('string')
      expect((definition.name as string).trim()).not.toBe('')
      expect(typeof definition.prompt).toBe('string')
      expectReadOnlySixPlatformPrompt(definition.prompt as string)
      expect(definition.schedule).toEqual(schedule)
    }
  })
})
