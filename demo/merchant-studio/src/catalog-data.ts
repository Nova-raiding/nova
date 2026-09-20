import type { PlatformAccount, Product } from './api'
import { isRealReadableStore, merchantConnectionPresentation } from './platform-connection-status'

/**
 * The platform & store & product page reads everything it shows from the
 * server: `/v1/platform-accounts` (which enumerates every supported platform and
 * the accounts the workspace really has) and `/v1/products`. Nothing in here
 * invents a store, a product, a count or a sync time — a workspace with no
 * accounts renders an empty state, not a demo catalogue.
 *
 * The reviewed page (`2e055921` and the visual-review commits) fixed the layout
 * and the copy; only the data source changes here.
 */

/**
 * Display order of the platform rail. The *set* of platforms comes from the
 * server response — this constant only fixes the reviewed order, and any
 * platform the server reports but this list does not know is appended rather
 * than hidden.
 */
export const catalogPlatformOrder: string[] = ['taobao', 'tmall', 'jd', 'douyin', 'pinduoduo', 'xiaohongshu']

/** Reviewed merchant-facing platform names (抖音小店 / 小红书店, not 抖音 / 小红书). */
const catalogPlatformLabels: Record<string, string> = {
  taobao: '淘宝', tmall: '天猫', jd: '京东', douyin: '抖音小店', pinduoduo: '拼多多', xiaohongshu: '小红书店',
}
const catalogPlatformMarks: Record<string, string> = {
  taobao: '淘', tmall: '天', jd: '京', douyin: '抖', pinduoduo: '拼', xiaohongshu: '红',
}
const catalogPlatformTones: Record<string, string> = {
  taobao: 'mint', tmall: 'lime', jd: 'blue', douyin: 'rose', pinduoduo: 'amber', xiaohongshu: 'violet',
}
const catalogProductTones = ['sage', 'sand', 'mist', 'clay', 'peach', 'night', 'sky', 'graphite', 'cream']

export const catalogPlatformLabel = (platform: string): string => catalogPlatformLabels[platform] ?? platform
export const catalogPlatformMark = (platform: string): string => catalogPlatformMarks[platform] ?? platform.slice(0, 1)
export const catalogPlatformTone = (platform: string): string => catalogPlatformTones[platform] ?? 'mint'
export const catalogProductTone = (index: number): string => catalogProductTones[index % catalogProductTones.length]!

/** The server's own `dataMode`, in merchant-facing words. Never a promotion. */
export function catalogDataModeLabel(dataMode: string | undefined): string {
  const mode = String(dataMode ?? '').trim().toLowerCase()
  if (mode === 'fixture') return '演示数据'
  if (mode === 'official_api') return '官方 API 数据'
  if (mode === 'manual_upload') return '人工上传数据'
  if (mode === 'account_record_only') return '仅有账号记录'
  return '数据来源未标注'
}

/** The last successful sync the server reported, or '' when it has none. */
export function catalogSyncLabel(account: Pick<PlatformAccount, 'sync'>): string {
  const at = account.sync?.lastSuccessfulAt ?? account.sync?.lastAttemptAt ?? account.sync?.lastUsableAt ?? ''
  if (!at) return ''
  const parsed = new Date(at)
  if (Number.isNaN(parsed.getTime())) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
}

/** The store name the server reports for an account. Never the account id. */
export function catalogStoreName(account: PlatformAccount): string {
  const candidate = account.label ?? account.alias ?? account.storeName
  const trimmed = String(candidate ?? '').trim()
  return trimmed || String(account.accountId ?? '').trim()
}

export type CatalogStoreView = {
  /** The server's stable `accountId`; the only store identity on this page. */
  id: string
  mark: string
  name: string
  platformId: string
  platform: string
  dataModeLabel: string
  /** `merchantConnectionPresentation` — the same words the overview uses. */
  connectionLabel: string
  connectionTone: 'green' | 'amber'
  /** The server exposes this store for reading (fixture accounts included). */
  readable: boolean
  /** A real, non-fixture readable store — what 「已连接」 may be claimed about. */
  realConnected: boolean
  /** `null` while the product read is unresolved: never rendered as 0. */
  products: number | null
  /** '' when the server reported no sync at all. */
  syncLabel: string
  tone: string
}

export type CatalogPlatformView = {
  id: string
  label: string
  mark: string
  stores: CatalogStoreView[]
  /** Stores that may honestly be called 已连接 (real, readable, non-fixture). */
  connectedCount: number
  /** 已接入 / the connection word the server's state implies / 未接入. */
  statusLabel: string
  connected: boolean
}

