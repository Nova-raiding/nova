import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

describe('merchant overview desktop layout contract', () => {
  it('scopes overview compression to the overview route', () => {
    expect(app).toContain("page === 'overview' ? 'overview-page' : ''")
    expect(styles).toContain('.overview-page .page-stack > .wallet-panel')
    expect(styles).not.toMatch(/(?:^|\n)\.page-stack > \.wallet-panel/u)
  })

  it('removes the empty dashboard track and uses two compact desktop connection columns', () => {
    expect(styles).toMatch(
      /\.overview-page \.page-stack > \.dashboard-grid\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/u,
    )
    expect(styles).toMatch(
      /@media \(min-width:\s*1200px\)[\s\S]*?\.overview-page \.platform-list\s*\{\s*display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/u,
    )
  })
})
