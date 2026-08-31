import { describe, expect, it } from 'vitest'
import { resolveDataConsistency } from './data-consistency.js'

const input = (overrides: Partial<Parameters<typeof resolveDataConsistency>[0]> = {}) => ({
  apiConfigured: true, productsLoaded: true, productCount: 2, accountsLoaded: true, accountsError: false,
  selectedCount: 0, productsWithIdentity: 2, productsWithAssets: 2, ...overrides,
})

describe('resolveDataConsistency', () => {
  it('does not call loaded products verified when canonical status is missing', () => {
    const item = resolveDataConsistency(input()).find(candidate => candidate.id === 'products')!
    expect(item.status).toBe('amber')
    expect(item.detail).toContain('标准链结果尚未取得')
  })

  it('uses verified language only when every product has a verified canonical status', () => {
    const item = resolveDataConsistency(input({ canonicalStatuses: ['verified', 'verified'] })).find(candidate => candidate.id === 'products')!
    expect(item.status).toBe('green')
    expect(item.statusLabel).toBe('标准链已验证')
  })

  it('keeps unverified canonical products actionable and non-green', () => {
    const item = resolveDataConsistency(input({ canonicalStatuses: ['verified', 'blocked'] })).find(candidate => candidate.id === 'products')!
    expect(item.status).toBe('amber')
    expect(item.statusLabel).toBe('待标准链核验')
    expect(item.nextStep).toContain('标准链核验')
  })
})
