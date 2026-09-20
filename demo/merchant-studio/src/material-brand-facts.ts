/**
 * What the 品牌配置 panes may claim about the document and the colour they hold.
 *
 * Two fabrications lived here, both of the same shape: a local value presented
 * as a server fact.
 *
 * 1. `MaterialBrandFields.updateAssetFile` reads the picked file with
 *    `file.text()` and writes `assetFileName: file.name` — it makes no request
 *    at all (live probe: picking `brand-doc.txt` on the 品牌资产 page produced
 *    「品牌资产文档 · brand-doc.txt · 已接收」 at all four levels while the request
 *    log stayed empty, and reload brought back 「暂无资产文件 · 待接收」). Nothing
 *    touches a server, so the pane may only say 「仅本地，未上传」.
 *
 * 2. `emptyMaterialBrandSettings.color` was `'#17543c'` — the app's own theme
 *    green — so a workspace with no brand profile at all (`GET /v1/brand-profile`
 *    answers `{"profile": null}`, probed live) was shown 「品牌主色 #17543C」 next
 *    to 「品牌 Logo · 未单独配置」. A default is not a reading.
 *
 * Neither of the two endpoints that could make these claims true is reachable
 * from this pane, which is why it does not pretend:
 *
 *   - `POST /v1/assets/upload` does receive the bytes (probed live: 200 with an
 *     asset row), but `POST /v1/brand-profile/extract` then answers
 *     `BRAND_ASSETS_SCAN_REQUIRED` until the asset passes the trusted scan, and
 *     this pane has no scan/rights/facts confirmation surface. Uploading here
 *     would hand the merchant a document that still cannot become brand data.
 *   - `PUT /v1/brand-profile` is one workspace profile with a required `name`,
 *     while these panes edit eight scoped slots (全局/店铺/系列/单图) that the
 *     server has no counterpart for.
 */
export const BRAND_DOCUMENT_NONE = '暂无资产文件'
export const BRAND_DOCUMENT_PENDING = '待接收'
export const BRAND_DOCUMENT_LOCAL_ONLY = '仅本地，未上传'
/** The row label for a slot this level did not configure (Logo and 品牌主色). */
export const BRAND_UNCONFIGURED = '未单独配置'
/** The same sentence the fields block shows while the parse runs locally. */
export const BRAND_DOCUMENT_LOCAL_ANALYSIS =
  '已在本机解析，结果已填入下方字段；文档未上传服务端。'

export type BrandDocumentFacts = {
  /** The picked name, or '' when the merchant has picked nothing. */
  fileName: string
  /**
   * Whether a server holds this document. There is no such server call on this
   * path, so this is `false` for every state the pane can reach — it is not a
   * setting, it is what the code does.
   */
  uploaded: false
  /** The one word the output card may print. */
  label: string
  /** Whether the output card may style the row as still pending. */
  pending: boolean
}

export function resolveBrandDocumentFacts(fileName: string): BrandDocumentFacts {
  const name = fileName.trim()
  if (!name) return { fileName: '', uploaded: false, label: BRAND_DOCUMENT_PENDING, pending: true }
  return { fileName: name, uploaded: false, label: BRAND_DOCUMENT_LOCAL_ONLY, pending: false }
}

export type BrandColorFacts = {
  /** Whether a real colour is configured; `false` may not be drawn as one. */
  configured: boolean
  /** The colour to draw, '' when there is none. */
  value: string
  /** What the output card prints in place of a swatch. */
  label: string
}

export function resolveBrandColorFacts(color: string): BrandColorFacts {
  const value = color.trim()
  return /^#[0-9a-f]{6}$/iu.test(value)
    ? { configured: true, value, label: value }
    : { configured: false, value: '', label: BRAND_UNCONFIGURED }
}
