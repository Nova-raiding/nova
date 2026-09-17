import { createHash } from 'node:crypto'
import type { Platform } from './service.js'

const platforms = new Set<Platform>(['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'])
const secretKey = /(?:^|_)(?:access_?token|refresh_?token|authorization|cookie|password|credential(?:_?ref)?|client_?secret|sms_?code)(?:$|_)/iu

export class ManualStoreImportError extends Error {
  constructor(readonly code: string, message: string, readonly row?: number) {
    super(row === undefined ? message : `第 ${row} 行${message}`)
    this.name = 'ManualStoreImportError'
  }
}

export interface ManualStoreAccount {
  id: string
  workspaceId: string
  platform: Platform
  storeName: string
  /** Merchant-visible identifier, not an OAuth subject or credential. */
  merchantStoreKey: string
  integrationMode: 'manual_operated'
  status: 'active' | 'archived'
}

export interface ManualStoreAccountInput {
  workspaceId: string
  platform: Platform
  storeName: string
  merchantStoreKey: string
}

function visibleText(value: unknown, field: string, max: number): string {
  const text = String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ')
  if (!text || text.length > max || /[\u0000-\u001f\u007f\p{Cf}]/u.test(text)) {
    throw new ManualStoreImportError('MANUAL_STORE_FIELD_INVALID', `${field}必须是 1 到 ${max} 个可见字符`)
  }
  return text
}

/** Creates non-secret store scope metadata. It deliberately has no credential field. */
export function createManualStoreAccount(input: ManualStoreAccountInput): ManualStoreAccount {
  const workspaceId = visibleText(input.workspaceId, 'workspaceId', 128)
  if (!platforms.has(input.platform)) throw new ManualStoreImportError('MANUAL_STORE_PLATFORM_INVALID', '人工店铺平台无效')
  const storeName = visibleText(input.storeName, 'storeName', 120)
  const merchantStoreKey = visibleText(input.merchantStoreKey, 'merchantStoreKey', 160)
  if (/^(?:vault|secret|fixture):\/\//iu.test(merchantStoreKey) || /^Bearer\s/iu.test(merchantStoreKey)) {
    throw new ManualStoreImportError('MANUAL_STORE_KEY_SECRET_LIKE', 'merchantStoreKey 必须是商家可识别编号，不能使用凭据引用或 token')
  }
  const digest = createHash('sha256').update(`${workspaceId}\0${input.platform}\0${merchantStoreKey}`).digest('hex').slice(0, 24)
  return { id: `manual_store_${digest}`, workspaceId, platform: input.platform, storeName, merchantStoreKey, integrationMode: 'manual_operated', status: 'active' }
}

function findSensitivePath(value: unknown, path = ''): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const hit = findSensitivePath(value[index], `${path}[${index}]`)
      if (hit) return hit
    }
    return undefined
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const next = path ? `${path}.${key}` : key
    if (secretKey.test(key.normalize('NFKC').replace(/[\s-]+/gu, '_'))) return next
    const hit = findSensitivePath(nested, next)
    if (hit) return hit
  }
  return undefined
}

export interface PreparedManualImport {
  products: Array<Record<string, unknown> & { platform: Platform; account_id: string }>
  accountIds: string[]
}

/**
 * Owner integration point for REST/MCP batch imports after spreadsheet mapping.
 * It validates scope only and performs no writes, Vault lookup, or OAuth call.
 */
export function prepareManualStoreBatchImport(input: {
  workspaceId: string
  products: Record<string, unknown>[]
  accounts: readonly ManualStoreAccount[]
}): PreparedManualImport {
  const workspaceId = visibleText(input.workspaceId, 'workspaceId', 128)
  if (!Array.isArray(input.products) || input.products.length === 0 || input.products.length > 50) {
    throw new ManualStoreImportError('MANUAL_IMPORT_SIZE_INVALID', '人工导入必须包含 1 到 50 个商品')
  }
  const accounts = new Map<string, ManualStoreAccount>()
  for (const account of input.accounts) {
    const sensitivePath = findSensitivePath(account)
    if (sensitivePath) throw new ManualStoreImportError('MANUAL_STORE_CREDENTIAL_FORBIDDEN', `人工店铺记录不能包含凭据字段：${sensitivePath}`)
    if (account.workspaceId !== workspaceId || account.integrationMode !== 'manual_operated') continue
    if (accounts.has(account.id)) throw new ManualStoreImportError('MANUAL_STORE_DUPLICATE', `人工店铺标识重复：${account.id}`)
    accounts.set(account.id, account)
  }
  const selected = new Set<string>()
  const products = input.products.map((product, index) => {
    const row = index + 2
    const sensitivePath = findSensitivePath(product)
    if (sensitivePath) throw new ManualStoreImportError('MANUAL_IMPORT_SECRET_FORBIDDEN', `禁止包含平台密码、Cookie、token 或凭据字段：${sensitivePath}`, row)
    const platform = String(product.platform ?? '').trim().toLowerCase() as Platform
    if (!platforms.has(platform)) throw new ManualStoreImportError('MANUAL_IMPORT_PLATFORM_INVALID', 'platform 无效', row)
    const accountId = String(product.account_id ?? '').normalize('NFKC').trim()
    if (!accountId) throw new ManualStoreImportError('MANUAL_IMPORT_ACCOUNT_REQUIRED', 'account_id 不能为空；请先登记人工店铺', row)
    const account = accounts.get(accountId)
    if (!account || account.status !== 'active') throw new ManualStoreImportError('MANUAL_IMPORT_ACCOUNT_NOT_FOUND', '人工店铺不存在、已归档或不属于当前工作区', row)
    if (account.platform !== platform) throw new ManualStoreImportError('MANUAL_IMPORT_ACCOUNT_PLATFORM_MISMATCH', 'account_id 与 platform 不匹配', row)
    selected.add(accountId)
    return { ...product, platform, account_id: accountId }
  })
  return { products, accountIds: [...selected].sort() }
}
