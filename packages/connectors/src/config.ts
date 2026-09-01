import type { GenericResponseMapping, HttpConnectorConfig, Platform, RawProduct, RequestSigner, WriteIdentity, WriteReceipt, WriteStatus } from './types.js'
import { validateConnectorReadiness, type ConnectorReadiness } from './readiness.js'
import { createAlibabaTopSigner, mapAlibabaTopProducts, mapAlibabaTopWriteReceipt, mapAlibabaTopWriteStatus } from './platform-adapters/alibaba-top.js'
import { createJdSigner, mapJdProducts, mapJdWriteReceipt, mapJdWriteStatus } from './platform-adapters/jd.js'
import { createPinduoduoSigner, mapPinduoduoProducts, mapPinduoduoWriteReceipt, mapPinduoduoWriteStatus } from './platform-adapters/pinduoduo.js'
import { providerRequestId } from './platform-adapters/rejection.js'

/**
 * The application may provide this port from a secret/config service.  The
 * adapter never reads process.env directly; this keeps config parsing
 * deterministic and makes secret injection auditable.
 */
export type ConfigSource = Readonly<Record<string, string | undefined>>

export interface StructuredPlatformConfig {
  clientId: string
  clientSecret?: string
  oauth: HttpConnectorConfig['oauth']
  api: HttpConnectorConfig['api']
  mediaUploadPath?: string
  mediaUploadEvidence?: HttpConnectorConfig['mediaUploadEvidence']
  timeoutMs?: number
  allowedHosts?: readonly string[]
  signer?: HttpConnectorConfig['signer']
  mapProducts?: HttpConnectorConfig['mapProducts']
  mapWriteReceipt?: HttpConnectorConfig['mapWriteReceipt']
  mapWriteStatus?: HttpConnectorConfig['mapWriteStatus']
  mappingEvidence?: HttpConnectorConfig['mappingEvidence']
  capabilityEvidence?: HttpConnectorConfig['capabilityEvidence']
  responseMapping?: GenericResponseMapping
}

export interface PlatformConfigBuildResult {
  configs: Partial<Record<Platform, HttpConnectorConfig>>
  /** All syntactically complete candidates, including those held back by
   * evidence/readiness gates; used for operator diagnostics only. */
  allConfigs: Partial<Record<Platform, HttpConnectorConfig>>
  /** Compatibility view for runtime consumers; contains only ready connectors. */
  candidates: Record<string, HttpConnectorConfig | undefined>
  missing: Record<Platform, string[]>
  readiness: Record<Platform, ConnectorReadiness>
}

const platformPrefixes: Record<Platform, string> = {
  jd: 'JD',
  taobao: 'TAOBAO',
  // Taobao and Tmall are intentionally separate configuration namespaces.
  tmall: 'TMALL',
  pinduoduo: 'PDD',
  xiaohongshu: 'XHS',
  douyin: 'DOUYIN',
}

const defaults: Record<Platform, HttpConnectorConfig['api']> = {
  jd: { baseUrl: '', syncPath: '/products', createPath: '/products/create', updatePath: '/products/update', queryPath: '/publish/status' },
  taobao: { baseUrl: '', syncPath: '/products', createPath: '/products/create', updatePath: '/products/update', queryPath: '/publish/status' },
  tmall: { baseUrl: '', syncPath: '/products', createPath: '/products/create', updatePath: '/products/update', queryPath: '/publish/status' },
  pinduoduo: { baseUrl: '', syncPath: '/products', createPath: '/products/create', updatePath: '/products/update', queryPath: '/publish/status' },
  xiaohongshu: { baseUrl: '', syncPath: '/products', createPath: '/products/create', updatePath: '/products/update', queryPath: '/publish/status' },
  douyin: { baseUrl: '', syncPath: '/products', createPath: '/products/create', updatePath: '/products/update', queryPath: '/publish/status' },
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function text(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined }

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

const UNSAFE_MAPPING_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])

