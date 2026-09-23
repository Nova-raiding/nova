import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(process.cwd(), 'apps/plugin')
const readText = (path: string) => readFileSync(resolve(root, path), 'utf8')
const readJson = (path: string) => JSON.parse(readText(path)) as Record<string, any>

describe('ChatGPT Host/OIDC local evidence contract', () => {
  it('declares a desktop ChatGPT host boundary without claiming mobile support', () => {
    const runtime = readJson('package.json').merchantRuntime

    expect(runtime).toMatchObject({
      desktopHost: 'ChatGPT.app',
      supportedDesktopPlatforms: ['darwin', 'win32'],
      environmentRecovery: 'host-injected environment with platform credential storage',
    })
    expect(runtime.otherPlatforms).toMatch(/outside the current desktop support boundary/u)
    expect(readJson('.codex-plugin/plugin.json').interface.displayName).toBe('Store Nova')
  })

  it('keeps OIDC identity host-provided and prevents static identity or secret injection', () => {
    const manifest = readJson('.codex-plugin/plugin.json')
    const mcp = readJson('.mcp.json')
    const server = mcp.mcpServers['merchant-marketing']
    const envVars = server.env_vars as string[]

    expect(server).not.toHaveProperty('env')
    expect(envVars).toEqual(expect.arrayContaining([
      'MERCHANT_MCP_BASE_URL',
      'MERCHANT_WORKSPACE_ID',
      'MERCHANT_MCP_TOKEN',
    ]))
    expect(envVars).not.toEqual(expect.arrayContaining(['MERCHANT_ACTOR_ID', 'MERCHANT_MCP_ROLE']))
    expect(JSON.stringify(manifest)).not.toMatch(/(?:access[_-]?token|client[_-]?secret|private[_-]?key|password)/iu)

    const readme = readText('README.md')
    expect(readme).toMatch(/Bearer\/OIDC/u)
    expect(readme).toMatch(/不会静态声明 `MERCHANT_ACTOR_ID` 或 `MERCHANT_MCP_ROLE`/u)
    expect(readme).toMatch(/bridge 对缺失或未解析的.*默认失败关闭/u)
  })

  it('keeps hidden automation and scheduler capabilities outside the current merchant scope', () => {
    const manifest = readJson('.codex-plugin/plugin.json')
    const skill = readText('skills/merchant-marketing/SKILL.md')

    expect(manifest).not.toHaveProperty('scheduledTasks')
    expect(manifest).not.toHaveProperty('automation')
    expect(skill).toContain('当前插件不提供库存/订单同步、自动发布、批量发布或店铺经营巡检入口')
    expect(skill).toContain('旧 Automation 模板')
    expect(skill).toContain('平台同步、发布与自动化入口保持隐藏')
  })
})
