import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const app = readFileSync(resolve(import.meta.dirname, 'App.tsx'), 'utf8')
const css = readFileSync(resolve(import.meta.dirname, 'styles.css'), 'utf8')

describe('merchant navigation cleanup contract', () => {
  it('keeps only knowledge as a new-session entry', () => {
    expect(app).toContain('aria-label="新会话入口"')
    expect(app).toContain("id: 'knowledge'")
    expect(app).not.toContain("id: 'images',")
    expect(app).not.toContain("id: 'assets',")
  })

  it('does not ship the removed welcome panel or duplicate entry cards', () => {
    expect(app).not.toContain('function EntryPointCards')
    expect(css).not.toContain('.welcome-panel')
    expect(css).not.toContain('.flow-preview')
  })

  it('does not expose removed support and diagnostics labels', () => {
    expect(app).not.toContain('帮助与诊断')
    expect(app).not.toContain('客服回复')
  })
})
