import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

describe('merchant overview and catalog screenshot copy', () => {
  it('keeps the overview kicker labels aligned with the reference screenshot', () => {
    expect(app).toContain('<span className="section-kicker">DAILY BRIEFING</span>')
    expect(app).toContain('<span className="section-kicker">ACCOUNT OVERVIEW</span>')
    expect(app).toContain('<span className="section-kicker">ACTION CENTER</span>')
  })

  it('keeps the platform and store page kicker aligned with the reference screenshot', () => {
    expect(app).toContain('<span className="section-kicker">PLATFORM &amp; STORE</span>')
  })

  it('keeps the materials and brand section labels aligned with the screenshots', () => {
    expect(app).toContain('<span className="section-kicker">MATERIAL LIBRARY</span>')
    expect(app).toContain('按店铺独立管理图片与视频。')
    expect(app).toContain('<span className="section-kicker">BRAND ASSETS</span>')
    expect(app).toContain('<span className="section-kicker">BRAND SETTINGS</span>')
    expect(app).toContain('<span className="section-kicker">RECYCLE BIN</span>')
  })
})
