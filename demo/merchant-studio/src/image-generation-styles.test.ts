import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

describe('image candidate selection accessibility styles', () => {
  const contrastRatio = (foreground: string, background: string) => {
    const channel = (hex: string, offset: number) => {
      const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    }
    const luminance = (hex: string) => 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5)
    const light = Math.max(luminance(foreground), luminance(background))
    const dark = Math.min(luminance(foreground), luminance(background))
    return (light + 0.05) / (dark + 0.05)
  }

  it('uses AA-readable status tokens and visible semantic state text', () => {
    expect(contrastRatio('#43534a', '#ffffff')).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio('#43534a', '#f7f9fb')).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio('#7a2424', '#f1f4f6')).toBeGreaterThanOrEqual(4.5)
    expect(styles).toContain('.image-generation-job-panel .info-notice')
    expect(styles).toContain('.image-generation-job-panel .image-candidate-gates')
    expect(styles).toContain('color: #43534a')
    expect(styles).toContain('color: #7a2424')
  })

  it('keeps the job status badge AA-readable for every semantic tone', () => {
    expect(contrastRatio('#43534a', '#eef1ee')).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio('#0f513a', '#e5f2eb')).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio('#285a9d', '#eaf1fb')).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio('#85520b', '#fff5d9')).toBeGreaterThanOrEqual(4.5)
    expect(styles).toContain('.image-generation-job-panel .status-chip.blue')
    expect(styles).toContain('.image-generation-job-panel .status-chip.amber')
  })

  it('keeps the full selection control keyboard-visible', () => {
    expect(styles).toContain('.candidate-select-control:focus-within{outline:3px solid #176b4d')
    expect(styles).toContain('outline-offset:2px')
  })

  it('keeps the focused candidate card visible without changing its layout bounds', () => {
    expect(styles).toContain('.image-candidate-grid figure:focus-within{outline:3px solid #176b4d;outline-offset:3px}')
  })

  it('provides a usable target for candidate selection', () => {
    expect(styles).toContain('.candidate-select-control{min-height:44px')
    expect(styles).toContain('.candidate-select-control input{width:24px;height:24px')
    expect(styles).toContain('.image-generation-job-panel button{min-height:44px}')
  })

  it('keeps the gallery usable across desktop widths', () => {
    expect(styles).toContain('.image-generation-job-panel{width:100%;min-width:0}')
    expect(styles).toContain('@media (min-width:1200px){.image-candidate-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}')
    expect(styles).toContain('.image-generation-job-panel{inline-size:100%;max-inline-size:100%;min-inline-size:0;overflow-x:clip}')
    expect(styles).toContain('@media (min-width:1280px){.image-candidate-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}')
    expect(styles).toContain('@media (min-width:1440px){.image-candidate-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}')
    expect(styles).toContain('@media (min-width:1920px){.image-candidate-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}')
  })

  it('reserves a stable 4:3 image surface', () => {
    expect(styles).toContain('.image-candidate-grid img,.image-candidate-fallback{aspect-ratio:4 / 3;max-width:100%}')
  })

  it('wraps long identifiers without horizontal overflow', () => {
    expect(styles).toContain('overflow-wrap:anywhere;word-break:break-word;white-space:normal')
    expect(styles).toContain('.image-candidate-metadata span')
    expect(styles).toContain('.image-generation-job-row,.image-generation-job-row>div{min-inline-size:0}')
    expect(styles).toContain('.image-candidate-grid figure,.image-candidate-grid figcaption{min-inline-size:0}')
  })

  it('honors reduced motion within the image-generation panel', () => {
    expect(styles).toContain('@media (prefers-reduced-motion:reduce){.image-generation-job-panel *')
    expect(styles).toContain('animation-iteration-count:1!important')
  })

  it('provides a stable candidate skeleton for the initial desktop load', () => {
    expect(styles).toContain('.image-candidate-loading{display:grid;grid-template-columns:repeat(3,minmax(0,1fr))')
    expect(styles).toContain('.image-candidate-skeleton-media{width:100%;aspect-ratio:4/3')
    expect(styles).toContain('@media (prefers-reduced-motion:no-preference){.image-candidate-skeleton-media')
  })

  it('uses one cancellable semantic transition for candidate selection', () => {
    expect(styles).toContain('.image-generation-job-panel{--image-state-transition:180ms ease-out}')
    expect(styles).toContain('transition:border-color var(--image-state-transition),box-shadow var(--image-state-transition),background-color var(--image-state-transition)')
    expect(styles).not.toContain('transition:all var(--image-state-transition)')
    expect(styles).not.toContain('transition:width var(--image-state-transition)')
    expect(styles).toContain('.image-candidate-grid figure.candidate-selected')
    expect(styles).toContain('@media (prefers-reduced-motion:reduce){.image-generation-job-panel{--image-state-transition:.01ms linear}')
  })
})
