import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

describe('merchant error notice accessibility contract', () => {
  it('keeps retry controls from submitting an ancestor form', () => {
    expect(app).toContain('className="text-button"\n          type="button"')
  })

  it('connects retry guidance to the visible error and hides decorative iconography', () => {
    expect(app).toContain('aria-describedby={messageId}')
    expect(app).toContain('<AlertCircle size={16} aria-hidden="true" />')
    expect(app).toContain('const messageId = `merchant-error-${useId().replace(/:/g, \'\')}`')
  })

  it('keeps the desktop retry target keyboard-friendly', () => {
    expect(styles).toContain('.primary,.secondary,.danger-action,.text-button')
    expect(styles).toContain('min-height:44px')
  })
})
