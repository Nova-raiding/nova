import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

describe('image candidate selection accessibility styles', () => {
  it('keeps the full selection control keyboard-visible', () => {
    expect(styles).toContain('.candidate-select-control:focus-within{outline:3px solid #176b4d')
    expect(styles).toContain('outline-offset:2px')
  })

  it('provides a usable target for candidate selection', () => {
    expect(styles).toContain('.candidate-select-control{min-height:44px')
    expect(styles).toContain('.candidate-select-control input{width:24px;height:24px')
  })
})
