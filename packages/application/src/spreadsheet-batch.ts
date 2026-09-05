export class SpreadsheetBatchImportError extends Error {
  readonly row: number

  constructor(row: number, message: string) {
    super(`第 ${row} 行${message}`)
    this.name = 'SpreadsheetBatchImportError'
    this.row = row
  }
}

type CellRow = Record<string, unknown>

const aliases: Record<string, string> = {
  platform: 'platform', 平台: 'platform',
  account_id: 'account_id', 店铺账号: 'account_id', 店铺: 'account_id',
  remote_id: 'remote_id', 平台商品id: 'remote_id', 商品id: 'remote_id',
  local_product_key: 'local_product_key', 商品货号: 'local_product_key', 货号: 'local_product_key',
  title: 'title', 商品标题: 'title', 商品名称: 'title',
  category: 'category', 类目: 'category',
  price: 'price', 价格: 'price',
  stock: 'stock', 库存: 'stock',
  sku_count: 'sku_count', sku数量: 'sku_count',
  asset_ids: 'asset_ids', 素材id: 'asset_ids', 素材ids: 'asset_ids',
  images: 'images', 图片: 'images',
  store_name: 'store_name', 店铺名称: 'store_name',
  store_differentiation: 'store_differentiation', 店铺差异化: 'store_differentiation',
}

function normalizeHeader(value: unknown): string {
  return String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/[\s-]+/gu, '_')
}

function columnNumber(reference: string): number {
  let result = 0
  for (const character of reference.toUpperCase()) result = result * 26 + character.charCodeAt(0) - 64
  return result
}

function splitList(value: unknown): string[] | undefined {
  if (value === undefined || value === null || String(value).trim() === '') return undefined
  const values = String(value).split(/[\n,，;；|]/u).map(item => item.trim()).filter(Boolean)
  return values.length ? [...new Set(values)] : undefined
}

function nonNegativeNumber(value: unknown, row: number, field: string, integer = false): number | undefined {
  if (value === undefined || value === null || String(value).trim() === '') return undefined
  const result = Number(String(value).trim())
  if (!Number.isFinite(result) || result < 0 || (integer && !Number.isInteger(result))) throw new SpreadsheetBatchImportError(row, `${field}必须是非负${integer ? '整数' : '数字'}`)
  return result
}

/** Convert parser-produced XLSX/CSV rows into the same input shape as catalog.import.batch. */
export function spreadsheetFactsToBatchProducts(facts: Record<string, unknown>): Record<string, unknown>[] {
  if ((facts.format !== 'xlsx' && facts.format !== 'csv') || !Array.isArray(facts.rows)) throw new SpreadsheetBatchImportError(1, '仅支持已解析的 XLSX 或 CSV 商品表格')
  const sourceRows = facts.rows.filter(row => row && typeof row === 'object' && !Array.isArray(row)) as CellRow[]
  if (sourceRows.length < 2) throw new SpreadsheetBatchImportError(1, '必须包含表头和至少一行商品')
  if (facts.format === 'csv') {
    const headerRow = sourceRows[0]!
    if (!Object.keys(headerRow).some(key => aliases[normalizeHeader(key)] === 'platform') || !Object.keys(headerRow).some(key => aliases[normalizeHeader(key)] === 'title')) throw new SpreadsheetBatchImportError(1, '必须包含 platform 和 title 表头')
    return sourceRows.slice(1).map((raw, index) => {
      const rowNumber = index + 2
      const row = Object.fromEntries(Object.entries(raw).map(([key, value]) => [aliases[normalizeHeader(key)] ?? normalizeHeader(key), value]))
      const title = String(row.title ?? '').trim(); const platform = String(row.platform ?? '').trim().toLowerCase()
      if (!platform) throw new SpreadsheetBatchImportError(rowNumber, 'platform不能为空')
      if (!title) throw new SpreadsheetBatchImportError(rowNumber, 'title不能为空')
      const price = nonNegativeNumber(row.price, rowNumber, 'price'); const stock = nonNegativeNumber(row.stock, rowNumber, 'stock', true); const skuCount = nonNegativeNumber(row.sku_count, rowNumber, 'sku_count', true)
      const assetIds = splitList(row.asset_ids); const images = splitList(row.images)
      return { platform, title, ...(row.account_id ? { account_id: String(row.account_id).trim() } : {}), ...(row.remote_id ? { remote_id: String(row.remote_id).trim() } : {}), ...(row.local_product_key ? { local_product_key: String(row.local_product_key).trim() } : {}), ...(row.category ? { category: String(row.category).trim() } : {}), ...(price === undefined ? {} : { price }), ...(stock === undefined ? {} : { stock }), ...(skuCount === undefined ? {} : { sku_count: skuCount }), ...(assetIds ? { asset_ids: assetIds } : {}), ...(images ? { images } : {}), ...(row.store_name ? { store_name: String(row.store_name).trim() } : {}), ...(row.store_differentiation ? { store_differentiation: String(row.store_differentiation).trim() } : {}) }
    })
  }
  const headerRow = sourceRows[0]!
  const headers = new Map<number, string>()
  for (const [reference, value] of Object.entries(headerRow)) {
    const column = columnNumber(reference.replace(/\d+$/u, ''))
    const mapped = aliases[normalizeHeader(value)]
    if (column > 0 && mapped) headers.set(column, mapped)
  }
  if (![...headers.values()].includes('platform') || ![...headers.values()].includes('title')) throw new SpreadsheetBatchImportError(1, '必须包含 platform 和 title 表头')
  return sourceRows.slice(1).map((raw, index) => {
    const rowNumber = index + 2
    const row: Record<string, unknown> = {}
    for (const [reference, value] of Object.entries(raw)) {
      const column = columnNumber(reference.replace(/\d+$/u, ''))
      const field = headers.get(column)
      if (field) row[field] = value
    }
    const title = String(row.title ?? '').trim()
    const platform = String(row.platform ?? '').trim().toLowerCase()
    if (!platform) throw new SpreadsheetBatchImportError(rowNumber, 'platform不能为空')
    if (!title) throw new SpreadsheetBatchImportError(rowNumber, 'title不能为空')
    const assetIds = splitList(row.asset_ids)
    const images = splitList(row.images)
    const price = nonNegativeNumber(row.price, rowNumber, 'price')
    const stock = nonNegativeNumber(row.stock, rowNumber, 'stock', true)
    const skuCount = nonNegativeNumber(row.sku_count, rowNumber, 'sku_count', true)
    return {
      platform,
      title,
      ...(row.account_id ? { account_id: String(row.account_id).trim() } : {}),
      ...(row.remote_id ? { remote_id: String(row.remote_id).trim() } : {}),
      ...(row.local_product_key ? { local_product_key: String(row.local_product_key).trim() } : {}),
      ...(row.category ? { category: String(row.category).trim() } : {}),
      ...(price === undefined ? {} : { price }),
      ...(stock === undefined ? {} : { stock }),
      ...(skuCount === undefined ? {} : { sku_count: skuCount }),
      ...(assetIds ? { asset_ids: assetIds } : {}),
      ...(images ? { images } : {}),
      ...(row.store_name ? { store_name: String(row.store_name).trim() } : {}),
      ...(row.store_differentiation ? { store_differentiation: String(row.store_differentiation).trim() } : {}),
    }
  })
}
