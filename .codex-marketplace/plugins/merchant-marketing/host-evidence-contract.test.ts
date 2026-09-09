import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(process.cwd(), 'apps/plugin')
const readText = (path: string) => readFileSync(resolve(root, path), 'utf8')
const readJson = (path: string) => JSON.parse(readText(path)) as Record<string, any>

describe('ChatGPT Host/OIDC/Automation local evidence contract', () => {
  it('declares a desktop ChatGPT host boundary without claiming mobile support', () => {
    const runtime = readJson('package.json').merchantRuntime

    expect(runtime).toMatchObject({
      desktopHost: 'ChatGPT.app',
      supportedDesktopPlatforms: ['darwin'],
      environmentRecovery: 'macOS launchctl user session',
    })
    expect(runtime.otherPlatforms).toMatch(/outside the current desktop support boundary/u)
    expect(readJson('.codex-plugin/plugin.json').interface.displayName).toBe('大麦')
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

  it('uses native host Automations and keeps the plugin manifest free of speculative scheduler fields', () => {
    const manifest = readJson('.codex-plugin/plugin.json')
    const skill = readText('skills/merchant-marketing/SKILL.md')
    const automationReference = 'skills/merchant-marketing/references/automations.md'

    expect(manifest).not.toHaveProperty('scheduledTasks')
    expect(manifest).not.toHaveProperty('automation')
    expect(existsSync(resolve(root, automationReference))).toBe(true)
    expect(skill).toContain('Codex App 原生 Automations')
    expect(skill).toContain('不得创建自己的调度服务、任务表或管理页面')
    expect(skill).toMatch(/宿主没有 Automations[^\n]*复制/u)
    expect(readText(automationReference)).toMatch(/无人值守[^\n]*(禁止|不得)[^\n]*写/u)
    expect(readText(automationReference)).toMatch(/执行频率、暂停\/恢复、运行历史和通知均由 Codex App 管理/u)
  })
})