function pathValue(value: unknown, path: string | undefined): unknown {
  const normalizedPath = path?.trim()
  if (!normalizedPath || normalizedPath.length > 512 || /[\u0000-\u001f\u007f\r\n]/u.test(normalizedPath)) return undefined
  return normalizedPath.split('.').reduce<unknown>((current, segment) => {
    const match = segment.match(/^([^[]+)(?:\[(\d+)\])?$/u)
    const currentRecord = record(current)
    if (!match || !currentRecord) return undefined
    const key = match[1]!
    if (UNSAFE_MAPPING_SEGMENTS.has(key) || key.length > 128 || !Object.prototype.hasOwnProperty.call(currentRecord, key)) return undefined
    const next = currentRecord[key]
    return match[2] === undefined ? next : Array.isArray(next) ? next[Number(match[2])] : undefined
  }, value)
}

/**
 * Social platforms use OAuth bearer transport by default. This adapter only
 * normalizes a deliberately small, reviewable envelope; it does not assert
 * that a platform's undocumented payload has this shape. Capability and
 * mapping evidence remain mandatory before a connector enters `configs`.
 */
function genericProducts(payload: unknown, platform: Platform, mapping?: GenericResponseMapping): RawProduct[] {
  const configuredItems = pathValue(payload, mapping?.itemsPath)
  const envelope = record(payload)
  const values: unknown[] = Array.isArray(configuredItems) ? configuredItems : Array.isArray(envelope?.items) ? envelope.items : Array.isArray(payload) ? payload : []
  return values.filter(item => Boolean(record(item))).map((value, index) => {
    const item = record(value)!
    const configuredSku = pathValue(item, mapping?.skuPath)
    const skuValues: unknown[] = Array.isArray(configuredSku) ? configuredSku : Array.isArray(item.sku) ? item.sku : Array.isArray(item.skus) ? item.skus : []
    const configuredImages = pathValue(item, mapping?.imagesPath)
    const images: unknown[] = Array.isArray(configuredImages) ? configuredImages : Array.isArray(item.images) ? item.images : []
    const configuredAttributes = record(pathValue(item, mapping?.attributesPath))
    const fallbackAttributes = record(item.attributes)
    return {
      remoteId: text(pathValue(item, mapping?.remoteIdPath)) ?? text(item.remoteId) ?? text(item.id) ?? `${platform}-remote-${index}`,
      title: text(pathValue(item, mapping?.titlePath)) ?? text(item.title) ?? '', description: text(pathValue(item, mapping?.descriptionPath)) ?? text(item.description) ?? '',
      price: finiteNumber(pathValue(item, mapping?.pricePath)) ?? finiteNumber(item.price) ?? 0,
      stock: finiteNumber(pathValue(item, mapping?.stockPath)) ?? finiteNumber(item.stock) ?? 0,
      sku: skuValues.filter(sku => Boolean(record(sku))).map((value, skuIndex) => {
        const sku = record(value)!
        return { id: text(pathValue(sku, mapping?.skuIdPath)) ?? text(sku.id) ?? `${index}-${skuIndex}`, name: text(pathValue(sku, mapping?.skuNamePath)) ?? text(sku.name) ?? '', price: finiteNumber(pathValue(sku, mapping?.skuPricePath)) ?? finiteNumber(sku.price) ?? 0, stock: finiteNumber(pathValue(sku, mapping?.skuStockPath)) ?? finiteNumber(sku.stock) ?? 0 }
      }),
      images: images.filter((image): image is string => typeof image === 'string'),
      category: text(pathValue(item, mapping?.categoryPath)) ?? text(item.category) ?? '', attributes: Object.fromEntries(Object.entries(configuredAttributes ?? fallbackAttributes ?? {}).filter(([, value]) => typeof value === 'string').map(([key, value]) => [key, value as string])),
      platformFields: item, observedAt: new Date().toISOString(),
    }
  })
}

function genericWriteReceipt(payload: unknown, input: { idempotencyKey: string; remoteId?: string }, operation: 'create' | 'update', platform: Platform, mapping?: GenericResponseMapping): WriteReceipt {
  const item = record(payload) ?? {}
  // A local idempotency key is not provider evidence.  Leave the receipt
  // uncorrelated when the provider omits its request identity; the HTTP
  // connector will reject it before recording or exposing a write receipt.
  const rawRequestId = text(pathValue(item, mapping?.requestIdPath)) ?? text(item.requestId) ?? text(item.request_id)
  const requestId = providerRequestId({ request_id: rawRequestId }) ?? ''
  return { platform, operation, remoteId: text(pathValue(item, mapping?.remoteIdPath)) ?? text(item.remoteId) ?? text(item.id) ?? input.remoteId ?? '', requestId, status: 'submitted', simulated: false, idempotencyKey: input.idempotencyKey }
}

function genericWriteStatus(payload: unknown, request: WriteIdentity, _platform: Platform, mapping?: GenericResponseMapping): WriteStatus {
  const item = record(payload) ?? {}
  const rawState = pathValue(item, mapping?.statePath) ?? item.state
  const state = ['submitted', 'published', 'rejected', 'unknown'].includes(String(rawState)) ? String(rawState) as WriteStatus['state'] : 'unknown'
  const found = pathValue(item, mapping?.foundPath)
  return { found: typeof found === 'boolean' ? found : item.found === true, state, ...(text(pathValue(item, mapping?.remoteIdPath)) ?? text(item.remoteId) ? { remoteId: text(pathValue(item, mapping?.remoteIdPath)) ?? text(item.remoteId) } : request.remoteId ? { remoteId: request.remoteId } : {}), ...(text(pathValue(item, mapping?.requestIdPath)) ?? text(item.requestId) ? { requestId: text(pathValue(item, mapping?.requestIdPath)) ?? text(item.requestId) } : {}), simulated: false }
}

function genericMediaUpload(payload: unknown, _input: import('./types.js').MediaUploadInput, _platform: Platform, mapping?: GenericResponseMapping) {
  const item = record(payload) ?? {}
  const mediaId = text(pathValue(item, mapping?.mediaIdPath)) ?? text(item.mediaId) ?? text(item.media_id) ?? text(item.id)
  const url = text(pathValue(item, mapping?.mediaUrlPath)) ?? text(item.url) ?? text(item.mediaUrl) ?? text(item.media_url)
  return { mediaId: mediaId ?? '', ...(url ? { url } : {}) }
}

function responseMappingFromEnv(source: ConfigSource, prefix: string): GenericResponseMapping | undefined {
  const fields: Array<keyof GenericResponseMapping> = ['itemsPath', 'remoteIdPath', 'titlePath', 'descriptionPath', 'pricePath', 'stockPath', 'skuPath', 'skuIdPath', 'skuNamePath', 'skuPricePath', 'skuStockPath', 'imagesPath', 'categoryPath', 'attributesPath', 'requestIdPath', 'statePath', 'foundPath', 'mediaIdPath', 'mediaUrlPath']
  const mapping = Object.fromEntries(fields.map(field => [field, value(source, `${prefix}_${field.replace(/[A-Z]/g, match => `_${match.toUpperCase()}`).toUpperCase()}`)]).filter(([, item]) => item)) as GenericResponseMapping
  return Object.keys(mapping).length ? mapping : undefined
}

function createBearerSigner(): RequestSigner {
  return { kind: 'platform', sign: () => ({}) }
}

function value(source: ConfigSource, key: string): string | undefined {
  const result = source[key]
  return typeof result === 'string' && result.trim() ? result.trim() : undefined
}

function numberValue(source: ConfigSource, key: string): number | undefined {
  const raw = value(source, key)
  if (!raw) return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function validUrl(raw: string | undefined): raw is string {
  if (!raw) return false
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch { return false }
}

function buildOne(platform: Platform, source: ConfigSource): { config?: HttpConnectorConfig; missing: string[] } {
  const prefix = platformPrefixes[platform]
  const clientId = value(source, `${prefix}_CLIENT_ID`) ?? value(source, `${prefix}_APP_KEY`)
  const clientSecret = value(source, `${prefix}_CLIENT_SECRET`) ?? value(source, `${prefix}_APP_SECRET`)
  const authorizeUrl = value(source, `${prefix}_OAUTH_AUTHORIZE_URL`)
  const tokenUrl = value(source, `${prefix}_OAUTH_TOKEN_URL`)
  const baseUrl = value(source, `${prefix}_API_BASE_URL`)
  const missing: string[] = []
  if (!clientId) missing.push(`${prefix}_CLIENT_ID (or ${prefix}_APP_KEY)`)
  if (!validUrl(authorizeUrl)) missing.push(`${prefix}_OAUTH_AUTHORIZE_URL`)
  if (!validUrl(tokenUrl)) missing.push(`${prefix}_OAUTH_TOKEN_URL`)
  if (!validUrl(baseUrl)) missing.push(`${prefix}_API_BASE_URL`)
  // Read the environment from the supplied source so config-center/fixture
  // callers get the same fail-closed path contract as process.env callers.
  if (value(source, 'NODE_ENV') === 'production') {
    for (const key of [`${prefix}_SYNC_PATH`, `${prefix}_CREATE_PATH`, `${prefix}_UPDATE_PATH`, `${prefix}_QUERY_PATH`]) {
      if (!value(source, key)) missing.push(key)
    }
  }
  if (missing.length) return { missing }
  const apiDefaults = defaults[platform]
  const api: HttpConnectorConfig['api'] = {
      baseUrl: baseUrl!,
    syncPath: value(source, `${prefix}_SYNC_PATH`) ?? apiDefaults.syncPath,
    createPath: value(source, `${prefix}_CREATE_PATH`) ?? apiDefaults.createPath,
    updatePath: value(source, `${prefix}_UPDATE_PATH`) ?? apiDefaults.updatePath,
    queryPath: value(source, `${prefix}_QUERY_PATH`) ?? apiDefaults.queryPath,
  }
  const mappingEvidence = (() => {
    const version = value(source, `${prefix}_MAPPING_EVIDENCE_VERSION`)
    const evidenceRef = value(source, `${prefix}_MAPPING_EVIDENCE_REF`)
    const verifiedBy = value(source, `${prefix}_MAPPING_EVIDENCE_VERIFIED_BY`)
    const verifiedAt = value(source, `${prefix}_MAPPING_EVIDENCE_VERIFIED_AT`)
    return version && evidenceRef && verifiedBy && verifiedAt ? { version, evidenceRef, verifiedBy, verifiedAt } : undefined
  })()
  const mediaUploadEvidence = (() => {
    const version = value(source, `${prefix}_MEDIA_UPLOAD_EVIDENCE_VERSION`)
    const evidenceRef = value(source, `${prefix}_MEDIA_UPLOAD_EVIDENCE_REF`)
    const verifiedBy = value(source, `${prefix}_MEDIA_UPLOAD_EVIDENCE_VERIFIED_BY`)
    const verifiedAt = value(source, `${prefix}_MEDIA_UPLOAD_EVIDENCE_VERIFIED_AT`)
    return version && evidenceRef && verifiedBy && verifiedAt ? { version, evidenceRef, verifiedBy, verifiedAt } : undefined
  })()
  return {
    config: {
      clientId: clientId!,
      ...(clientSecret ? { clientSecret } : {}),
      oauth: {
        authorizeUrl: authorizeUrl!,
        tokenUrl: tokenUrl!,
        ...(value(source, `${prefix}_OAUTH_REFRESH_URL`) ? { refreshUrl: value(source, `${prefix}_OAUTH_REFRESH_URL`) } : {}),
        ...(value(source, `${prefix}_OAUTH_REVOKE_URL`) ? { revokeUrl: value(source, `${prefix}_OAUTH_REVOKE_URL`) } : {}),
        ...(value(source, `${prefix}_OAUTH_SCOPES`) ? { scopes: value(source, `${prefix}_OAUTH_SCOPES`)!.split(',').map(scope => scope.trim()).filter(Boolean) } : {}),
        ...(value(source, `${prefix}_OAUTH_TOKEN_BODY_ENCODING`) === 'json' || value(source, `${prefix}_OAUTH_TOKEN_BODY_ENCODING`) === 'form' ? { tokenBodyEncoding: value(source, `${prefix}_OAUTH_TOKEN_BODY_ENCODING`) as 'json' | 'form' } : {}),
      },
      api,
      ...(value(source, `${prefix}_MEDIA_UPLOAD_PATH`) ? { mediaUploadPath: value(source, `${prefix}_MEDIA_UPLOAD_PATH`) } : {}),
      ...(mediaUploadEvidence ? { mediaUploadEvidence } : {}),
      ...(mappingEvidence ? { mappingEvidence } : {}),
      ...(clientSecret && platform === 'jd' ? { signer: createJdSigner({ appKey: clientId!, appSecret: clientSecret }) } : {}),
      ...(clientSecret && (platform === 'taobao' || platform === 'tmall') ? { signer: createAlibabaTopSigner({ appKey: clientId!, appSecret: clientSecret }) } : {}),
      ...(clientSecret && platform === 'pinduoduo' ? { signer: createPinduoduoSigner({ clientId: clientId!, clientSecret }) } : {}),
      ...(platform === 'xiaohongshu' || platform === 'douyin' ? (() => { const responseMapping = responseMappingFromEnv(source, prefix); return { signer: createBearerSigner(), ...(responseMapping ? { responseMapping } : {}), mapProducts: (payload: unknown, current: Platform) => genericProducts(payload, current, responseMapping), mapWriteReceipt: (payload: unknown, input: import('./types.js').PlatformWriteDraft, operation: 'create' | 'update', current: Platform) => genericWriteReceipt(payload, input, operation, current, responseMapping), mapWriteStatus: (payload: unknown, request: WriteIdentity, current: Platform) => genericWriteStatus(payload, request, current, responseMapping), ...(value(source, `${prefix}_MEDIA_UPLOAD_PATH`) ? { mapMediaUpload: (payload: unknown, input: import('./types.js').MediaUploadInput, current: Platform) => genericMediaUpload(payload, input, current, responseMapping) } : {}) } })() : {}),
      ...(platform === 'jd' ? {
        mapProducts: mapJdProducts,
        mapWriteReceipt: mapJdWriteReceipt,
        mapWriteStatus: mapJdWriteStatus,
      } : {}),
      ...((platform === 'taobao' || platform === 'tmall') ? {
        mapProducts: (payload: unknown, current: Platform) => mapAlibabaTopProducts(payload, current as 'taobao' | 'tmall'),
        mapWriteReceipt: (payload: unknown, input: Parameters<NonNullable<HttpConnectorConfig['mapWriteReceipt']>>[1], operation: 'create' | 'update', current: Platform) => mapAlibabaTopWriteReceipt(payload, input, operation, current as 'taobao' | 'tmall'),
        mapWriteStatus: (payload: unknown, request: Parameters<NonNullable<HttpConnectorConfig['mapWriteStatus']>>[1], current: Platform) => mapAlibabaTopWriteStatus(payload, request, current as 'taobao' | 'tmall'),
      } : {}),
      ...(platform === 'pinduoduo' ? {
        mapProducts: mapPinduoduoProducts,
        mapWriteReceipt: mapPinduoduoWriteReceipt,
        mapWriteStatus: mapPinduoduoWriteStatus,
      } : {}),
      ...(numberValue(source, `${prefix}_HTTP_TIMEOUT_MS`) ? { timeoutMs: numberValue(source, `${prefix}_HTTP_TIMEOUT_MS`) } : {}),
      ...(value(source, `${prefix}_ALLOWED_HOSTS`) ? { allowedHosts: value(source, `${prefix}_ALLOWED_HOSTS`)!.split(',').map(host => host.trim().toLowerCase()).filter(Boolean) } : {}),
    },
    missing,
  }
}

export function buildHttpConnectorConfigs(source: ConfigSource = process.env): PlatformConfigBuildResult {
  const configs: Partial<Record<Platform, HttpConnectorConfig>> = {}
  const allConfigs: Partial<Record<Platform, HttpConnectorConfig>> = {}
  const candidates: Record<string, HttpConnectorConfig | undefined> = {}
  const missing = {} as Record<Platform, string[]>
  const readiness = {} as Record<Platform, ConnectorReadiness>
  for (const platform of Object.keys(platformPrefixes) as Platform[]) {
    const result = buildOne(platform, source)
    const state = validateConnectorReadiness(platform, result.config)
    readiness[platform] = state
    if (result.config) allConfigs[platform] = result.config
    if (result.config && state.ready) configs[platform] = result.config
    if (result.config && state.ready) candidates[platform] = result.config
    missing[platform] = [...result.missing, ...state.reasons]
  }
  return { configs, allConfigs, candidates, missing, readiness }
}

/** Builds the same six-platform map when configuration comes from a typed
 * secret/config service instead of process.env. No credentials are included
 * in this structure; those stay behind CredentialProvider. */
export function buildHttpConnectorConfigsFromStructured(source: Partial<Record<Platform, StructuredPlatformConfig>>): PlatformConfigBuildResult {
  const configs: Partial<Record<Platform, HttpConnectorConfig>> = {}
  const allConfigs: Partial<Record<Platform, HttpConnectorConfig>> = {}
  const candidates: Record<string, HttpConnectorConfig | undefined> = {}
  const missing = {} as Record<Platform, string[]>
  const readiness = {} as Record<Platform, ConnectorReadiness>
  for (const platform of Object.keys(platformPrefixes) as Platform[]) {
    const value = source[platform]
    const missingFields: string[] = []
    if (!value?.clientId?.trim()) missingFields.push('clientId')
    if (!value?.oauth?.authorizeUrl || !validUrl(value.oauth.authorizeUrl)) missingFields.push('oauth.authorizeUrl')
    if (!value?.oauth?.tokenUrl || !validUrl(value.oauth.tokenUrl)) missingFields.push('oauth.tokenUrl')
    if (!value?.api?.baseUrl || !validUrl(value.api.baseUrl)) missingFields.push('api.baseUrl')
    const candidate = value && missingFields.length === 0 ? stripStructuredSecret(withPlatformAdapters(platform, {
      ...value,
      oauth: { ...value.oauth },
      api: { ...value.api },
    })) : undefined
    const state = validateConnectorReadiness(platform, candidate)
    readiness[platform] = state
    if (candidate) allConfigs[platform] = candidate
    if (candidate && state.ready) configs[platform] = candidate
    if (candidate && state.ready) candidates[platform] = candidate
    missing[platform] = [...missingFields, ...state.reasons]
  }
  return { configs, allConfigs, candidates, missing, readiness }
}

/**
 * Structured configuration may be assembled from a secret/config service and
 * temporarily carry a client secret so a platform signer can be constructed.
 * The secret must never become part of the connector config consumed by the
 * API/MCP runtime, though: credentials belong behind CredentialProvider.
 * Keep the signer closure (which needs the secret to sign) but remove the
 * enumerable config field before exposing the candidate or readiness result.
 */
function stripStructuredSecret(config: HttpConnectorConfig): HttpConnectorConfig {
  const { clientSecret: _clientSecret, ...withoutSecret } = config
  return withoutSecret
}

export function platformConfigPrefix(platform: Platform): string { return platformPrefixes[platform] }

/** Keep structured Secret Manager/config-service loading behavior identical to
 * environment loading. Explicit reviewed adapters always win; built-ins only
 * fill the platform boundary when the platform secret is present. */
function withPlatformAdapters(platform: Platform, config: HttpConnectorConfig): HttpConnectorConfig {
  if (platform === 'jd') return {
    ...config,
    ...(config.clientSecret && !config.signer ? { signer: createJdSigner({ appKey: config.clientId, appSecret: config.clientSecret }) } : {}),
    ...(config.mapProducts ? {} : { mapProducts: mapJdProducts }),
    ...(config.mapWriteReceipt ? {} : { mapWriteReceipt: mapJdWriteReceipt }),
    ...(config.mapWriteStatus ? {} : { mapWriteStatus: mapJdWriteStatus }),
  }
  if (platform === 'pinduoduo') return {
    ...config,
    ...(config.clientSecret && !config.signer ? { signer: createPinduoduoSigner({ clientId: config.clientId, clientSecret: config.clientSecret }) } : {}),
    ...(config.mapProducts ? {} : { mapProducts: mapPinduoduoProducts }),
    ...(config.mapWriteReceipt ? {} : { mapWriteReceipt: mapPinduoduoWriteReceipt }),
    ...(config.mapWriteStatus ? {} : { mapWriteStatus: mapPinduoduoWriteStatus }),
  }
  if ((platform === 'taobao' || platform === 'tmall') && config.clientSecret) return {
    ...config,
    ...(config.signer ? {} : { signer: createAlibabaTopSigner({ appKey: config.clientId, appSecret: config.clientSecret }) }),
    ...(config.mapProducts ? {} : { mapProducts: (payload: unknown, current: Platform) => mapAlibabaTopProducts(payload, current as 'taobao' | 'tmall') }),
    ...(config.mapWriteReceipt ? {} : { mapWriteReceipt: (payload: unknown, input: Parameters<NonNullable<HttpConnectorConfig['mapWriteReceipt']>>[1], operation: 'create' | 'update', current: Platform) => mapAlibabaTopWriteReceipt(payload, input, operation, current as 'taobao' | 'tmall') }),
    ...(config.mapWriteStatus ? {} : { mapWriteStatus: (payload: unknown, request: Parameters<NonNullable<HttpConnectorConfig['mapWriteStatus']>>[1], current: Platform) => mapAlibabaTopWriteStatus(payload, request, current as 'taobao' | 'tmall') }),
  }
  if (platform === 'xiaohongshu' || platform === 'douyin') return {
    ...config,
    ...(config.signer ? {} : { signer: createBearerSigner() }),
    ...(config.mapProducts ? {} : { mapProducts: (payload: unknown, current: Platform) => genericProducts(payload, current, config.responseMapping) }),
    ...(config.mapWriteReceipt ? {} : { mapWriteReceipt: (payload: unknown, input: import('./types.js').PlatformWriteDraft, operation: 'create' | 'update', current: Platform) => genericWriteReceipt(payload, input, operation, current, config.responseMapping) }),
    ...(config.mapWriteStatus ? {} : { mapWriteStatus: (payload: unknown, request: WriteIdentity, current: Platform) => genericWriteStatus(payload, request, current, config.responseMapping) }),
    ...(config.mediaUploadPath && !config.mapMediaUpload ? { mapMediaUpload: (payload: unknown, input: import('./types.js').MediaUploadInput, current: Platform) => genericMediaUpload(payload, input, current, config.responseMapping) } : {}),
  }
  return config
}
