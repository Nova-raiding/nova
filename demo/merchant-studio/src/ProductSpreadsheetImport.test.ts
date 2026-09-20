import React from 'react'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProductSpreadsheetImport, spreadsheetPreviewRows, validateSpreadsheetImportMode } from './ProductSpreadsheetImport.js'

const accounts = [{ platform: 'jd' as const, accountId: 'jd-store-1', state: 'connected', readEnabled: true, writeEnabled: true }]
const product = { platform: 'jd' as const, title: '冲锋衣', account_id: 'jd-store-1' }
const source = readFileSync(new URL('./ProductSpreadsheetImport.tsx', import.meta.url), 'utf8')

describe('Merchant Studio spreadsheet import', () => {
  it('allows a draft without a store and exposes the draft submit action', () => {
    expect(validateSpreadsheetImportMode([{ platform: 'jd', title: '草稿', account_id: '' }], 'draft_only', [])).toBeNull()
    const html = renderToStaticMarkup(React.createElement(ProductSpreadsheetImport, { baseUrl: '/api', accounts: [], canWrite: true }))
    expect(html).toContain('仅草稿')
    expect(html).toContain('无需店铺账号')
    expect(source).toContain("mode === 'draft_only' ? '确认并创建草稿'")
    expect(html).toContain('Excel / CSV 导入商品与 SKU')
  })

  it('requires a connected readable account for real-store imports', () => {
    expect(validateSpreadsheetImportMode([{ platform: 'jd', title: '商品' }], 'store', accounts)).toContain('未填写店铺账号')
    expect(validateSpreadsheetImportMode([{ ...product, account_id: 'unknown' }], 'store', accounts)).toContain('未连接或不可读取')
    expect(validateSpreadsheetImportMode([product], 'store', accounts)).toBeNull()
  })

  // Regression: the preview table resolved each row's 店铺账号 with
  // `products.find(item => item.title === row.title)`, so two rows sharing a
  // title (the same product on a second platform, or a repeated name) both
  // showed the first product's account — the merchant's pre-import verification
  // named a store that row would not be imported into.
  it('shows each preview row its own store account, not another row with the same title', () => {
    const rows = spreadsheetPreviewRows([
      { platform: 'jd', title: '轻云防晒外套', account_id: 'jd-store-1', skus: [{ id: 'sku-1', name: '米白', price: 169, stock: 8 }] },
      { platform: 'taobao', title: '轻云防晒外套', account_id: 'taobao-store-9', skus: [{ id: 'sku-1', name: '米白', price: 179, stock: 3 }] },
      { platform: 'jd', title: '桌面阅读灯', account_id: 'jd-store-1' },
    ], 'store')
    expect(rows.map((row) => row.storeLabel)).toEqual(['jd-store-1', 'taobao-store-9', 'jd-store-1'])
    expect(new Set(rows.map((row) => row.key)).size).toBe(3)
    // The table renders the row label, so it cannot re-derive a store from the title.
    expect(source).not.toContain('products.find((product) => product.title === row.title)')
    expect(source).toContain('<td>{row.storeLabel}</td>')
  })

  it('still labels a draft-only row without a store account', () => {
    const rows = spreadsheetPreviewRows([{ platform: 'jd', title: '草稿', account_id: '' }], 'draft_only')
    expect(rows.map((row) => row.storeLabel)).toEqual(['仅草稿'])
    expect(spreadsheetPreviewRows([{ platform: 'jd', title: '商品' }], 'store').map((row) => row.storeLabel)).toEqual(['待填写'])
  })

  it('exposes preview and failure recovery semantics', () => {
    const html = renderToStaticMarkup(React.createElement(ProductSpreadsheetImport, { baseUrl: '/api', accounts, canWrite: true }))
    expect(html).toContain('安全检查')
    expect(html).toContain('绑定真实店铺')
    expect(source).toContain('merchant-spreadsheet-import-error')
    expect(source).toContain('aria-live="polite"')
  })
})
