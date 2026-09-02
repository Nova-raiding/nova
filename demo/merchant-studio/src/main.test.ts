import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('global crash recovery accessibility contract', () => {
  it('focuses the explanatory error container and exposes a labelled recovery path', () => {
    const source = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8')

    expect(source).toContain('ref={this.crashRecoveryRef}')
    expect(source).toContain('role="alert" tabIndex={-1} aria-labelledby="app-crash-title" aria-describedby="app-crash-description"')
    expect(source).toContain('window.requestAnimationFrame(() => this.crashRecoveryRef.current?.focus({ preventScroll: true }))')
    expect(source).toContain('<p id="app-crash-description">')
    expect(source.match(/<button type="button"/g)).toHaveLength(2)
  })
})
