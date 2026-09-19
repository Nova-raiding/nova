import { createHash } from 'node:crypto'
import { ConnectorFailure } from './fake-connector.js'
import { jdProfile } from './profiles/jd.js'
import { taobaoProfile } from './profiles/taobao.js'
import { tmallProfile } from './profiles/tmall.js'
import { pinduoduoProfile } from './profiles/pinduoduo.js'
import { xiaohongshuProfile } from './profiles/xiaohongshu.js'
import { douyinProfile } from './profiles/douyin.js'
import { validateConnectorAuthorizationReadiness, validateConnectorReadiness, type ConnectorReadiness } from './readiness.js'
import { assertOutboundUrl, inspectOutboundUrl, isSecureEnvironment, officialHostsFor } from './outbound-security.js'
import { deduplicateSyncProducts, SyncContractError, validateNextSyncCursor, validateSyncCursor, validateSyncWindow } from './sync-safety.js'
import { mapPlatformRejection, platformEnvelope, providerRequestId } from './platform-adapters/rejection.js'
import {
  credentialRefreshKey, DEFAULT_REFRESH_LEASE_TTL_MS, InProcessCredentialRefreshLock,
  type CredentialRefreshLease, type CredentialRefreshSingleFlight,
} from './refresh-lock.js'
import type {
  AccessCredential, AuthorizeInput, AuthorizeResult, ConnectorContext, CredentialProvider, CredentialRef, Cursor, ExchangeCodeInput,
  HttpConnectorConfig, HttpRequestBodyEncoding, HttpRequestDescriptor, MappingVersion, MediaDiscardResult, NormalizedPlatformError, OrphanedMediaRecord, Platform, PlatformConnector,
  PlatformProfile, PlatformWriteDraft, ProductPage, RawProduct, RequestSigner, VaultCredentialProvider, WriteIdentity, WriteReceipt, WriteStatus, MediaUploadInput, MediaUploadReceipt,
} from './types.js'

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

/** Trusted host admission, executed after credential/signing/DNS work and
 * before each actual request. Correlation IDs are not proof of authorization. */
export type ConnectorBeforeRequest = (context: Readonly<{
  operation: 'exchange_code' | 'refresh_credential' | 'revoke' | 'sync_products' | 'create_product' | 'update_product' | 'query_write' | 'upload_media'
  platform: Platform
  workspaceId?: string
  accountId?: string
  signal?: AbortSignal
}>) => void | Promise<void>

/** Secret-free metadata observed after a real provider HTTP response. */
export interface ProviderExchangeObservation {
  platform: Platform
  operation: Parameters<ConnectorBeforeRequest>[0]['operation']
  workspaceId?: string
  accountId?: string
  method: string
  origin: string
  status: number
  observedAt: string
  providerRequestId?: string
  errorCode?: NormalizedPlatformError['code']
  errorMessage?: string
  retryable?: boolean
  /**
   * Parsed `Retry-After` hint in milliseconds, when the provider sent one.
   * Carried as exchange evidence only; no retry scheduler reads it yet — see
   * `NormalizedPlatformError.retryAfterMs`.
   */
  retryAfterMs?: number
  /** Fetch does not expose negotiated HTTP/TLS protocol versions. */
  transport: 'fetch'
}

export interface HttpPlatformConnectorOptions {
  config?: HttpConnectorConfig
  credentials?: CredentialProvider
  fetch?: FetchLike
  beforeRequest?: ConnectorBeforeRequest
  onExchange?: (observation: Readonly<ProviderExchangeObservation>) => void
  /**
   * Cross-process refresh single-flight. Defaults to an in-process lease,
   * which is only sufficient for a single replica; multi-replica hosts must
   * inject a shared implementation (`RedisCredentialRefreshLock`).
   */
  refreshLock?: CredentialRefreshSingleFlight
  /** Lease lifetime for one refresh round trip. */
  refreshLeaseTtlMs?: number
  /** How long a request waits for a concurrent refresher before refreshing itself. */
  refreshWaitMs?: number
  /** Poll interval while waiting for a concurrent refresher. */
  refreshPollMs?: number
  /**
   * Explicit remote compensation for media that was uploaded but whose write
   * was rejected afterwards. Resolve `true` only when the platform confirmed
   * the deletion.
   */
  deleteMedia?: (ctx: ConnectorContext, receipt: MediaUploadReceipt) => Promise<boolean> | boolean
  /**
   * Durable reconciliation sink for media that could not be deleted remotely
   * (or when no delete adapter exists). The orphan marker is the only
   * compensation a platform without a delete path can offer.
   */
  onOrphanedMedia?: (record: Readonly<OrphanedMediaRecord>) => void
  /** Explicit test-only escape hatch for an in-memory provider. */
  allowTestCredentials?: boolean
  /** Explicit test-only escape hatch for test signer/mapping adapters. */
  allowTestAdapters?: boolean
}

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_PLATFORM_RESPONSE_BYTES = 4 * 1024 * 1024
const CREDENTIAL_EXPIRY_SKEW_MS = 30_000
/** Mirrors the worker publish-media transport bound (`fetchPublishMedia`). */
const MAX_MEDIA_UPLOAD_BYTES = 15 * 1024 * 1024
const MEDIA_MIME_TYPE = /^image\/[a-z0-9.+-]+$/iu
const DEFAULT_REFRESH_WAIT_MS = 5_000
const DEFAULT_REFRESH_POLL_MS = 100
/** Providers report a rotated/replayed refresh token through these codes. */
const REFRESH_RACE_CODES = /^(invalid_grant|invalid_token|invalid_refresh_token|refresh_token_expired|refresh_token_reused|expired_token|token_expired)$/iu
const ERROR_CODES = new Set(['NOT_CONFIGURED', 'UNAUTHORIZED', 'RATE_LIMITED', 'TIMEOUT', 'CONFLICT', 'VALIDATION_FAILED', 'NOT_FOUND', 'HTTPS_REQUIRED', 'HOST_NOT_ALLOWLISTED', 'PRIVATE_ADDRESS_BLOCKED', 'INVALID_OUTBOUND_URL', 'REMOTE_ERROR'])

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null }
function readString(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 ? value : undefined }
/** OAuth credentials are copied into HTTP headers or form bodies. Reject
 * blank and control-character values at the boundary instead of allowing an
 * unusable/unsafe token to look like a valid credential. */
function readCredentialToken(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) return undefined
  return value
}
/** Provider correlation IDs are evidence, not arbitrary display text. Keep
 * them bounded and printable before they cross audit/log boundaries. */
