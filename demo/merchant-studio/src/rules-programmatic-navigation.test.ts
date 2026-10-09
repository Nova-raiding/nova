import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { merchantNavigationPage } from './navigation.js'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

describe('merchant rules page navigation', () => {
  it('keeps programmatic rules navigation on the dedicated rules page', () => {
    expect(merchantNavigationPage('rules')).toBe('rules')
    expect(app).toContain('const effectivePage: Page = merchantNavigationPage(nextPage)')
    expect(app).toContain("{page === 'rules' && <Rules baseUrl={apiBaseUrl} />}")
  })

  it('makes the dedicated rules page discoverable from the merchant sidebar', () => {
    expect(app).toContain("{ id: 'rules', label: '规则与类目', icon: ShieldCheck")
  })
})
