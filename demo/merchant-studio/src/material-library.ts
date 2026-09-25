import { describeApiError, type AssetMetadata } from './api'

/**
 * The material library is one of the merchant surfaces bound to
 * `https://yxsona.com/`, so every number and file on it has to come from the
 * server. This module is the whole translation layer from a real
 * `GET /v1/assets` row to the card the reviewed material workspace renders.
 *
 * It replaces the previous local seed: `demoStoreMaterials()` fabricated eight
 * materials per store (size, dimensions, upload date and even the downloaded
 * file were invented) and `initialRecycleMaterials()` fabricated a deleted
 * material that no server ever held. Neither could be caught by the existing
 * gates because `catalog-data.test.ts` declared the material library
 * "deliberately out of scope".
 *
 * Two rules are load-bearing here:
 *
 * 1. A fact the server did not publish is reported as `未读取`, never filled in
 *    with a plausible-looking value. `GET /v1/assets` publishes the file name,
 *    MIME type, byte size and creation time — not pixel dimensions, not the
 *    merchant's material category, not a store attribution.
 * 2. There is no direct download URL. `GET /v1/assets/:id/download` is
 *    authenticated, so the card links to the endpoint and the click handler
 *    re-reads the bytes with the session (`fetchAssetBlob`). The previous
 *    `data:text/plain;charset=utf-8,...` href downloaded a four-line text file
 *    while the UI called it 「下载」.
 */

export type StoreMaterialCategory =
  | '品牌资料'
  | '商品主图'
  | '详情页图'
  | 'SKU 图'
  | '商品视频'
  | '未分类'
export type StoreMaterialSeries = string

export type StoreMaterialItem = {
  id: string
  name: string
  category: StoreMaterialCategory
  series: StoreMaterialSeries
  sizeLabel: string
  fileSizeLabel: string
  format: string
  addedAt: string
  previewUrl?: string
  downloadUrl: string
  bytes?: number
  /**
   * Set only for server assets. The download goes through
   * `GET /v1/assets/:id/download` with the merchant session; `downloadUrl` is
   * only ever an object URL for a file this browser itself selected.
   */
  assetId?: string
}

/** `UNREAD_METRIC` from `App.tsx`, kept here so the mapper needs no JSX. */
export const MATERIAL_UNREAD = '未读取'

export const materialStoreCategories: Array<'全部' | StoreMaterialCategory> = [
  '全部',
  '品牌资料',
  '商品主图',
  '详情页图',
  'SKU 图',
  '商品视频',
  '未分类',
]

const mimeFormatLabels: Record<string, string> = {
  'image/jpeg': 'JPG',
  'image/jpg': 'JPG',
  'image/png': 'PNG',
  'image/webp': 'WEBP',
  'image/gif': 'GIF',
  'image/avif': 'AVIF',
  'image/heic': 'HEIC',
  'image/svg+xml': 'SVG',
  'image/bmp': 'BMP',
  'video/mp4': 'MP4',
  'video/quicktime': 'MOV',
  'video/webm': 'WEBM',
  'application/pdf': 'PDF',
  'application/zip': 'ZIP',
  'application/msword': 'DOC',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'DOCX',
  'text/plain': 'TXT',
  'text/markdown': 'MD',
  'text/csv': 'CSV',
  'application/json': 'JSON',
}

/** The file format the server's MIME type names, or 未读取 when it named none. */
export function materialFormatFromMimeType(mimeType: string): string {
  const normalized = String(mimeType ?? '').trim().toLowerCase()
  if (!normalized) return MATERIAL_UNREAD
  const known = mimeFormatLabels[normalized]
  if (known) return known
  const subtype = normalized.split('/')[1]?.trim()
  return subtype ? subtype.toUpperCase() : MATERIAL_UNREAD
}

/**
 * The reviewed taxonomy (商品主图 / 详情页图 / SKU 图 / 商品视频 / 未分类) is the
 * merchant's own labelling, and the server stores no label for an asset. Only
 * the medium is a server fact, so a video asset is filed under 商品视频 and
 * everything else stays 未分类 until the merchant classifies it.
 */
export function materialCategoryFromMimeType(
  mimeType: string,
): StoreMaterialCategory {
  return String(mimeType ?? '').trim().toLowerCase().startsWith('video/')
    ? '商品视频'
    : '未分类'
}

