import type { AssetMetadata } from './api'

export type BrandAssetKind = 'logo' | 'document'

/** Object URLs are owned by one authenticated workspace and revoked on replacement/scope exit. */
export class BrandAssetPreviewRegistry {
  private readonly urls = new Map<string, string>()

  set(assetId: string, file: File): string {
    const url = URL.createObjectURL(file)
    this.delete(assetId)
    this.urls.set(assetId, url)
    return url
  }

  get(assetId: string | undefined): string | undefined {
    return assetId ? this.urls.get(assetId) : undefined
  }

  delete(assetId: string): void {
    const url = this.urls.get(assetId)
    if (url) URL.revokeObjectURL(url)
    this.urls.delete(assetId)
  }

  clear(): void {
    for (const url of this.urls.values()) URL.revokeObjectURL(url)
    this.urls.clear()
  }
}

const MAX_BRAND_ASSET_BYTES = 50 * 1024 * 1024
const DOCUMENT_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.json', '.doc', '.docx', '.pdf', '.zip'])
const UPLOAD_DOCUMENT_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.json', '.docx', '.pdf'])

export function brandAssetFileError(file: File, kind: BrandAssetKind): string {
  if (file.size <= 0) return '不能上传空文件。'
  if (file.size > MAX_BRAND_ASSET_BYTES) return '单个素材不能超过 50MB。'
  if (kind === 'logo' && !file.type.toLowerCase().startsWith('image/')) return 'Logo 请使用图片文件。'
  if (kind === 'document') {
    const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
    if (!UPLOAD_DOCUMENT_EXTENSIONS.has(extension)) return '品牌文档请使用 TXT、MD、CSV、JSON、DOCX 或 PDF 文件。'
  }
  return ''
}

export function brandAssetMatchesKind(asset: AssetMetadata, kind: BrandAssetKind): boolean {
  if (kind === 'logo') return asset.mimeType.toLowerCase().startsWith('image/')
  const extension = asset.name.slice(asset.name.lastIndexOf('.')).toLowerCase()
  return DOCUMENT_EXTENSIONS.has(extension)
}

/** The API accepts a reference only after scan, rights, parse and fact review. */
export function isUsableBrandAsset(asset: AssetMetadata | undefined): boolean {
  return Boolean(
    asset && asset.scanStatus === 'clean' && asset.rightsStatus === 'approved' &&
    asset.rightsScope !== 'unusable' && asset.parseStatus === 'succeeded' &&
    asset.factsConfirmedBy && asset.factsConfirmedAt && asset.readiness?.status === 'ready',
  )
}