function readRequestId(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return undefined
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) return undefined
  return value
}
function readFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}
function readImageUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (typeof item === 'string' && item.trim()) return [item.trim()]
    if (!isRecord(item)) return []
    const url = readString(item.url) ?? readString(item.image_url) ?? readString(item.imageUrl)
    return url ? [url] : []
  })
}
/** Parses `Retry-After` in both documented forms (delta-seconds and
 * HTTP-date). A missing, negative, malformed or absurd value yields undefined:
 * the connector must never invent a delay the provider did not send. The
 * result is attached to `NormalizedPlatformError`/`ProviderExchangeObservation`
 * as evidence; the durable retry scheduler does not consume it yet. */
export function parseRetryAfterMs(value: string | null | undefined, nowMs = Date.now()): number | undefined {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw || raw.startsWith('-')) return undefined
  if (/^\d+(?:\.\d+)?$/u.test(raw)) {
    const seconds = Number(raw)
    if (!Number.isFinite(seconds)) return undefined
    return boundedRetryAfterMs(seconds * 1000)
  }
  const date = Date.parse(raw)
  if (!Number.isFinite(date)) return undefined
  // An HTTP-date already in the past means "retry now", not "no hint".
  return boundedRetryAfterMs(Math.max(0, date - nowMs))
}

function boundedRetryAfterMs(value: number): number | undefined {
  if (!Number.isFinite(value) || value < 0) return undefined
  // A provider cannot ask for more than a day; anything larger is noise or an
  // attempt to stall the outbox indefinitely.
  return Math.min(Math.round(value), 24 * 60 * 60 * 1000)
}

/** Media bytes leave this process base64-encoded, so the boundary has to
 * reject oversized or non-image content before it is uploaded — an orphaned
 * upload is not recoverable by retrying. */
export function validateMediaUploadInput(input: MediaUploadInput): string | undefined {
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) return 'media upload requires image bytes'
  if (input.bytes.byteLength > MAX_MEDIA_UPLOAD_BYTES) return `media upload exceeds the ${MAX_MEDIA_UPLOAD_BYTES} byte limit`
  if (typeof input.mimeType !== 'string' || !MEDIA_MIME_TYPE.test(input.mimeType)) return 'media upload requires an image MIME type'
  if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim()) return 'media upload requires an idempotency key'
  return undefined
}

/** Identifies the exact upload a retry claims to repeat. The bytes themselves
 * are hashed, not just their declared digest: a caller that reuses one
 * idempotency key for different media must be rejected, not served the first
 * upload's receipt. */
