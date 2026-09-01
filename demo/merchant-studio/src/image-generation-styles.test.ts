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

  it('keeps the gallery usable across desktop widths', () => {
    expect(styles).toContain('.image-generation-job-panel{width:100%;min-width:0}')
    expect(styles).toContain('@media (min-width:1200px){.image-candidate-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}')
  })

  it('reserves a stable 4:3 image surface', () => {
    expect(styles).toContain('.image-candidate-grid img,.image-candidate-fallback{aspect-ratio:4 / 3;max-width:100%}')
  })

  it('wraps long identifiers without horizontal overflow', () => {
    expect(styles).toContain('overflow-wrap:anywhere;word-break:break-word;white-space:normal')
    expect(styles).toContain('.image-candidate-metadata span')
  })

  it('honors reduced motion within the image-generation panel', () => {
    expect(styles).toContain('@media (prefers-reduced-motion:reduce){.image-generation-job-panel *')
    expect(styles).toContain('animation-iteration-count:1!important')
  })
})
