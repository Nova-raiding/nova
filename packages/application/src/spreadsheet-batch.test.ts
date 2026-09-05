import { describe, expect, it } from 'vitest'
import { spreadsheetFactsToBatchProducts, SpreadsheetBatchImportError } from './spreadsheet-batch.js'
import { parseDocumentFacts } from './document-parser.js'

describe('spreadsheet batch import mapping', () => {
  it('maps parsed XLSX rows and Chinese aliases to product import rows', () => {
    const products = spreadsheetFactsToBatchProducts({
      format: 'xlsx',
      rows: [
        { A1: '平台', B1: '商品名称', C1: '店铺账号', D1: '价格', E1: '库存', F1: '素材ID' },
        { A2: 'taobao', B2: '轻云外套', C2: 'store-a', D2: '99.00', E2: '8', F2: 'asset-a, asset-b' },
        { A3: 'jd', B3: '城市背包', C3: 'store-b', D3: 129, E3: 3 },
      ],
    })
    expect(products).toEqual([
      { platform: 'taobao', title: '轻云外套', account_id: 'store-a', price: 99, stock: 8, asset_ids: ['asset-a', 'asset-b'] },
      { platform: 'jd', title: '城市背包', account_id: 'store-b', price: 129, stock: 3 },
    ])
  })

  it('rejects unparsed or incomplete table facts before import', () => {
    expect(() => spreadsheetFactsToBatchProducts({ format: 'csv', rows: [] })).toThrowError(SpreadsheetBatchImportError)
    expect(() => spreadsheetFactsToBatchProducts({ format: 'xlsx', rows: [{ A1: '平台' }, { A2: 'taobao' }] })).toThrowError('必须包含 platform 和 title 表头')
    expect(() => spreadsheetFactsToBatchProducts({ format: 'xlsx', rows: [{ A1: 'platform', B1: 'title' }, { A2: 'taobao', B2: '' }] })).toThrowError('第 2 行title不能为空')
  })

  it('parses CSV rows and maps quoted cells through the same adapter', async () => {
    const facts = await parseDocumentFacts({ name: 'products.csv', mimeType: 'text/csv', body: Buffer.from('platform,title,price,stock\ntaobao,"轻云,外套",99,5\n') })
    expect(facts).toMatchObject({ format: 'csv', rows: [{ platform: 'platform', title: 'title' }, { platform: 'taobao', title: '轻云,外套' }] })
    expect(spreadsheetFactsToBatchProducts(facts)).toEqual([{ platform: 'taobao', title: '轻云,外套', price: 99, stock: 5 }])
  })
})
