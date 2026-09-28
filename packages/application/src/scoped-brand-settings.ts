/** Merchant brand settings resolved against explicit server identities. */
export interface ScopedBrandValues {
  color?: string
  persona?: string
  sellingPoints?: string
  logoAssetId?: string
  documentAssetId?: string
}

export interface ScopedBrandEntry {
  enabled: boolean
  values: ScopedBrandValues
}

export interface ScopedBrandSettings {
  schemaVersion: 1
  global?: ScopedBrandEntry
  stores?: Record<string, ScopedBrandEntry>
  series?: Record<string, Record<string, ScopedBrandEntry>>
  images?: Record<string, ScopedBrandEntry>
}

export interface ScopedBrandContext {
  accountId?: string
  seriesKey?: string
  assetId?: string
}

export interface ScopedBrandBindings {
  accountIds: ReadonlySet<string>
  seriesKeysByAccount: ReadonlyMap<string, ReadonlySet<string>>
  assetIds: ReadonlySet<string>
  imageAssetIds: ReadonlySet<string>
  usableReferenceAssetIds: ReadonlySet<string>
}

export class ScopedBrandSettingsError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const fail = (code: string, message: string): never => { throw new ScopedBrandSettingsError(code, message) }
const ensureKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail('BRAND_SCOPE_FIELD_INVALID', `不支持的品牌配置字段：${key}`)
}
const ensureId = (value: string, label: string) => {
  if (!value.trim() || value !== value.trim() || value.length > 200 || /[\u0000-\u001f]/u.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) fail('BRAND_SCOPE_KEY_INVALID', `${label}无效`)
  return value
}
const ensureCount = (value: Record<string, unknown>, limit: number, label: string) => {
  if (Object.keys(value).length > limit) fail('BRAND_SCOPE_LIMIT', `${label}超过上限`)
}

function parseEntry(value: unknown, bindings: ScopedBrandBindings): ScopedBrandEntry {
  if (!object(value)) return fail('BRAND_SCOPE_ENTRY_INVALID', '品牌配置必须是对象')
  ensureKeys(value, ['enabled', 'values'])
  if (typeof value.enabled !== 'boolean' || !object(value.values)) return fail('BRAND_SCOPE_ENTRY_INVALID', '品牌配置缺少启用状态或字段')
  const fields = value.values
  ensureKeys(fields, ['color', 'persona', 'sellingPoints', 'logoAssetId', 'documentAssetId'])
  const values: ScopedBrandValues = {}
  for (const key of ['persona', 'sellingPoints'] as const) {
    if (fields[key] === undefined) continue
    if (typeof fields[key] !== 'string' || fields[key].length > 4000) return fail('BRAND_SCOPE_TEXT_INVALID', `${key}必须是不超过 4000 字的文本`)
    values[key] = fields[key]
  }
  if (fields.color !== undefined) {
    if (typeof fields.color !== 'string' || !/^#[0-9a-f]{6}$/iu.test(fields.color)) return fail('BRAND_SCOPE_COLOR_INVALID', '品牌色必须是 #RRGGBB')
    values.color = fields.color.toLowerCase()
  }
  for (const key of ['logoAssetId', 'documentAssetId'] as const) {
    if (fields[key] === undefined) continue
    if (typeof fields[key] !== 'string' || !bindings.assetIds.has(fields[key])) return fail('BRAND_SCOPE_ASSET_NOT_FOUND', '品牌素材不存在或不属于当前工作区')
    if (!bindings.usableReferenceAssetIds.has(fields[key])) return fail('BRAND_SCOPE_ASSET_NOT_READY', '品牌素材尚未通过扫描与使用权确认')
    values[key] = fields[key]
  }
  return { enabled: value.enabled, values }
}

/** Validate tenant ownership before writing this object to a durable brand profile. */
export function parseScopedBrandSettings(value: unknown, bindings: ScopedBrandBindings): ScopedBrandSettings {
  if (!object(value)) return fail('BRAND_SCOPES_INVALID', '品牌配置必须是对象')
  ensureKeys(value, ['schemaVersion', 'global', 'stores', 'series', 'images'])
  if (value.schemaVersion !== 1) return fail('BRAND_SCOPE_VERSION_INVALID', '不支持的品牌配置版本')
  const result: ScopedBrandSettings = { schemaVersion: 1 }
  if (value.global !== undefined) result.global = parseEntry(value.global, bindings)
  for (const type of ['stores', 'series', 'images'] as const) {
    if (value[type] === undefined) continue
    if (!object(value[type])) return fail('BRAND_SCOPES_INVALID', `${type}必须是对象`)
    ensureCount(value[type], 500, type)
  }
  if (object(value.stores)) {
    result.stores = Object.create(null) as Record<string, ScopedBrandEntry>
    for (const [accountId, entry] of Object.entries(value.stores)) {
      if (!bindings.accountIds.has(ensureId(accountId, '店铺 ID'))) return fail('BRAND_SCOPE_STORE_NOT_FOUND', '店铺不存在或不属于当前工作区')
      result.stores[accountId] = parseEntry(entry, bindings)
    }
  }
  if (object(value.series)) {
    result.series = Object.create(null) as Record<string, Record<string, ScopedBrandEntry>>
    for (const [accountId, entries] of Object.entries(value.series)) {
      if (!bindings.accountIds.has(ensureId(accountId, '店铺 ID'))) return fail('BRAND_SCOPE_STORE_NOT_FOUND', '店铺不存在或不属于当前工作区')
      if (!object(entries)) return fail('BRAND_SCOPE_SERIES_INVALID', '系列配置必须是对象')
      ensureCount(entries, 200, '系列')
      result.series[accountId] = Object.create(null) as Record<string, ScopedBrandEntry>
      for (const [seriesKey, entry] of Object.entries(entries)) {
        ensureId(seriesKey, '系列标识')
        if (!bindings.seriesKeysByAccount.get(accountId)?.has(seriesKey)) return fail('BRAND_SCOPE_SERIES_NOT_FOUND', '系列不存在或不属于当前店铺')
        result.series[accountId]![seriesKey] = parseEntry(entry, bindings)
      }
    }
  }
  if (object(value.images)) {
    result.images = Object.create(null) as Record<string, ScopedBrandEntry>
    for (const [assetId, entry] of Object.entries(value.images)) {
      if (!bindings.imageAssetIds.has(ensureId(assetId, '图片素材 ID'))) return fail('BRAND_SCOPE_IMAGE_NOT_FOUND', '图片不存在或不属于当前工作区')
      result.images[assetId] = parseEntry(entry, bindings)
    }
  }
  return result
}

/** No inferred scope: a missing server binding cannot activate a lower level. */
export function resolveScopedBrandValues(settings: ScopedBrandSettings, context: ScopedBrandContext): ScopedBrandValues {
  const entries = [
    settings.global,
    context.accountId ? settings.stores?.[context.accountId] : undefined,
    context.accountId && context.seriesKey ? settings.series?.[context.accountId]?.[context.seriesKey] : undefined,
    context.assetId ? settings.images?.[context.assetId] : undefined,
  ]
  return entries.reduce<ScopedBrandValues>((resolved, entry) => entry?.enabled ? { ...resolved, ...entry.values } : resolved, {})
}
