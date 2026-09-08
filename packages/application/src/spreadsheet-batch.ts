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
  sku_id: 'sku_id', sku编码: 'sku_id', sku编号: 'sku_id',
  sku_name: 'sku_name', sku名称: 'sku_name',
  color: 'color', 颜色: 'color', size: 'size', 尺码: 'size',
  sku_price: 'sku_price', sku价格: 'sku_price', sku_stock: 'sku_stock', sku库存: 'sku_stock',
  sku_asset_ids: 'sku_asset_ids', sku素材id: 'sku_asset_ids', sku原图素材id: 'sku_asset_ids',
  sku_images: 'sku_images', sku图片: 'sku_images', sku图片链接: 'sku_images',
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

/** One SKU per row; stable product keys keep distinct products separate. */
export function spreadsheetFactsToBatchProducts(facts: Record<string, unknown>): Record<string, unknown>[] {
  if ((facts.format !== 'xlsx' && facts.format !== 'csv') || !Array.isArray(facts.rows)) throw new SpreadsheetBatchImportError(1, '仅支持已解析的 XLSX 或 CSV 商品表格')
  const sourceRows = facts.rows.filter(row => row && typeof row === 'object' && !Array.isArray(row)) as CellRow[]
  if (sourceRows.length < 2) throw new SpreadsheetBatchImportError(1, '必须包含表头和至少一行商品')
  const headers = new Map<string, string>()
  for (const [reference, value] of Object.entries(sourceRows[0]!)) {
    const key = facts.format === 'csv' ? reference : reference.replace(/\d+$/u, '')
    const mapped = aliases[normalizeHeader(facts.format === 'csv' ? reference : value)]
    if (mapped) {
      if ([...headers.values()].includes(mapped)) throw new SpreadsheetBatchImportError(1, `存在重复表头 ${mapped}`)
      headers.set(key, mapped)
    }
  }
  if (![...headers.values()].includes('platform') || ![...headers.values()].includes('title')) throw new SpreadsheetBatchImportError(1, '必须包含 platform 和 title 表头')
  const output: Record<string, unknown>[] = []
  const groups = new Map<string, Record<string, unknown>>()
  const platforms: Record<string, string> = { 京东: 'jd', 淘宝: 'taobao', 天猫: 'tmall', 拼多多: 'pinduoduo', 小红书: 'xiaohongshu', 抖音: 'douyin' }
  sourceRows.slice(1).forEach((raw, index) => {
    const rowNumber = index + 2
    const row: Record<string, unknown> = {}
    for (const [reference, value] of Object.entries(raw)) {
      const field = headers.get(facts.format === 'csv' ? reference : reference.replace(/\d+$/u, ''))
      if (field) row[field] = value
    }
    if (!Object.values(row).some(value => String(value ?? '').trim())) return
    const text = (field: string) => String(row[field] ?? '').trim()
    const title = text('title')
    const platformText = text('platform').toLowerCase()
    const platform = platforms[platformText] ?? platformText
    if (!platform) throw new SpreadsheetBatchImportError(rowNumber, 'platform不能为空')
    if (!title) throw new SpreadsheetBatchImportError(rowNumber, 'title不能为空')
    const assetIds = splitList(row.asset_ids)
    const images = splitList(row.images)
    const price = nonNegativeNumber(row.price, rowNumber, 'price')
    const stock = nonNegativeNumber(row.stock, rowNumber, 'stock', true)
    const skuCount = nonNegativeNumber(row.sku_count, rowNumber, 'sku_count', true)
    const product: Record<string, unknown> = { platform, title,
      ...Object.fromEntries(['account_id', 'remote_id', 'local_product_key', 'category', 'store_name', 'store_differentiation'].filter(field => text(field)).map(field => [field, text(field)])),
      ...(price === undefined ? {} : { price }), ...(stock === undefined ? {} : { stock }),
      ...(skuCount === undefined ? {} : { sku_count: skuCount }), ...(assetIds ? { asset_ids: assetIds } : {}), ...(images ? { images } : {}) }
    const hasSku = ['sku_id', 'sku_name', 'color', 'size', 'sku_price', 'sku_stock', 'sku_images', 'sku_asset_ids'].some(field => text(field))
    if (!hasSku) { output.push(product); return }
    if (!text('sku_id')) throw new SpreadsheetBatchImportError(rowNumber, 'SKU 行必须填写 SKU编码')
    if (!text('remote_id') && !text('local_product_key')) throw new SpreadsheetBatchImportError(rowNumber, 'SKU 行必须填写商品货号或平台商品ID')
    const skuPrice = nonNegativeNumber(text('sku_price') || row.price, rowNumber, 'SKU价格')
    const skuStock = nonNegativeNumber(text('sku_stock') || row.stock, rowNumber, 'SKU库存', true)
    if (skuPrice === undefined || skuStock === undefined) throw new SpreadsheetBatchImportError(rowNumber, 'SKU 行必须填写价格和库存，0 是有效值')
    const attributes = Object.fromEntries(['color', 'size'].filter(field => text(field)).map(field => [field, text(field)]))
    const skuImages = splitList(row.sku_images)
    const skuAssetIds = splitList(row.sku_asset_ids)
    const sku = { ...(skuAssetIds ? { sourceAssetIds: skuAssetIds } : {}), id: text('sku_id'), name: text('sku_name') || [text('color'), text('size')].filter(Boolean).join(' / ') || text('sku_id'), price: skuPrice, stock: skuStock, ...(Object.keys(attributes).length ? { attributes } : {}), ...(skuImages ? { images: skuImages } : images ? { images } : {}) }
    const key = JSON.stringify([platform, text('account_id'), text('remote_id') || text('local_product_key')])
    const existing = groups.get(key)
    if (!existing) {
      const first = { ...product, skus: [sku], sku_count: 1, price: skuPrice, stock: skuStock }
      groups.set(key, first); output.push(first); return
    }
    for (const field of ['title', 'category', 'local_product_key', 'remote_id', 'store_name', 'store_differentiation']) {
      if (existing[field] !== undefined && product[field] !== undefined && existing[field] !== product[field]) throw new SpreadsheetBatchImportError(rowNumber, `同一商品的 ${field} 不一致`)
      if (existing[field] === undefined && product[field] !== undefined) existing[field] = product[field]
    }
    const skus = existing.skus as typeof sku[]
    if (skus.some(item => item.id === sku.id)) throw new SpreadsheetBatchImportError(rowNumber, `同一商品存在重复 SKU编码 ${sku.id}`)
    skus.push(sku); existing.sku_count = skus.length; existing.price = Math.min(...skus.map(item => item.price)); existing.stock = skus.reduce((sum, item) => sum + item.stock, 0)
    for (const field of ['images', 'asset_ids']) {
      const combined = [...new Set([...(existing[field] as string[] ?? []), ...(product[field] as string[] ?? [])])]
      if (combined.length) existing[field] = combined
    }
  })
  if (!output.length) throw new SpreadsheetBatchImportError(2, '没有可导入的商品')
  if (output.length > 50) throw new SpreadsheetBatchImportError(1, '一次最多导入 50 个商品，请拆分表格')
  return output
}
