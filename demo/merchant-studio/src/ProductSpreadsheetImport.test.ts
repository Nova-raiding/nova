import React from 'react'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AssetMetadata } from './api.js'
import { ProductSpreadsheetImport, spreadsheetImportScanState, spreadsheetPreviewRows, validateSpreadsheetImportMode } from './ProductSpreadsheetImport.js'

const accounts = [{ platform: 'jd' as const, accountId: 'jd-store-1', state: 'connected', readEnabled: true, writeEnabled: true }]
const product = { platform: 'jd' as const, title: '冲锋衣', account_id: 'jd-store-1' }
const source = readFileSync(new URL('./ProductSpreadsheetImport.tsx', import.meta.url), 'utf8')
const scannedAsset = (overrides: Partial<AssetMetadata> = {}) => ({
  id: 'asset-spreadsheet-test', workspaceId: 'ws-spreadsheet-test', name: 'products.csv', mimeType: 'text/csv', sizeBytes: 10,
  scanStatus: 'clean', scanVerdict: 'clean', scanReceiptId: 'receipt-spreadsheet-test', scanReceiptDigest: 'a'.repeat(64),
  storageKey: 'clean/ws-spreadsheet-test/products.csv', rightsStatus: 'pending', parseStatus: 'pending',
  contentTrust: { classification: 'untrusted', mode: 'data_only', canOverrideInstructions: false, canTriggerTools: false, requiresMerchantConfirmation: true },
  references: [], revision: 1, createdAt: '2026-10-10T00:00:00.000Z',
  ...overrides,
}) as AssetMetadata

describe('Merchant Studio spreadsheet import', () => {
  it('waits for the real scanner while quarantine is pending and only parses clean assets', () => {
    expect(spreadsheetImportScanState(scannedAsset({ scanStatus: 'quarantined' }))).toBe('pending')
    expect(spreadsheetImportScanState(scannedAsset({ scanStatus: 'unscanned' }))).toBe('pending')
    expect(spreadsheetImportScanState(undefined)).toBe('pending')
    expect(spreadsheetImportScanState(scannedAsset())).toBe('ready')
    expect(spreadsheetImportScanState(scannedAsset({ scanReceiptId: undefined, scanReceiptDigest: undefined, scanVerdict: undefined }))).toBe('blocked')
    expect(spreadsheetImportScanState(scannedAsset({ scanReceiptDigest: 'invalid' }))).toBe('blocked')
    for (const status of ['blocked', 'rejected', 'failed']) expect(spreadsheetImportScanState(scannedAsset({ scanStatus: status }))).toBe('blocked')
  })
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

  it('shows imported product knowledge and SKU specifications in the preview', () => {
    const [row] = spreadsheetPreviewRows([{ platform: 'jd', title: '运动鞋', attributes: { brand: '贵人鸟', material: '网布', specification: '运动鞋' }, selling_points: [{ text: '轻便', source_ids: ['asset-1'] }], skus: [{ id: 'jd-1', name: '蓝色 42', price: 99, stock: 2, attributes: { specification: '42码' } }] }], 'draft_only')
    expect(row).toMatchObject({ brand: '贵人鸟', material: '网布', specification: '42码', sellingPointCount: 1 })
  })

  it('exposes preview and failure recovery semantics', () => {
    const html = renderToStaticMarkup(React.createElement(ProductSpreadsheetImport, { baseUrl: '/api', accounts, canWrite: true }))
    expect(html).toContain('安全检查')
    expect(html).toContain('绑定真实店铺')
    expect(source).toContain('merchant-spreadsheet-import-error')
    expect(source).toContain('aria-live="polite"')
  })
})
