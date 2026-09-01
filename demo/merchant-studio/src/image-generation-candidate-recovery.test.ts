import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

describe('image candidate desktop recovery contract', () => {
  it('associates the recoverable image error with its keyboard action', () => {
    expect(app).toContain('role="alert" aria-labelledby={`candidate-image-error-${index}`}')
    expect(app).toContain('className="text-button image-candidate-retry"')
    expect(app).toContain('aria-describedby={`candidate-image-error-${index}`}')
    expect(app).toContain('setImageReloads')
  })

  it('keeps the retry target at least 44px and preserves reduced motion rules', () => {
    expect(styles).toContain('.image-candidate-retry{min-width:44px;min-height:44px;')
    expect(styles).toContain('@media (prefers-reduced-motion:reduce)')
  })
})
