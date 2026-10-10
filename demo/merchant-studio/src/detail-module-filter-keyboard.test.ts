import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

describe('product detail module filter keyboard interaction', () => {
  it('uses roving focus and arrow navigation for the tablist', () => {
    const start = app.indexOf('className="module-filter"')
    const end = app.indexOf('<div className="detail-module-grid">', start)
    const tabs = app.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(tabs).toContain('role="tablist"')
    expect(tabs).toContain('tabIndex={moduleFilter === filter ? 0 : -1}')
    expect(tabs).toContain('handleTabKeyDown(')
    expect(tabs).toContain("setModuleFilter")
  })
})