const accountStores = (accounts: PlatformAccount[] | null, products: Product[] | null): CatalogStoreView[] | null => {
  if (accounts === null) return null
  return accounts
    .filter((account) => String(account.accountId ?? '').trim())
    .map((account) => {
      const presentation = merchantConnectionPresentation(account)
      const readable = account.state === 'connected' && account.readEnabled === true
      const storeProducts = products === null ? null : products.filter((product) => product.accountId === account.accountId)
      return {
        id: String(account.accountId).trim(),
        mark: catalogPlatformMark(account.platform),
        name: catalogStoreName(account),
        platformId: account.platform,
        platform: catalogPlatformLabel(account.platform),
        dataModeLabel: catalogDataModeLabel(account.dataMode),
        connectionLabel: presentation.status,
        connectionTone: presentation.tone,
        readable,
        realConnected: isRealReadableStore({ readable, state: account.state, dataMode: account.dataMode }),
        products: storeProducts === null ? null : storeProducts.length,
        syncLabel: catalogSyncLabel(account),
        tone: catalogPlatformTone(account.platform),
      }
    })
}

/**
 * Every store the workspace really has, keyed by the server's platform list.
 * `null` means the account read has not completed — the caller must say so
 * instead of rendering an empty catalogue as if it were the workspace.
 */
export function buildCatalogPlatforms(accounts: PlatformAccount[] | null, products: Product[] | null): CatalogPlatformView[] | null {
  const stores = accountStores(accounts, products)
  if (stores === null) return null
  const reported = accounts!.map((account) => String(account.platform))
  const ordered = [
    ...catalogPlatformOrder.filter((platform) => reported.includes(platform)),
    ...reported.filter((platform) => !catalogPlatformOrder.includes(platform)),
  ].filter((platform, index, list) => list.indexOf(platform) === index)
  return ordered.map((platform) => {
    const platformStores = stores.filter((store) => store.platformId === platform)
    const connectedCount = platformStores.filter((store) => store.realConnected).length
    return {
      id: platform,
      label: catalogPlatformLabel(platform),
      mark: catalogPlatformMark(platform),
      stores: platformStores,
      connectedCount,
      statusLabel: connectedCount > 0 ? '已接入' : platformStores.length ? platformStores[0]!.connectionLabel : '未接入',
      connected: connectedCount > 0,
    }
  })
}

export type CatalogProductSku = {
  id: string
  name: string
  /** `null` when the server did not publish a price for this SKU. */
  price: number | null
  stock: number | null
}

export type CatalogProduct = {
  id: string
  title: string
  /** Server facts only: category, stock and SKU count. */
  subtitle: string
  /** `null` when the server did not publish a price — never a placeholder number. */
  price: number | null
  /** '' when the server reported no creation time. */
  addedAt: string
  /** The specifications the server published; empty when it published none. */
  skus: CatalogProductSku[]
  tone: string
  series: string
}

export const unclassifiedSeries = '未分类'

/** What the product card may say about a product: the server's own facts. */
export function catalogProductSubtitle(product: Product): string {
  const facts: string[] = []
  if (String(product.category ?? '').trim()) facts.push(String(product.category).trim())
  if (Number.isFinite(Number(product.stock))) facts.push(`库存 ${Number(product.stock)} 件`)
  if (Number.isFinite(Number(product.skuCount))) facts.push(`${Number(product.skuCount)} 个规格`)
  return facts.join(' · ')
}

/** The product's own creation date, or '' when the server did not report one. */
export function catalogProductAddedAt(product: Pick<Product, 'createdAt' | 'updatedAt'>): string {
  const value = product.createdAt ?? product.updatedAt
  if (!value) return ''
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return ''
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`
}

/**
 * The workspace's real products for one store. `null` while the product read is
 * unresolved; `[]` when the server answered and this store has no products.
 */
export function catalogProductsForStore(
  products: Product[] | null,
  accountId: string,
  reassignments: Record<string, string> = {},
): CatalogProduct[] | null {
  if (products === null) return null
  // The server does not publish a series for a product, so every real product
  // starts in 未分类 and only the local series tool moves it.
  const series = reassignments[unclassifiedSeries] ?? unclassifiedSeries
  return products
    .filter((product) => product.accountId === accountId)
    .map((product, index) => ({
      id: product.id,
      title: product.title,
      subtitle: catalogProductSubtitle(product),
      price: product.price === undefined || !Number.isFinite(Number(product.price)) ? null : Number(product.price),
      addedAt: catalogProductAddedAt(product),
      skus: (product.skus ?? []).map((sku) => ({
        id: sku.id,
        name: sku.name,
        price: sku.price === undefined || !Number.isFinite(Number(sku.price)) ? null : Number(sku.price),
        stock: sku.stock === undefined || !Number.isFinite(Number(sku.stock)) ? null : Number(sku.stock),
      })),
      tone: catalogProductTone(index),
      series,
    }))
}
