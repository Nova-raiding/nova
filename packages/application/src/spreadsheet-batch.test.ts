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

it('groups SKU rows by product key and preserves per-SKU price, images and attributes', () => {
  const rows = [
    { A: '平台', B: '商品货号', C: '商品名称', D: 'SKU编码', E: '颜色', F: '尺码', G: 'SKU价格', H: 'SKU库存', I: 'SKU图片链接' },
    { A: '京东', B: 'J1', C: '外套', D: 'blue-m', E: '蓝色', F: 'M', G: '199', H: '0', I: 'https://images.example/blue.png' },
    { A: 'jd', B: 'J1', C: '外套', D: 'red-l', E: '红色', F: 'L', G: '209', H: '3', I: 'https://images.example/red.png' },
    { A: 'jd', B: 'J2', C: '另一款', D: 'blue-m', E: '蓝色', F: 'M', G: '99', H: '1' },
  ];
  const output = spreadsheetFactsToBatchProducts({ format: 'xlsx', rows });
  expect(output).toHaveLength(2);
  expect(output[0]).toMatchObject({ platform: 'jd', sku_count: 2, price: 199, stock: 3, skus: [{ id: 'blue-m', price: 199, stock: 0, attributes: { color: '蓝色', size: 'M' }, images: ['https://images.example/blue.png'] }, { id: 'red-l', price: 209, stock: 3, attributes: { color: '红色', size: 'L' }, images: ['https://images.example/red.png'] }] });
});

it('rejects duplicate SKU codes, conflicting product names and missing SKU prices with row numbers', () => {
  const header = { A: '平台', B: '商品货号', C: '商品名称', D: 'SKU编码', E: 'SKU价格', F: 'SKU库存' };
  const first = { A: 'jd', B: 'J1', C: '外套', D: 'm', E: '199', F: '1' };
  expect(() => spreadsheetFactsToBatchProducts({ format: 'xlsx', rows: [header, first, first] })).toThrow('第 3 行同一商品存在重复');
  expect(() => spreadsheetFactsToBatchProducts({ format: 'xlsx', rows: [header, first, { ...first, C: '背包', D: 'l' }] })).toThrow('第 3 行同一商品的 title 不一致');
  expect(() => spreadsheetFactsToBatchProducts({ format: 'xlsx', rows: [header, { ...first, E: '' }] })).toThrow('必须填写价格和库存');
});

it('maps equivalent CSV SKU rows identically and refuses repeated recognized headers', async () => {
  const facts = await parseDocumentFacts({ name: 'sku.csv', mimeType: 'text/csv', body: Buffer.from('平台,商品货号,商品名称,SKU编码,颜色,尺码,SKU价格,SKU库存\njd,J1,外套,blue-m,蓝色,M,199,1\njd,J1,外套,blue-l,蓝色,L,199,2\n') });
  expect(spreadsheetFactsToBatchProducts(facts)[0]).toMatchObject({ sku_count: 2, stock: 3 });
  expect(() => spreadsheetFactsToBatchProducts({ format: 'xlsx', rows: [{ A: '平台', B: '商品名称', C: 'title' }, { A: 'jd', B: '衣服', C: '鞋' }] })).toThrow('重复表头');
});

it('keeps SKU original asset references on the correct SKU instead of merging them into a product gallery', () => {
  const rows = [{ A: '平台', B: '商品货号', C: '商品名称', D: 'SKU编码', E: 'SKU价格', F: 'SKU库存', G: 'SKU原图素材ID' }, { A: 'jd', B: 'J1', C: '外套', D: 'blue-m', E: '199', F: '2', G: 'asset-blue' }, { A: 'jd', B: 'J1', C: '外套', D: 'red-l', E: '209', F: '3', G: 'asset-red' }]
  const [product] = spreadsheetFactsToBatchProducts({ format: 'xlsx', rows })
  expect(product?.skus).toMatchObject([{ id: 'blue-m', sourceAssetIds: ['asset-blue'] }, { id: 'red-l', sourceAssetIds: ['asset-red'] }])
  expect(product?.asset_ids).toBeUndefined()
})