/** The asset's own creation date, or '' when the server reported none. */
export function materialAddedAtFromAsset(
  asset: Pick<AssetMetadata, 'createdAt'>,
): string {
  const value = asset?.createdAt
  if (!value) return ''
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return ''
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`
}

export function formatMaterialFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return MATERIAL_UNREAD
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/**
 * One real `GET /v1/assets` row as a material card.
 *
 * `sizeLabel` is 未读取 because the server publishes no pixel dimensions, and
 * `series` starts at 未分类 because the workspace's series list is edited by the
 * merchant, not reported per asset.
 */
export function materialItemFromAsset(asset: AssetMetadata): StoreMaterialItem {
  const bytes = Number(asset?.sizeBytes)
  return {
    id: String(asset?.id ?? ''),
    assetId: String(asset?.id ?? ''),
    name: String(asset?.name ?? '').trim() || MATERIAL_UNREAD,
    category: materialCategoryFromMimeType(asset?.mimeType ?? ''),
    series: '未分类',
    sizeLabel: MATERIAL_UNREAD,
    fileSizeLabel: formatMaterialFileSize(bytes),
    format: materialFormatFromMimeType(asset?.mimeType ?? ''),
    addedAt: materialAddedAtFromAsset(asset),
    // Server bytes are read through the authenticated endpoint when the
    // merchant clicks 下载; there is no shareable URL to put in the href.
    downloadUrl: '',
    ...(Number.isFinite(bytes) ? { bytes } : {}),
  }
}

/**
 * What `GET /v1/assets` has actually said so far.
 *
 * The material library may never render a count for a read that has not
 * answered: the page it replaced showed 「找到 8 项素材」 with the API fully
 * disconnected, because its count came from a local array rather than a read.
 * `unread` (no API base URL) / `loading` / `error` are therefore distinct from
 * `ready` with zero items, and only `ready` may state a number.
 */
export type MaterialReadOutcome = {
  state: 'unread' | 'loading' | 'ready' | 'error'
  items: StoreMaterialItem[]
  error: string
}

export function resolveMaterialRead(input: {
  baseUrl?: string
  remote: AssetMetadata[] | null
  error: string
}): MaterialReadOutcome {
  if (!input.baseUrl) return { state: 'unread', items: [], error: '' }
  if (input.error) return { state: 'error', items: [], error: input.error }
  if (input.remote === null) return { state: 'loading', items: [], error: '' }
  return { state: 'ready', items: input.remote.map(materialItemFromAsset), error: '' }
}

/** The result-summary line for every state that may not state a count. */
export function materialSummaryText(outcome: MaterialReadOutcome): string {
  switch (outcome.state) {
    case 'loading': return '正在读取素材…'
    case 'error': return `素材读取失败：${outcome.error}`
    case 'unread': return `未配置 API，素材${MATERIAL_UNREAD}`
    default: return ''
  }
}

/** The empty-state copy. A failed or missing read is not an empty result. */
export function materialEmptyCopy(outcome: MaterialReadOutcome): { title: string; detail: string } {
  switch (outcome.state) {
    case 'loading':
      return { title: '正在读取素材', detail: '素材列表来自服务端，读取完成后才会显示数量与卡片。' }
    case 'error':
      return { title: '素材读取失败', detail: `${outcome.error}；本页不会用本地演示数据替代服务端素材。` }
    case 'unread':
      return { title: `未配置 API，素材${MATERIAL_UNREAD}`, detail: '配置 API 后，本页显示服务端真实素材；没有素材时会如实显示为空。' }
    default:
      return { title: '当前条件下没有素材', detail: '调整搜索或分类，也可以直接上传到当前店铺。' }
  }
}

/**
 * The href the card links to. It is the real authenticated endpoint (so the
 * link is honest about where the bytes live and still works if the browser is
 * allowed to navigate), but the click handler re-reads it with the session and
 * saves the response body under the asset's own name.
 */
export function materialDownloadHref(
  item: Pick<StoreMaterialItem, 'assetId' | 'downloadUrl'>,
  baseUrl: string | undefined,
): string {
  if (!item.assetId) return item.downloadUrl
  return `${(baseUrl ?? '').replace(/\/$/, '')}/v1/assets/${encodeURIComponent(item.assetId)}/download`
}

export type MaterialUploadOutcome = {
  /** One card per file the server accepted, built from the server's own row. */
  accepted: StoreMaterialItem[]
  /** One line per file the server refused, prefixed with the file's own name. */
  failures: string[]
}

/**
 * 确认上传: hand every selected file to `POST /v1/assets/upload` and build the
 * card from the row that came back.
 *
 * This is the whole difference between a real upload and the local-only version
 * it replaced. The old path called `URL.createObjectURL` and pushed a
 * hand-written item (`sizeLabel: '1920 × 1080'`, `addedAt: '刚刚上传'`) into
 * component state: the server never saw the bytes, so a refresh lost every
 * "uploaded" material, and 下载 served the object URL of a file that was never
 * anywhere but this tab. Taking the upload as a parameter keeps the flow
 * testable without a DOM, and makes it impossible to accept a material the
 * server did not acknowledge: nothing reaches `accepted` without a response.
 */
export async function uploadMaterialFiles(input: {
  files: File[]
  upload: (file: File) => Promise<AssetMetadata>
  labels: { category: StoreMaterialCategory; series: StoreMaterialSeries }
  previewUrlFor?: (file: File) => string | undefined
}): Promise<MaterialUploadOutcome> {
  const accepted: StoreMaterialItem[] = []
  const failures: string[] = []
  for (const file of input.files) {
    try {
      const uploaded = await input.upload(file)
      const preview = input.previewUrlFor?.(file)
      accepted.push({
        ...materialItemFromAsset(uploaded),
        // 素材分类 and 所属系列 are the merchant's own labelling and the asset
        // row carries neither, so they sit beside the acknowledged row.
        category: input.labels.category,
        series: input.labels.series,
        ...(preview ? { previewUrl: preview } : {}),
      })
    } catch (cause) {
      failures.push(`${file.name}：${describeApiError(cause)}`)
    }
  }
  return { accepted, failures }
}
