import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { merchantRouteFromLocation } from './navigation.js'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

describe('merchant rule and category discovery', () => {
  it('routes the legacy rules URL to the dedicated Rules page on direct navigation and refresh', () => {
    const location = { pathname: '/merchant/rules', search: '', hash: '' }
    expect(merchantRouteFromLocation(location)).toEqual({
      page: 'rules',
      searchQuery: '',
    })
    expect(merchantRouteFromLocation({ ...location, pathname: '/merchant/rules/' })).toEqual({
      page: 'rules',
      searchQuery: '',
    })
    expect(app).toContain("{page === 'rules' && <Rules baseUrl={apiBaseUrl} />}")
  })

  it('filters category cards by selected platform and reports filtered results', () => {
    expect(app).toContain('(platform === \'all\' || row.platforms.includes(platform))')
    expect(app).toContain("['loading', 'api_error'].includes(categoriesData.mode) ? '—' : filteredCategories.length")
  })

  it('shows rule classification only for rules and labels the category platform filter', () => {
    expect(app).toContain("{tab === 'rules' && (")
    expect(app).toContain("{tab === 'rules' ? '规则平台' : '品类平台'}")
  })

  it('names the category detail as a field template instead of a platform mapping', () => {
    expect(app).toContain('<span className="section-kicker">类目字段模板</span>')
    expect(app).toContain('{selectedCategory.name} · 类目字段模板')
  })
})
