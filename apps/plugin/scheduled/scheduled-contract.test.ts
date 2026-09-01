import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const readPrompt = (name: string) => {
  const definition = JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')) as { prompt?: unknown }
  expect(typeof definition.prompt).toBe('string')
  return definition.prompt as string
}

describe('native scheduled Automation local contract', () => {
  it.each(['daily-store-risk-scan.json', 'weekly-six-platform-digest.json'])('fails closed when workspace authorization is unavailable: %s', name => {
    const prompt = readPrompt(name)
    expect(prompt).toContain('工作区身份、授权状态或数据来源边界无法验证')
    expect(prompt).toContain('立即 fail-closed')
    expect(prompt).toContain('不得猜测或切换工作区')
  })

  it.each(['daily-store-risk-scan.json', 'weekly-six-platform-digest.json'])('honors host pause state before any tool call: %s', name => {
    const prompt = readPrompt(name)
    expect(prompt).toMatch(/paused、suspended 或 disabled/u)
    expect(prompt).toContain('不得调用任何工具')
  })

  it.each(['daily-store-risk-scan.json', 'weekly-six-platform-digest.json'])('keeps replay idempotent and side-effect free: %s', name => {
    const prompt = readPrompt(name)
    expect(prompt).toContain('相同宿主运行标识的重放')
    expect(prompt).toContain('必须保持只读')
    expect(prompt).toContain('不得创建任务或其他副作用')
  })
})