function mediaFingerprint(input: MediaUploadInput): string {
  return createHash('sha256')
    .update(input.bytes)
    .update(`\n${input.visualRef}\n${input.role}\n${input.mimeType.toLowerCase()}\n${input.sha256}`)
    .digest('hex')
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return }
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function joinUrl(base: string, path: string): string { return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}` }
function safeJson(value: unknown): unknown {
  try { return JSON.parse(JSON.stringify(value)) } catch { return undefined }
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw { code: 'VALIDATION_FAILED', message: 'platform response exceeded safety limit' }
  }
  if (!response.body) {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw { code: 'VALIDATION_FAILED', message: 'platform response exceeded safety limit' }
    return text
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw { code: 'VALIDATION_FAILED', message: 'platform response exceeded safety limit' }
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

function normalizeWriteStatus(value: WriteStatus, request: WriteIdentity): WriteStatus {
  const state = ['submitted', 'published', 'rejected', 'unknown'].includes(value.state) ? value.state : 'unknown'
  const remoteId = readString(value.remoteId)
  const requestId = readRequestId(value.requestId)
  const found = value.found === true
  // A status response is only attributable to the write we asked about when
  // its remote identity agrees with the identity captured by the write
  // receipt.  A provider can return a valid-looking status for another
  // product (or another account) and must not be allowed to turn that into
  // publish evidence.
  // When the caller supplied a remote identity, an omitted identity is not a
  // match.  A provider response without the requested ID is not evidence for
  // that write: accepting it would let an unrelated status turn into a
  // published result.
  const remoteIdentityMatches = !request.remoteId || remoteId === request.remoteId
  if (!remoteIdentityMatches) {
    return {
      found: false,
      state: 'unknown',
      ...(requestId ? { requestId } : {}),
      simulated: false,
    }
  }
  // A platform adapter may only promote a write to published when the remote
  // query found the write and returned an attributable remote identifier. An
  // HTTP response or an unqualified mapper result is not publish evidence.
  // A remote object ID alone is not an attributable write receipt: it can be
  // reused or returned by a broad status endpoint. Require the provider's
  // request correlation ID before allowing a published outcome.
  const publishEvidence = found && Boolean(remoteId && requestId)
  return {
    found,
    state: state === 'published' && !publishEvidence ? 'unknown' : state,
    ...(remoteId ? { remoteId } : {}),
    ...(requestId ? { requestId } : {}),
    simulated: false,
    ...(value.rejection ? { rejection: value.rejection } : {}),
  }
}

const secretKey = /token|secret|authorization|password|credential|code|signature/i
function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[REDACTED]'
  if (Array.isArray(value)) return value.map(item => redact(item, depth + 1))
  if (!isRecord(value)) return typeof value === 'string' && value.length > 20 ? '[REDACTED]' : value
  // Provider error codes are non-secret correlation evidence.  Do not redact
  // them merely because the word "code" appears in the field name; token,
  // authorization and credential-shaped fields remain redacted.
  const safeEvidenceKeys = new Set(['code', 'platformCode', 'rawCode', 'requestId', 'rejection', 'fields', 'path', 'message', 'oauthErrorCode'])
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeEvidenceKeys.has(key) ? item : secretKey.test(key) ? '[REDACTED]' : redact(item, depth + 1)]))
}

function defaultProducts(payload: unknown, platform: Platform): RawProduct[] {
  const candidate = isRecord(payload) && Array.isArray(payload.items) ? payload.items : Array.isArray(payload) ? payload : []
  return candidate.filter(isRecord).map((item, index) => ({
    remoteId: readString(item.remoteId) ?? readString(item.id) ?? `${platform}-remote-${index}`,
    title: readString(item.title) ?? '', description: readString(item.description) ?? '',
    price: readFiniteNumber(item.price) ?? 0, stock: readFiniteNumber(item.stock) ?? 0,
    sku: Array.isArray(item.sku) ? item.sku.filter(isRecord).map((sku, skuIndex) => ({ id: readString(sku.id) ?? `${index}-${skuIndex}`, name: readString(sku.name) ?? '', price: readFiniteNumber(sku.price) ?? 0, stock: readFiniteNumber(sku.stock) ?? 0 })) : [],
    images: readImageUrls(item.images),
    category: readString(item.category) ?? '', attributes: isRecord(item.attributes) ? Object.fromEntries(Object.entries(item.attributes).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, v as string])) : {},
    platformFields: item, observedAt: new Date().toISOString(),
  }))
}

export class HttpPlatformConnector implements PlatformConnector {
  readonly platform: Platform
  readonly readiness: ConnectorReadiness
  readonly authorizationReadiness: ConnectorReadiness
  private readonly fetchImpl: FetchLike
  private readonly writes = new Map<string, WriteStatus>()
  /** Upload receipts are idempotent by key so an outbox retry reuses the media
   * object instead of orphaning a second copy on the platform. */
  private readonly mediaUploads = new Map<string, { fingerprint: string; receipt: MediaUploadReceipt }>()
  private readonly refreshLock: CredentialRefreshSingleFlight

  constructor(readonly profile: PlatformProfile, private readonly options: HttpPlatformConnectorOptions) {
    this.platform = profile.platform
    this.fetchImpl = options.fetch ?? fetch
    this.readiness = validateConnectorReadiness(this.platform, options.config, { allowTestAdapters: options.allowTestAdapters })
    this.authorizationReadiness = validateConnectorAuthorizationReadiness(this.platform, options.config)
    this.refreshLock = options.refreshLock ?? new InProcessCredentialRefreshLock()
  }

  private get config(): HttpConnectorConfig | undefined { return this.options.config }
  mediaUploadReady() { return Boolean(this.config?.mediaUploadPath && this.config.mapMediaUpload && this.config.mediaUploadEvidence && this.readiness.ready) }
  mediaUploadReadiness() {
    const configured = Boolean(this.config?.mediaUploadPath && this.config.mapMediaUpload)
    const evidence = Boolean(this.config?.mediaUploadEvidence && this.readiness.ready)
    return { configured, evidence, ready: configured && evidence }
  }
  private notConfigured<T>(): never { throw new ConnectorFailure(this.normalizeError({ code: 'NOT_CONFIGURED', message: `${this.platform} HTTP connector is not ready` })) as never }
  private requireConfig(): HttpConnectorConfig { if (!this.config || !this.options.credentials || !this.readiness.ready) this.notConfigured(); return this.config }
  private requireOAuthConfig(): HttpConnectorConfig { if (!this.config || !this.options.credentials || !this.authorizationReadiness.ready) this.notConfigured(); return this.config }
  private requireRevokeConfig(): HttpConnectorConfig {
    if (!this.config || !this.options.credentials || !this.config.oauth.revokeUrl?.trim()) this.notConfigured()
    return this.config
  }
  private requireProvider(): VaultCredentialProvider {
    const provider = this.options.credentials
    if (!provider || !provider.store || !provider.kind || (provider.kind !== 'vault' && provider.kind !== 'external' && !(provider.kind === 'test' && this.options.allowTestCredentials))) this.notConfigured()
    return provider as VaultCredentialProvider
  }
  private requireRevocableProvider(): VaultCredentialProvider {
    const provider = this.requireProvider()
    if (!provider.revoke) this.notConfigured()
    return provider
  }

  async authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    const config = this.config
    if (!config || !this.authorizationReadiness.ready) return { ok: false, platform: this.platform, mode: 'not_configured', code: 'NOT_CONFIGURED', message: `${this.platform} OAuth connector is not ready` }
    // The redirect URI is caller-controlled input. Validate it before it is
    // copied into an OAuth URL; in secure environments this also requires
    // HTTPS. Never let an unsafe callback turn a local/mock flow into a
    // production authorization redirect.
    const redirectReason = inspectOutboundUrl(input.redirectUri, { environment: process.env.NODE_ENV, resolveDns: false })
    if (redirectReason) return { ok: false, platform: this.platform, mode: 'not_configured', code: 'VALIDATION_FAILED', message: `OAuth redirect URI rejected: ${redirectReason}` }
    const clientIdKey = this.platform === 'douyin' ? 'client_key' : 'client_id'
    const params = new URLSearchParams({ response_type: 'code', [clientIdKey]: config.clientId, redirect_uri: input.redirectUri, state: input.state })
    if (input.codeVerifier) {
      params.set('code_challenge', pkceChallenge(input.codeVerifier))
      params.set('code_challenge_method', 'S256')
    }
    if (config.oauth.scopes?.length) params.set('scope', config.oauth.scopes.join(this.platform === 'douyin' ? ',' : ' '))
    for (const [key, value] of Object.entries(config.oauth.extraAuthorizeParams ?? {})) params.set(key, value)
    return { ok: true, platform: this.platform, mode: 'real', authorizationUrl: `${config.oauth.authorizeUrl}${config.oauth.authorizeUrl.includes('?') ? '&' : '?'}${params.toString()}` }
  }

  async exchangeCode(input: ExchangeCodeInput): Promise<CredentialRef> {
    const config = this.requireOAuthConfig()
    const provider = this.requireProvider()
    const clientIdKey = this.platform === 'douyin' ? 'client_key' : 'client_id'
    const payload = await this.request('exchange_code', 'POST', config.oauth.tokenUrl, undefined, { grant_type: 'authorization_code', code: input.code, ...(input.redirectUri ? { redirect_uri: input.redirectUri } : {}), ...(input.codeVerifier ? { code_verifier: input.codeVerifier } : {}), [clientIdKey]: config.clientId, ...(config.clientSecret ? { client_secret: config.clientSecret } : {}), ...config.oauth.extraTokenParams }, config.oauth.tokenBodyEncoding ?? 'form', false, undefined, input)
    const credential = this.parseCredential(payload)
    // The credential exists only for this call. A production provider must
    // persist it in Vault/KMS and return an opaque reference.
    const tokenPayload = platformEnvelope(payload) ?? {}
    const remoteAccountId = readString(tokenPayload.account_id) ?? readString(tokenPayload.seller_id) ?? readString(tokenPayload.user_id) ?? readString(tokenPayload.uid) ?? readString(tokenPayload.open_id)
    if (!remoteAccountId) throw new ConnectorFailure(this.normalizeError({ code: 'VALIDATION_FAILED', message: 'OAuth token response did not identify a remote merchant account' }))
    try {
      const stored = await provider.store!({ ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}), accountId: remoteAccountId, credential })
      return {
        ...stored,
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        ...(stored.expiresAt ?? credential.expiresAt ? { expiresAt: stored.expiresAt ?? credential.expiresAt } : {}),
        ...(credential.scope ? { scope: credential.scope } : {}),
        refreshable: Boolean(credential.refreshToken),
      }
    } catch {
      throw new ConnectorFailure(this.normalizeError({ code: 'NOT_CONFIGURED', message: 'credential vault is unavailable' }))
    }
  }

  async refreshCredential(ref: CredentialRef, signal?: AbortSignal): Promise<CredentialRef> {
    const config = this.requireOAuthConfig()
    const provider = this.requireProvider()
    signal?.throwIfAborted()
    const current = await provider.resolve(ref)
    signal?.throwIfAborted()
    if (!current?.refreshToken || !config.oauth.refreshUrl) throw new ConnectorFailure(this.normalizeError({ code: 'UNAUTHORIZED', message: 'refresh credential or refresh endpoint is unavailable' }))
    const clientIdKey = this.platform === 'douyin' ? 'client_key' : 'client_id'
    let payload: unknown
    try {
      payload = await this.request('refresh_credential', 'POST', config.oauth.refreshUrl, undefined, { grant_type: 'refresh_token', refresh_token: current.refreshToken, [clientIdKey]: config.clientId, ...(config.clientSecret ? { client_secret: config.clientSecret } : {}) }, config.oauth.tokenBodyEncoding ?? 'form', false, signal, ref)
    } catch (error) {
      throw this.classifyRefreshGrantFailure(error)
    }
    const next = this.parseCredential(payload, current)
    // Best-effort read-check-write, NOT a compare-and-swap: `provider.store`
    // below is unconditional and has nothing to compare against, so this only
    // *narrows* the overwrite window between two replicas that refreshed from
    // the same token — it cannot close it. The intent is that the token we
    // refreshed from is the only write we are allowed to publish: if another
    // process refreshed concurrently and stored a different access token, its
    // credential is the live one under provider rotation, and overwriting it
    // would destroy the surviving refresh token. Adopt-then-store, with the
    // freshness re-check below, is the best this path can do; the only
    // cross-replica mutex is the lease in `refreshUnderSingleFlight`.
    const concurrent = await this.readStoredCredential(ref)
    // Adopt the peer's credential only if it is still usable. A *different* but
    // already-expired token would otherwise be adopted here and sent to the
    // platform, yielding a 401. The other two adopt paths gate on freshness
    // (`credentialNeedsRefresh`); this one did not.
    const adopted = concurrent?.accessToken && concurrent.accessToken !== current.accessToken && !this.credentialNeedsRefresh(concurrent) ? concurrent : undefined
    if (adopted) return this.credentialRefFor(ref, adopted)
    try {
      signal?.throwIfAborted()
      const stored = await provider.store({ ...(ref.workspaceId ? { workspaceId: ref.workspaceId } : {}), accountId: ref.accountId, credential: next })
      signal?.throwIfAborted()
      return {
        ...stored,
        ...(ref.workspaceId ? { workspaceId: ref.workspaceId } : {}),
        ...(stored.expiresAt ?? next.expiresAt ? { expiresAt: stored.expiresAt ?? next.expiresAt } : {}),
        ...(next.scope ? { scope: next.scope } : {}),
        refreshable: Boolean(next.refreshToken),
      }
    } catch {
      throw new ConnectorFailure(this.normalizeError({ code: 'NOT_CONFIGURED', message: 'credential vault is unavailable' }))
    }
  }

  /**
   * A rotating refresh token that another process already spent comes back as
   * `invalid_grant`. That is a lost race, not a permanent authorization
   * failure: the winning process has stored a usable credential, so the next
   * attempt must be allowed to pick it up. Retrying forever is bounded by the
   * durable outbox attempt limit.
   */
  private classifyRefreshGrantFailure(error: unknown): unknown {
    const normalized = error instanceof ConnectorFailure ? error.normalized : undefined
    if (!normalized) return error
    const details = normalized.details
    const rejection = isRecord(details?.rejection) ? details.rejection : undefined
    const grantCode = readString(details?.oauthErrorCode) ?? readString(details?.platformCode) ?? readString(rejection?.rawCode)
    if (!grantCode || !REFRESH_RACE_CODES.test(grantCode)) return error
    return new ConnectorFailure({
      ...normalized,
      code: 'UNAUTHORIZED',
      retryable: true,
      message: `HTTP connector ${this.platform} token refresh was rejected by the provider; a concurrent refresh may have rotated the refresh token`,
      details: { ...(details ?? {}), refreshRace: true },
    })
  }

  /** Vault reads during refresh are advisory: an unavailable vault must not
   * turn a refreshable credential into a failed request. */
  private async readStoredCredential(ref: CredentialRef): Promise<AccessCredential | undefined> {
    try { return await this.requireProvider().resolve(ref) } catch { return undefined }
  }

  private credentialRefFor(ref: CredentialRef, credential: AccessCredential): CredentialRef {
    return {
      accountId: ref.accountId,
      credentialRef: ref.credentialRef,
      ...(ref.workspaceId ? { workspaceId: ref.workspaceId } : {}),
      ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}),
      ...(credential.scope ? { scope: credential.scope } : {}),
      refreshable: Boolean(credential.refreshToken),
    }
  }

  async revoke(ref: CredentialRef): Promise<void> {
    // Revocation must remain available even when read/write capability evidence
    // is stale: local access is disabled first and remote credential invalidation
    // is then attempted with the minimally required connector configuration.
    const config = this.requireRevokeConfig()
    const provider = this.requireRevocableProvider()
    const credential = await provider.resolve(ref)
    if (!credential) throw new ConnectorFailure(this.normalizeError({ code: 'UNAUTHORIZED', message: 'credential is unavailable' }))
    // Disable the local credential first. A remote revoke outage must never
    // leave the account usable through this connector instance.
    try { await provider.revoke(ref) } catch {
      throw new ConnectorFailure(this.normalizeError({ code: 'NOT_CONFIGURED', message: 'credential vault is unavailable' }))
    }
    const clientIdKey = this.platform === 'douyin' ? 'client_key' : 'client_id'
    if (config.oauth.revokeUrl) await this.request('revoke', 'POST', config.oauth.revokeUrl, credential, { token: credential.accessToken, [clientIdKey]: config.clientId }, config.oauth.tokenBodyEncoding ?? 'form', true, undefined, ref)
  }

  async syncProducts(ctx: ConnectorContext, cursor?: Cursor): Promise<ProductPage> {
    const config = this.requireConfig()
    let syncWindow: ReturnType<typeof validateSyncWindow>
    let requestedCursor: string | undefined
    try {
      syncWindow = validateSyncWindow(config.sync)
      requestedCursor = validateSyncCursor(cursor)
    } catch (error) {
      throw new ConnectorFailure(this.normalizeError({ code: 'VALIDATION_FAILED', message: error instanceof Error ? error.message : 'sync cursor is invalid', retryable: false }))
    }
    const url = new URL(joinUrl(config.api.baseUrl, config.api.syncPath))
    if (requestedCursor) url.searchParams.set('cursor', requestedCursor)
    if (syncWindow?.updatedSince) url.searchParams.set('updated_since', syncWindow.updatedSince)
    if (syncWindow?.updatedUntil) url.searchParams.set('updated_until', syncWindow.updatedUntil)
    let payload: unknown
    try {
      payload = await this.request('sync_products', 'GET', url.toString(), await this.resolveCredential(ctx), undefined, 'json', false, ctx.signal, ctx)
    } catch (error) {
      if (error instanceof ConnectorFailure && error.normalized.code === 'TIMEOUT') {
        throw new ConnectorFailure({ ...error.normalized, unknown: true, retryable: true, details: { ...(error.normalized.details ?? {}), reconcileRequired: true, syncCursor: requestedCursor ?? null } })
      }
      throw error
    }
    let items: RawProduct[]
    try {
      items = deduplicateSyncProducts(config.mapProducts?.(payload, this.platform) ?? defaultProducts(payload, this.platform), this.platform, syncWindow)
      const rawNextCursor = isRecord(payload) && readString(payload.nextCursor) ? { value: readString(payload.nextCursor) } : undefined
      const nextCursor = validateNextSyncCursor(rawNextCursor, requestedCursor)
      return { items, nextCursor, source: 'official_api', simulated: false }
    } catch (error) {
      if (error instanceof SyncContractError) throw new ConnectorFailure(this.normalizeError({ code: 'VALIDATION_FAILED', message: error.message, retryable: false }))
      throw error
    }
  }

  mapToCanonical(raw: RawProduct, mapping: MappingVersion) {
    // The shared platform profiles map the fixture shape, so their canonical
    // draft always claims `source: 'fixture'`. Data read through this connector
    // came from the platform API; without this correction a real, credentialed
    // sync would be persisted as demo data.
    return { ...this.profile.mapProduct(raw, mapping), source: 'official_api' as const }
  }
  validateWrite(input: PlatformWriteDraft) { return this.profile.validateWrite(input) }
  async createProduct(ctx: ConnectorContext, input: PlatformWriteDraft) { return this.write('create', ctx, input) }
  async updateProduct(ctx: ConnectorContext, input: PlatformWriteDraft) { return this.write('update', ctx, input) }

  async queryWrite(ctx: ConnectorContext, request: WriteIdentity): Promise<WriteStatus> {
    const config = this.requireConfig()
    const payload = await this.request('query_write', 'POST', joinUrl(config.api.baseUrl, config.api.queryPath), await this.resolveCredential(ctx), request, 'json', false, ctx.signal, ctx)
    const mapped = config.mapWriteStatus?.(payload, request, this.platform) ?? { found: isRecord(payload) && payload.found === true, state: isRecord(payload) && ['submitted', 'published', 'rejected', 'unknown'].includes(String(payload.state)) ? payload.state as WriteStatus['state'] : 'unknown', remoteId: isRecord(payload) ? readString(payload.remoteId) : undefined, requestId: isRecord(payload) ? readRequestId(payload.requestId) : undefined, ...(this.parseRejection(payload) ? { rejection: this.parseRejection(payload) } : {}), simulated: false }
    const result = normalizeWriteStatus(mapped, request)
    this.writes.set(request.idempotencyKey, result)
    return result
  }

  async uploadMedia(ctx: ConnectorContext, input: MediaUploadInput): Promise<MediaUploadReceipt> {
    const config = this.requireConfig()
    if (!config.mediaUploadPath || !config.mapMediaUpload || !config.mediaUploadEvidence) throw new ConnectorFailure(this.normalizeError({ code: 'NOT_CONFIGURED', message: 'media upload adapter is not configured' }))
    const invalid = validateMediaUploadInput(input)
    if (invalid) throw new ConnectorFailure(this.normalizeError({ code: 'VALIDATION_FAILED', message: invalid, retryable: false }))
    const fingerprint = mediaFingerprint(input)
    const cached = this.mediaUploads.get(input.idempotencyKey)
    if (cached) {
      // Reusing one idempotency key for different bytes would silently publish
      // the wrong media, so the retry has to be rejected instead.
      if (cached.fingerprint !== fingerprint) throw new ConnectorFailure(this.normalizeError({ code: 'CONFLICT', message: 'media upload idempotency key was reused for different content', retryable: false }))
      return cached.receipt
    }
    const payload = await this.request('upload_media', 'POST', joinUrl(config.api.baseUrl, config.mediaUploadPath), await this.resolveCredential(ctx), {
      visualRef: input.visualRef, role: input.role, mimeType: input.mimeType, sha256: input.sha256, idempotencyKey: input.idempotencyKey, contentBase64: Buffer.from(input.bytes).toString('base64'),
    }, 'json', false, ctx.signal, ctx)
    const mapped = config.mapMediaUpload(payload, input, this.platform)
    const record = isRecord(payload) ? payload : {}
    const mediaId = mapped?.mediaId ?? readString(record.mediaId) ?? readString(record.id)
    if (!mediaId) throw new ConnectorFailure(this.normalizeError({ code: 'VALIDATION_FAILED', message: 'media upload response did not identify a media object' }))
    const url = mapped?.url ?? readString(record.url)
    const receipt: MediaUploadReceipt = { platform: this.platform, visualRef: input.visualRef, role: input.role, mediaId, ...(url ? { url } : {}), sha256: input.sha256, simulated: false }
    this.mediaUploads.set(input.idempotencyKey, { fingerprint, receipt })
    return receipt
  }

  /**
   * Compensates media that was uploaded before its write was rejected (a
   * `validateWrite` failure, a cancelled job, or a superseded draft). The
   * platform's delete adapter is used when one is configured; otherwise the
   * receipt is returned as an orphan marker (and handed to `onOrphanedMedia`)
   * so it stays reconcilable. The idempotency cache is only invalidated when
   * the remote object is really gone: an orphaned upload must still be reused
   * by a retry rather than duplicated.
   *
   * Unwired at delivery: nothing calls this production-side, and no deployment
   * injects `deleteMedia`/`onOrphanedMedia` yet. See
   * `PlatformConnector.discardMedia` for the gap and what still has to be
   * connected.
   */
  async discardMedia(ctx: ConnectorContext, receipt: MediaUploadReceipt, reason = 'write_rejected', idempotencyKey?: string): Promise<MediaDiscardResult> {
    if (receipt.platform !== this.platform) throw new ConnectorFailure(this.normalizeError({ code: 'VALIDATION_FAILED', message: 'media receipt belongs to another platform', retryable: false }))
    const cacheKey = idempotencyKey ?? this.mediaCacheKey(receipt)
    if (this.options.deleteMedia) {
      let deleted = false
      try { deleted = await this.options.deleteMedia(ctx, receipt) } catch { deleted = false }
      if (deleted) {
        if (cacheKey) this.mediaUploads.delete(cacheKey)
        return { deleted: true }
      }
    }
    const orphaned: OrphanedMediaRecord = {
      platform: this.platform, accountId: ctx.accountId, visualRef: receipt.visualRef, role: receipt.role,
      mediaId: receipt.mediaId, ...(receipt.url ? { url: receipt.url } : {}), sha256: receipt.sha256,
      idempotencyKey: cacheKey ?? `${this.platform}:${receipt.mediaId}`, reason, observedAt: new Date().toISOString(),
      ...(ctx.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
    }
    try { this.options.onOrphanedMedia?.(Object.freeze(orphaned)) } catch { /* the marker is still returned to the caller */ }
    return { deleted: false, orphaned }
  }

  /** Best-effort recovery of the idempotency key that produced a receipt, for
   * callers that only hold the receipt. */
  private mediaCacheKey(receipt: MediaUploadReceipt): string | undefined {
    for (const [key, entry] of this.mediaUploads) if (entry.receipt.mediaId === receipt.mediaId && entry.receipt.visualRef === receipt.visualRef) return key
    return undefined
  }

  normalizeError(error: unknown): NormalizedPlatformError {
    if (isRecord(error) && isRecord(error.normalized)) return error.normalized as unknown as NormalizedPlatformError
    const candidate = isRecord(error) ? error : {}
    const status = typeof candidate.status === 'number' ? candidate.status : undefined
    const codeValue = readString(candidate.code)
    const outboundCode = /^unsafe outbound URL: (HTTPS_REQUIRED|HOST_NOT_ALLOWLISTED|PRIVATE_ADDRESS_BLOCKED|INVALID_OUTBOUND_URL)$/u.exec(readString(candidate.message) ?? '')?.[1]
    let code: NormalizedPlatformError['code'] = ERROR_CODES.has(codeValue ?? '')
      ? codeValue as NormalizedPlatformError['code']
      : outboundCode as NormalizedPlatformError['code'] | undefined ?? 'REMOTE_ERROR'
    if (status === 401 || status === 403) code = 'UNAUTHORIZED'
    else if (status === 400 || status === 422) code = 'VALIDATION_FAILED'
    else if (status === 404) code = 'NOT_FOUND'
    else if (status === 409) code = 'CONFLICT'
    else if (status === 429) code = 'RATE_LIMITED'
    else if (candidate.name === 'AbortError' || candidate.name === 'TimeoutError' || codeValue === 'TIMEOUT') code = 'TIMEOUT'
    const unknown = code === 'TIMEOUT' || candidate.unknown === true
    const retryable = typeof candidate.retryable === 'boolean' ? candidate.retryable : ['RATE_LIMITED', 'TIMEOUT', 'REMOTE_ERROR'].includes(code)
    const safeMessage = readString(candidate.message)
    const message = code === 'TIMEOUT'
      ? `HTTP connector ${this.platform} request timed out`
      : ['HTTPS_REQUIRED', 'HOST_NOT_ALLOWLISTED', 'PRIVATE_ADDRESS_BLOCKED', 'INVALID_OUTBOUND_URL'].includes(code)
        ? safeMessage ?? `HTTP connector ${this.platform} outbound URL rejected`
      : code === 'VALIDATION_FAILED'
        ? safeMessage ?? 'Connector validation failed'
      : (code === 'UNAUTHORIZED' && safeMessage === 'access credential is unavailable')
          || (code === 'NOT_CONFIGURED' && safeMessage === 'credential vault is unavailable')
          ? safeMessage
          : `HTTP connector ${this.platform} request failed`
    const details = isRecord(candidate.details) ? redact(candidate.details) as Record<string, unknown> : undefined
    const retryAfterMs = typeof candidate.retryAfterMs === 'number' && Number.isFinite(candidate.retryAfterMs) && candidate.retryAfterMs >= 0 ? Math.round(candidate.retryAfterMs) : undefined
    return { code, message, retryable, unknown, status, platform: this.platform, ...(retryAfterMs === undefined ? {} : { retryAfterMs }), ...(details ? { details } : {}) }
  }

  private async write(operation: 'create' | 'update', ctx: ConnectorContext, input: PlatformWriteDraft): Promise<WriteReceipt> {
    const config = this.requireConfig()
    const findings = this.validateWrite(input)
    if (findings.some(finding => finding.severity === 'error')) throw new ConnectorFailure(this.normalizeError({ code: 'VALIDATION_FAILED', message: findings.map(finding => finding.message).join('; ') }))
    const existing = this.writes.get(input.idempotencyKey)
    if (existing?.requestId) return { platform: this.platform, operation, remoteId: existing.remoteId ?? input.remoteId ?? '', requestId: existing.requestId, status: existing.state === 'published' ? 'published' : 'submitted', simulated: false, idempotencyKey: input.idempotencyKey }
    const path = operation === 'create' ? config.api.createPath : config.api.updatePath
    const payload = await this.request(operation === 'create' ? 'create_product' : 'update_product', 'POST', joinUrl(config.api.baseUrl, path), await this.resolveCredential(ctx), { ...input.fields, ...(input.remoteId ? { remoteId: input.remoteId } : {}), idempotencyKey: input.idempotencyKey }, 'json', false, ctx.signal, ctx)
    const mapped = config.mapWriteReceipt?.(payload, input, operation, this.platform) ?? { platform: this.platform, operation, remoteId: isRecord(payload) ? readString(payload.remoteId) ?? input.remoteId ?? '' : input.remoteId ?? '', requestId: isRecord(payload) ? readRequestId(payload.requestId) : undefined, status: 'submitted', simulated: false, idempotencyKey: input.idempotencyKey }
    const requestId = readRequestId(mapped.requestId)
    if (!requestId) {
      throw new ConnectorFailure(this.normalizeError({ code: 'VALIDATION_FAILED', message: 'platform write response did not provide a valid request ID' }))
    }
    // A successful write response means the platform accepted the request.
    // It is never proof that the remote product is published; only queryWrite
    // with platform status evidence may transition to `published`.
    const receipt = { ...mapped, requestId, status: 'submitted' as const }
    this.writes.set(input.idempotencyKey, { found: true, state: 'submitted', remoteId: receipt.remoteId, requestId: receipt.requestId, simulated: false })
    return receipt
  }

  private async resolveCredential(ctx: ConnectorContext): Promise<AccessCredential> {
    this.requireConfig()
    ctx.signal?.throwIfAborted()
    let credential: AccessCredential | undefined
    try { credential = await this.requireProvider().resolve(ctx) } catch {
      throw new ConnectorFailure(this.normalizeError({ code: 'UNAUTHORIZED', message: 'access credential is unavailable' }))
    }
    ctx.signal?.throwIfAborted()
    if (!credential?.accessToken) throw new ConnectorFailure(this.normalizeError({ code: 'UNAUTHORIZED', message: 'access credential is unavailable' }))
    const expiresAt = credential.expiresAt ? Date.parse(credential.expiresAt) : Number.NaN
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now() + CREDENTIAL_EXPIRY_SKEW_MS) {
      if (!credential.refreshToken || !this.config?.oauth.refreshUrl) {
        throw new ConnectorFailure(this.normalizeError({ code: 'UNAUTHORIZED', message: 'access credential is expired and cannot be refreshed' }))
      }
      credential = await this.refreshUnderSingleFlight({ workspaceId: ctx.workspaceId, accountId: ctx.accountId, credentialRef: ctx.credentialRef ?? '' }, credential, ctx.signal)
      ctx.signal?.throwIfAborted()
    }
    return credential
  }

  private credentialNeedsRefresh(credential: AccessCredential): boolean {
    const expiresAt = credential.expiresAt ? Date.parse(credential.expiresAt) : Number.NaN
    return Number.isFinite(expiresAt) && expiresAt <= Date.now() + CREDENTIAL_EXPIRY_SKEW_MS
  }

  /**
   * Serializes refresh for one (workspace, platform, account) across the
   * replicas that share a lease store, and always ends with the credential the
   * vault actually holds. Losing the lease is not a failure: the loser waits
   * for the winner's credential, and only refreshes itself — under the
   * best-effort read-check-write in `refreshCredential` (adopt-then-store; it
   * narrows but does not close the overwrite window) — when the winner does
   * not finish in time. A lease store outage therefore degrades to the guarded
   * read-modify-write path instead of failing every publish. The lease is the
   * only cross-replica mutex: nothing else on this path is atomic.
   */
  private async refreshUnderSingleFlight(ref: CredentialRef, current: AccessCredential, signal?: AbortSignal): Promise<AccessCredential> {
    const key = credentialRefreshKey({ platform: this.platform, workspaceId: ref.workspaceId, accountId: ref.accountId })
    const ttlMs = this.options.refreshLeaseTtlMs ?? DEFAULT_REFRESH_LEASE_TTL_MS
    let lease: CredentialRefreshLease | undefined
    let leaseStoreAvailable = true
    try { lease = await this.refreshLock.tryAcquire(key, ttlMs) } catch { leaseStoreAvailable = false }
    if (leaseStoreAvailable && !lease) {
      const adopted = await this.awaitConcurrentRefresh(ref, current.accessToken, signal)
      if (adopted) return adopted
    }
    try {
      // Double-checked: the winner may have released the lease just before we
      // acquired it, or finished while we were waiting for a lease store that
      // never became reachable. Adopt its credential instead of refreshing
      // again with a refresh token that is already spent.
      const stored = await this.readStoredCredential(ref)
      if (stored?.accessToken && stored.accessToken !== current.accessToken && !this.credentialNeedsRefresh(stored)) return stored
      const refreshed = await this.refreshCredential(ref, signal)
      let resolved: AccessCredential | undefined
      try { resolved = await this.requireProvider().resolve(refreshed) } catch {
        throw new ConnectorFailure(this.normalizeError({ code: 'UNAUTHORIZED', message: 'access credential refresh failed' }))
      }
      signal?.throwIfAborted()
      if (!resolved?.accessToken) throw new ConnectorFailure(this.normalizeError({ code: 'UNAUTHORIZED', message: 'refreshed access credential is unavailable' }))
      return resolved
    } finally {
      try { await lease?.release() } catch { /* an unreleased lease expires on its own */ }
    }
  }

  /** Bounded wait for the replica that holds the lease. Polling the vault (not
   * the lease) is deliberate: the credential is the only observable outcome
   * that is meaningful across processes. */
  private async awaitConcurrentRefresh(ref: CredentialRef, previousAccessToken: string, signal?: AbortSignal): Promise<AccessCredential | undefined> {
    const waitMs = Math.max(0, this.options.refreshWaitMs ?? DEFAULT_REFRESH_WAIT_MS)
    const pollMs = Math.max(1, this.options.refreshPollMs ?? DEFAULT_REFRESH_POLL_MS)
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())), signal)
      signal?.throwIfAborted()
      const stored = await this.readStoredCredential(ref)
      if (stored?.accessToken && stored.accessToken !== previousAccessToken && !this.credentialNeedsRefresh(stored)) return stored
    }
    return undefined
  }

  private parseCredential(payload: unknown, previous?: AccessCredential): AccessCredential {
    const tokenPayload = platformEnvelope(payload) ?? {}
    const accessToken = readCredentialToken(tokenPayload.access_token) ?? readCredentialToken(tokenPayload.accessToken)
    if (!accessToken) throw new ConnectorFailure(this.normalizeError({ code: 'REMOTE_ERROR', message: 'token response did not contain an access token' }))
    const parsedExpiresIn = typeof tokenPayload.expires_in === 'number' ? tokenPayload.expires_in : typeof tokenPayload.expires_in === 'string' ? Number(tokenPayload.expires_in) : Number.NaN
    const expiresIn = Number.isFinite(parsedExpiresIn) && parsedExpiresIn > 0 ? parsedExpiresIn : undefined
    return { accessToken, tokenType: readCredentialToken(tokenPayload.token_type) ?? readCredentialToken(previous?.tokenType), refreshToken: readCredentialToken(tokenPayload.refresh_token) ?? readCredentialToken(previous?.refreshToken), scope: readCredentialToken(tokenPayload.scope) ?? readCredentialToken(previous?.scope), expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : previous?.expiresAt }
  }

  private async request(operation: Parameters<ConnectorBeforeRequest>[0]['operation'], method: string, url: string, credential?: AccessCredential, body?: unknown, encoding: HttpRequestBodyEncoding = 'json', revokeOnly = false, signal?: AbortSignal, context?: { workspaceId?: string; accountId?: string }): Promise<unknown> {
    const oauthTransport = operation === 'exchange_code' || operation === 'refresh_credential' || operation === 'revoke'
    const config = revokeOnly ? this.requireRevokeConfig() : oauthTransport ? this.requireOAuthConfig() : this.requireConfig()
    const headers: Record<string, string> = { accept: 'application/json' }
    if (credential) headers.authorization = `${credential.tokenType ?? 'Bearer'} ${credential.accessToken}`
    let serialized: string | undefined
    if (body !== undefined) {
      if (encoding === 'form' && isRecord(body)) {
        headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8'
        serialized = new URLSearchParams(Object.entries(body).reduce<Record<string, string>>((result, [key, value]) => { if (value !== undefined && value !== null) result[key] = String(value); return result }, {})).toString()
      } else {
        headers['content-type'] = 'application/json'
        serialized = JSON.stringify(body)
      }
    }
    const descriptor: HttpRequestDescriptor = { method, url, headers: { ...headers }, ...(serialized ? { body: serialized } : {}), platform: this.platform, ...(credential ? { credential } : {}) }
    signal?.throwIfAborted()
    // Provider business-API signers must never rewrite OAuth token requests.
    const signed = oauthTransport ? undefined : await config.signer?.sign(descriptor)
    signal?.throwIfAborted()
    Object.assign(headers, signed ?? {})
    Object.assign(headers, descriptor.headers)
    const requestUrl = descriptor.url
    const requestBody = descriptor.body
    if (isSecureEnvironment()) {
      const outboundPolicy = {
        environment: process.env.NODE_ENV,
        allowedHosts: config.allowedHosts ?? officialHostsFor(this.platform),
      }
      const outboundReason = inspectOutboundUrl(requestUrl, { ...outboundPolicy, resolveDns: false })
      if (outboundReason) {
        throw new ConnectorFailure(this.normalizeError({ code: outboundReason, message: `unsafe outbound URL: ${outboundReason}` }))
      }
      try {
        await assertOutboundUrl(requestUrl, outboundPolicy)
      } catch (error) {
        throw new ConnectorFailure(this.normalizeError(error))
      }
    }
    // Deliberately outside the provider-error catch: a local admission denial
    // means nothing was dispatched and must never become an unknown outcome.
    if (this.options.beforeRequest) await this.options.beforeRequest({ operation, platform: this.platform, workspaceId: context?.workspaceId, accountId: context?.accountId, signal })
    signal?.throwIfAborted()
    const controller = new AbortController()
    const abortFromCaller = () => controller.abort(signal?.reason)
    if (signal?.aborted) abortFromCaller()
    else signal?.addEventListener('abort', abortFromCaller, { once: true })
    const timeout = setTimeout(() => controller.abort(new DOMException('platform request timed out', 'TimeoutError')), config.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    try {
      const response = await this.fetchImpl(requestUrl, { method, headers, ...(requestBody ? { body: requestBody } : {}), signal: controller.signal, redirect: 'error' })
      // `Retry-After` is only meaningful for a throttled/retryable response and
      // is header state, so it must be read before the body stream is consumed.
      const retryAfterMs = response.ok ? undefined : parseRetryAfterMs(response.headers.get('retry-after'))
      const text = await readBoundedResponseText(response, MAX_PLATFORM_RESPONSE_BYTES)
      let payload: unknown = undefined
      try { payload = text ? JSON.parse(text) : undefined } catch { payload = text }
      if (this.options.onExchange) {
        const providerId = readRequestId(providerRequestId(payload))
        const observation: ProviderExchangeObservation = {
          platform: this.platform, operation, method, origin: new URL(requestUrl).origin,
          status: response.status, observedAt: new Date().toISOString(), transport: 'fetch',
          ...(context?.workspaceId ? { workspaceId: context.workspaceId } : {}),
          ...(context?.accountId ? { accountId: context.accountId } : {}),
          ...(providerId ? { providerRequestId: providerId } : {}),
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
          ...(!response.ok ? (() => {
            const normalized = this.normalizeError({ status: response.status, message: `platform HTTP ${response.status}` })
            return { errorCode: normalized.code, errorMessage: normalized.message, retryable: normalized.retryable }
          })() : {}),
        }
        try { this.options.onExchange(Object.freeze(observation)) } catch {
          throw { code: 'REMOTE_ERROR', message: 'provider exchange audit failed after response', retryable: false, unknown: true }
        }
      }
      if (!response.ok) {
        const errorPayload = isRecord(payload) && isRecord(payload.error) ? payload.error : payload
        const errorEnvelope = platformEnvelope(errorPayload)
        const providerError = errorEnvelope
          ? platformEnvelope(errorEnvelope.error_response ?? errorEnvelope.platform_rejection ?? errorEnvelope.rejection ?? errorEnvelope.error) ?? errorEnvelope
          : undefined
        const rejection = mapPlatformRejection(errorPayload)
        // OAuth token endpoints answer with the RFC 6749 shape
        // `{ "error": "invalid_grant" }`, which is a string rather than an
        // object and therefore invisible to the rejection mapper. Keep it: a
        // rotated refresh token is a race, a revoked one is terminal, and the
        // connector has to tell them apart.
        const oauthErrorCode = isRecord(errorPayload) ? readString(errorPayload.error) : undefined
        throw {
          status: response.status,
          message: `platform HTTP ${response.status}`,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
          details: isRecord(errorPayload)
            ? {
                ...(readString(providerError?.code) || readString(providerError?.error_code) ? { platformCode: readString(providerError?.code) ?? readString(providerError?.error_code) } : {}),
                ...(providerRequestId(errorPayload) ? { requestId: providerRequestId(errorPayload) } : {}),
                ...(oauthErrorCode ? { oauthErrorCode } : {}),
                ...(rejection ? { rejection } : {}),
              }
            : undefined,
        }
      }
      return payload
    } catch (error) {
      const normalized = this.normalizeError(error)
      throw new ConnectorFailure(normalized)
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abortFromCaller)
    }
  }

  private parseRejection(value: unknown): WriteStatus['rejection'] | undefined {
    const root = platformEnvelope(value)
    if (!root) return undefined
    const rawCode = readString(root.code) ?? readString(root.error_code)
    const rawFields: unknown[] = Array.isArray(root.fields)
      ? root.fields
      : Array.isArray(root.field_errors)
        ? root.field_errors
        : []
    const fields = rawFields.flatMap(item => {
          if (!isRecord(item)) return []
          const path = readString(item.path) ?? readString(item.field) ?? readString(item.name)
          const message = readString(item.message) ?? readString(item.error)
          if (!path || !message) return []
          const rawFieldCode = readString(item.code) ?? readString(item.error_code)
          return [{ path, message, ...(rawFieldCode ? { rawCode: rawFieldCode } : {}) }]
        })
    if (!rawCode && fields.length === 0) return undefined
    return { rawCode: rawCode ?? 'PLATFORM_VALIDATION_FAILED', ...(readString(root.message) || readString(root.error_msg) ? { message: readString(root.message) ?? readString(root.error_msg) } : {}), fields }
  }
}

export function createHttpConnector(platform: Platform, options: HttpPlatformConnectorOptions): PlatformConnector {
  // The constructor is intentionally usable with an incomplete config so the
  // runtime can expose a stable connector and fail closed per operation.
  const profile = { jd: jdProfile, taobao: taobaoProfile, tmall: tmallProfile, pinduoduo: pinduoduoProfile, xiaohongshu: xiaohongshuProfile, douyin: douyinProfile }[platform]
  return new HttpPlatformConnector(profile, options)
}
