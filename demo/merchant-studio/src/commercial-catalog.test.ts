import { describe, expect, it } from 'vitest'
import { normalizeCommercialCatalog, selectMerchantCatalogItems, type CommercialCatalogItem } from './api'

const item = (overrides: Partial<CommercialCatalogItem>): CommercialCatalogItem => ({
  id: 'sku-basic', sku_code: 'basic', name: '基础版', type: 'monthly', visibility: 'public',
  version: 'v1', price_label: '¥2,000', cycle_label: '每月', benefits_summary: '5,000 点',
  benefits: [], approval_state: 'draft', valid_from: null, valid_to: null, unresolved: ['尚未批准'],
  checksum: 'checksum', executable: false, ...overrides,
})

describe('merchant commercial catalog projection', () => {
  it('normalizes the server-owned snapshot shape before rendering', () => {
    const catalog = normalizeCommercialCatalog({ catalog: [{ id: 'sku-basic', code: 'basic', kind: 'monthly', version: 2, lifecycle: 'approved', executable: true, priceFen: 200000, payload: { creativePoints: 5000, maxBrands: 1, maxStores: 5, blockers: [] }, benefits: [], checksum: 'sha' }] })
    expect(catalog.catalog[0]).toMatchObject({ sku_code: 'basic', name: '基础版', version: 2, price_label: '¥2000.00', executable: true })
  })

  it('shows one choice per SKU and prefers the approved executable version', () => {
    const selected = selectMerchantCatalogItems([
      item({ version: 'v1' }),
      item({ version: 2, approval_state: 'approved', executable: true, unresolved: [] }),
      item({ sku_code: 'points_500', id: 'sku-points-500', name: '500 点包', version: 'v1' }),
    ])
    expect(selected).toHaveLength(2)
    expect(selected.find(value => value.sku_code === 'basic')).toMatchObject({ version: 2, executable: true })
  })

  it('keeps the newest blocked version when no approved version exists', () => {
    const selected = selectMerchantCatalogItems([
      item({ version: 'v1', unresolved: ['旧阻断'] }),
      item({ version: 'v2', unresolved: ['新阻断'] }),
    ])
    expect(selected).toHaveLength(1)
    expect(selected[0]).toMatchObject({ version: 'v2', unresolved: ['新阻断'] })
  })
})
