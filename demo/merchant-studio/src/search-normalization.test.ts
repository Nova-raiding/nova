import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { matchesSearchText } from './search-normalization.js'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

describe('merchant rule and category search normalization', () => {
  it('matches ASCII text without case sensitivity or surrounding whitespace', () => {
    expect(matchesSearchText('规格包含 SKU 信息', ' sku ')).toBe(true)
    expect(matchesSearchText('规格包含 sku 信息', 'SKU')).toBe(true)
  })

  it('trims whitespace while preserving Chinese text matching', () => {
    expect(matchesSearchText('服装 / 防晒外套', '  防晒外套  ')).toBe(true)
    expect(matchesSearchText('淘宝/天猫字段映射', ' 天猫字段 ')).toBe(true)
  })

  it('uses the same matcher for both rule packages and category fields', () => {
    expect(app).toContain('matchesSearchText(`${row.name}${row.scope}${row.version}`, query)')
    expect(app).toContain('matchesSearchText(`${row.name}${row.code}${row.fields.join(\'\')}`, query)')
  })
})
