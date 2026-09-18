import React from 'react'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProductSpreadsheetImport, validateSpreadsheetImportMode } from './ProductSpreadsheetImport.js'

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

  it('exposes preview and failure recovery semantics', () => {
    const html = renderToStaticMarkup(React.createElement(ProductSpreadsheetImport, { baseUrl: '/api', accounts, canWrite: true }))
    expect(html).toContain('安全检查')
    expect(html).toContain('绑定真实店铺')
    expect(source).toContain('merchant-spreadsheet-import-error')
    expect(source).toContain('aria-live="polite"')
  })
})
