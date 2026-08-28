import { describe, expect, it } from 'vitest'
import { csvCell, executionContract, service } from './server.js'

describe('CSV export safety', () => {
  it('neutralizes spreadsheet formula prefixes while preserving CSV quoting', () => {
    expect(csvCell('=HYPERLINK("https://evil.example")')).toBe(`"'=HYPERLINK(""https://evil.example"")"`)
    expect(csvCell('normal, text')).toBe('"normal, text"')
  })
})
describe('API application wiring', () => {
  it('exposes a fail-closed health state before real platform configuration', () => {
    const health = service.health()
    expect(health.status).toBe('ok')
    expect(health.writesEnabled).toBe(false)
    expect(health.connectors.jd).toBe('not_configured')
  })

  it('labels local fallback output as simulated and provider output as executed', () => {
    expect(executionContract('image', false)).toMatchObject({ mode: 'simulated', simulated: true, providerExecuted: false, label: '本地演示图片，未调用图片模型' })
    expect(executionContract('ocr', false)).toMatchObject({ mode: 'simulated', simulated: true, providerExecuted: false })
    expect(executionContract('content', true)).toMatchObject({ mode: 'provider', simulated: false, providerExecuted: true, label: '已由配置的内容模型生成' })
    expect(executionContract('video', true, 'text-relay')).toMatchObject({ mode: 'provider', providerKind: 'text-relay' })
  })
})
