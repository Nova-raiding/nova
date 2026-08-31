import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('responsive task entry contract', () => {
  it('keeps task history and publish actions reachable on mobile', () => {
    const css = readFileSync(new URL('./src/styles.css', import.meta.url), 'utf8')
    expect(css).not.toContain('.task-titlebar .button-row{display:none}')
    expect(css).toContain('.task-titlebar .button-row{display:flex;width:100%;justify-content:flex-start}')
  })

  it('keeps the rules selector and source metadata usable on narrow screens', () => {
    const css = readFileSync(new URL('./src/styles.css', import.meta.url), 'utf8')
    expect(css).toContain('.library-toolbar{align-items:stretch;flex-direction:column}')
    expect(css).toContain('.rule-context-notice{align-items:flex-start}')
  })

  it('stacks the consistency card at mobile width', () => {
    const css = readFileSync(new URL('./src/styles.css', import.meta.url), 'utf8')
    expect(css).toContain('@media (max-width:700px){.data-consistency-head{flex-direction:column')
    expect(css).toContain('.data-consistency-grid{grid-template-columns:1fr}')
  })
})
