import { createHash } from 'node:crypto'
import type { KnowledgeRepository, KnowledgeAsset, KnowledgeDocument, KnowledgeChunk, KnowledgeAssetBinding } from '../../../packages/persistence/src/knowledge.js'

type ProductLike = {
  id: string
  workspaceId: string
  title: string
  platform: string
  category?: string
  storeName?: string
  accountId?: string
  price?: number
  stock?: number
  skuCount?: number
  attributes?: Record<string, string>
  sellingPoints?: readonly { id: string; text: string; proofStatus?: string }[]
  skus?: readonly { id: string; name: string; price: number; stock: number; attributes?: Record<string, string>; sourceAssetIds?: readonly string[] }[]
}

export type ImportedKnowledgeProjection = {
  assets: KnowledgeAsset[]
  documents: KnowledgeDocument[]
  chunks: KnowledgeChunk[]
  bindings: KnowledgeAssetBinding[]
}

const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
function productText(product: ProductLike): string {
  const lines = [
    `商品名称：${product.title}`,
    `平台：${product.platform}`,
    ...(product.category ? [`类目：${product.category}`] : []),
    ...(product.storeName ? [`店铺：${product.storeName}`] : []),
    ...(product.accountId ? [`店铺账号：${product.accountId}`] : []),
    ...(product.price !== undefined ? [`商品价格：${product.price}`] : []),
    ...(product.stock !== undefined ? [`商品库存：${product.stock}`] : []),
    ...(product.attributes ? [`商品属性：${JSON.stringify(product.attributes)}`] : []),
    ...(product.sellingPoints?.length ? [`卖点：${product.sellingPoints.map(point => `${point.text}（${point.proofStatus ?? 'pending'}）`).join('；')}`] : []),
    ...(product.skus?.length ? [`SKU：${product.skus.map(sku => `${sku.id} ${sku.name} 价格${sku.price} 库存${sku.stock}${sku.attributes ? ` 属性${JSON.stringify(sku.attributes)}` : ''}`).join('；')}`] : []),
  ]
  return lines.join('\n')
}

/**
 * Projects an imported spreadsheet product into durable knowledge records.
 * Records deliberately remain pending/unknown and queued: approval, rights
 * confirmation and embedding workers are separate safety gates.
 */
export async function projectImportedProductsToKnowledge(input: {
  repository: KnowledgeRepository
  workspaceId: string
  products: readonly ProductLike[]
  sourceAssetId?: string
  sourceVersion?: number
  sourceMetadata?: Record<string, unknown>
}): Promise<ImportedKnowledgeProjection> {
  const assets: KnowledgeAsset[] = []
  const documents: KnowledgeDocument[] = []
  const chunks: KnowledgeChunk[] = []
  const bindings: KnowledgeAssetBinding[] = []
  for (const product of input.products) {
    const text = productText(product)
    const contentHash = hash(text)
    const asset = await input.repository.createAsset({
      id: `knowledge_asset_product_${product.id}`,
      workspaceId: input.workspaceId,
      kind: 'product_facts',
      name: `${product.title} 商品事实`,
      content: product,
      ...(input.sourceAssetId ? { sourceAssetId: input.sourceAssetId } : {}),
      productId: product.id,
      sourceVersion: input.sourceVersion ?? 1,
      approvalStatus: 'pending',
      rightsStatus: 'unknown',
      indexState: 'queued',
    })
    assets.push(asset)
    bindings.push(await input.repository.bindAsset({ workspaceId: input.workspaceId, knowledgeAssetId: asset.id, ...(input.sourceAssetId ? { sourceAssetId: input.sourceAssetId } : {}), productId: product.id, sourceVersion: input.sourceVersion ?? 1, bindingType: 'spreadsheet_facts' }))
    for (const sku of product.skus ?? []) bindings.push(await input.repository.bindAsset({ workspaceId: input.workspaceId, knowledgeAssetId: asset.id, ...(input.sourceAssetId ? { sourceAssetId: input.sourceAssetId } : {}), productId: product.id, skuId: sku.id, sourceVersion: input.sourceVersion ?? 1, bindingType: 'spreadsheet_facts' }))
    const document = await input.repository.createDocument({
      id: `knowledge_document_product_${product.id}`,
      workspaceId: input.workspaceId,
      knowledgeAssetId: asset.id,
      ...(input.sourceAssetId ? { sourceAssetId: input.sourceAssetId } : {}),
      sourceVersion: input.sourceVersion ?? 1,
      productId: product.id,
      knowledgeType: 'product_facts',
      title: `${product.title} 商品事实`,
      contentType: 'text/plain',
      contentHash,
      extractedText: text,
      sourceMetadata: { source: 'catalog.import.batch', ...(input.sourceMetadata ?? {}) },
      approvalStatus: 'pending',
      rightsStatus: 'unknown',
      indexState: 'queued',
    })
    documents.push(document)
    const createdChunks = await input.repository.replaceChunks(input.workspaceId, document.id, [{ id: `knowledge_chunk_product_${product.id}`, ordinal: 0, content: text, contentHash, metadata: { productId: product.id, source: 'spreadsheet' } }])
    chunks.push(...createdChunks)
    for (const sku of product.skus ?? []) {
      const skuText = `${product.title}\nSKU ${sku.id}：${sku.name}\n价格：${sku.price}\n库存：${sku.stock}${sku.attributes ? `\n属性：${JSON.stringify(sku.attributes)}` : ''}`
      const skuDocument = await input.repository.createDocument({ id: `knowledge_document_sku_${product.id}_${sku.id}`, workspaceId: input.workspaceId, knowledgeAssetId: asset.id, ...(input.sourceAssetId ? { sourceAssetId: input.sourceAssetId } : {}), sourceVersion: input.sourceVersion ?? 1, productId: product.id, skuId: sku.id, knowledgeType: 'product_facts', title: `${product.title} SKU ${sku.name}`, contentType: 'text/plain', contentHash: hash(skuText), extractedText: skuText, sourceMetadata: { source: 'catalog.import.batch', ...(input.sourceMetadata ?? {}) }, approvalStatus: 'pending', rightsStatus: 'unknown', indexState: 'queued' })
      documents.push(skuDocument)
      chunks.push(...await input.repository.replaceChunks(input.workspaceId, skuDocument.id, [{ id: `knowledge_chunk_sku_${product.id}_${sku.id}`, ordinal: 0, content: skuText, contentHash: hash(skuText), metadata: { productId: product.id, skuId: sku.id, source: 'spreadsheet' } }]))
    }
  }
  return { assets, documents, chunks, bindings }
}
