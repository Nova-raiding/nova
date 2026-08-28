/** Supported platform identifiers. Social-commerce connectors remain fixture-first until official evidence exists. */
export type Platform = 'jd' | 'taobao' | 'tmall' | 'pinduoduo' | 'xiaohongshu' | 'douyin'

export type ConnectorErrorCode =
  | 'NOT_CONFIGURED'
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'CONFLICT'
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'REMOTE_ERROR'
  | 'UNKNOWN'

export interface NormalizedPlatformError {
  code: ConnectorErrorCode
  message: string
  retryable: boolean
  unknown: boolean
  status?: number
  platform: Platform
  details?: Record<string, unknown>
}

export interface ConnectorContext {
  workspaceId: string
  accountId: string
  credentialRef?: string
  traceId?: string
}

export interface AuthorizeInput {
  workspaceId: string
  actorId: string
  redirectUri: string
  state: string
  codeVerifier?: string
}

export interface AuthorizeResult {
  ok: boolean
  platform: Platform
  mode: 'fixture' | 'real' | 'not_configured'
  authorizationUrl?: string
  code?: ConnectorErrorCode
  message?: string
}

export interface CredentialRef {
  accountId: string
  credentialRef: string
  workspaceId?: string
  expiresAt?: string
  /** Non-secret scopes reported by the token endpoint; never infer these from requested scopes. */
  scope?: string
  /** Whether the stored credential included a refresh token. Never exposes the token itself. */
  refreshable?: boolean
}

/**
 * Access credentials are deliberately opaque to the application layer. A
 * production implementation should resolve these from a vault/KMS-backed
 * store and never persist or log the token itself.
 */
export interface AccessCredential {
  accessToken: string
  tokenType?: string
  refreshToken?: string
  expiresAt?: string
  scope?: string
}

export interface CredentialProvider {
  /** `vault`/`external` are production providers; `test` is test-only. */
  readonly kind?: 'vault' | 'external' | 'test'
  resolve(ref: CredentialRef | ConnectorContext): Promise<AccessCredential | undefined>
  store?(input: { workspaceId?: string; accountId: string; credential: AccessCredential }): Promise<CredentialRef>
  revoke?(ref: CredentialRef): Promise<void>
}

/**
 * Explicit production port. Implementations belong to the host application
 * and must keep token material inside Vault/KMS; this package deliberately
 * ships no token cache or in-memory production implementation.
 */
export interface VaultCredentialProvider extends CredentialProvider {
  readonly kind: 'vault' | 'external'
  resolve(ref: CredentialRef | ConnectorContext): Promise<AccessCredential | undefined>
  store(input: { workspaceId?: string; accountId: string; credential: AccessCredential }): Promise<CredentialRef>
  revoke(ref: CredentialRef): Promise<void>
}

export interface HttpRequestDescriptor {
  method: string
  url: string
  headers: Record<string, string>
  body?: string
  platform: Platform
  /** Credential is only held for the duration of signing and is never persisted. */
  credential?: AccessCredential
}

export type HttpRequestBodyEncoding = 'json' | 'form'

/** Platform-specific signing is an injected boundary. No official signing
 * algorithm is implemented by the generic adapter. */
export interface RequestSigner {
  /** Production adapters must identify themselves as a platform signer. */
  readonly kind?: 'platform' | 'test'
  sign(request: HttpRequestDescriptor): Promise<Record<string, string>> | Record<string, string>
}

export interface MappingEvidence {
  version: string
  evidenceRef: string
  verifiedBy: string
  verifiedAt: string
}

/** JSON-path-like response mapping supplied by a reviewed platform adapter. */
export interface GenericResponseMapping {
  itemsPath?: string
  remoteIdPath?: string
  titlePath?: string
  descriptionPath?: string
  pricePath?: string
  stockPath?: string
  skuPath?: string
  skuIdPath?: string
  skuNamePath?: string
  skuPricePath?: string
  skuStockPath?: string
  imagesPath?: string
  categoryPath?: string
  attributesPath?: string
  requestIdPath?: string
  statePath?: string
  foundPath?: string
  mediaIdPath?: string
  mediaUrlPath?: string
}

export interface HttpConnectorConfig {
  /** Must be explicitly supplied; missing or incomplete config fails closed. */
  clientId: string
  clientSecret?: string
  oauth: {
    authorizeUrl: string
    tokenUrl: string
    refreshUrl?: string
    revokeUrl?: string
    scopes?: string[]
    extraAuthorizeParams?: Record<string, string>
    extraTokenParams?: Record<string, string>
    tokenBodyEncoding?: HttpRequestBodyEncoding
  }
  api: {
    baseUrl: string
    syncPath: string
    createPath: string
    updatePath: string
    queryPath: string
  }
  /** Optional platform-specific media upload endpoint. Without it, selected generated visuals remain fail-closed. */
  mediaUploadPath?: string
  /** Evidence that the platform media field/upload mapping was verified end-to-end. */
  mediaUploadEvidence?: MappingEvidence
  timeoutMs?: number
  /** Exact or explicitly reviewed wildcard hosts for all platform endpoints. */
  allowedHosts?: readonly string[]
  signer?: RequestSigner
  /** Optional response mapping for a platform's documented payload shape. */
  responseMapping?: GenericResponseMapping
  mapProducts?: (payload: unknown, platform: Platform) => RawProduct[]
  mapWriteReceipt?: (payload: unknown, input: PlatformWriteDraft, operation: 'create' | 'update', platform: Platform) => WriteReceipt
  mapWriteStatus?: (payload: unknown, request: WriteIdentity, platform: Platform) => WriteStatus
  mapMediaUpload?: (payload: unknown, input: MediaUploadInput, platform: Platform) => Omit<MediaUploadReceipt, 'platform' | 'visualRef' | 'role' | 'sha256' | 'simulated'>
  /** Evidence that the injected platform field mappings were verified. */
  mappingEvidence?: MappingEvidence
  /** Evidence is supplied by the platform adapter/configuration owner. */
  capabilityEvidence?: readonly import('./capability-evidence.js').CapabilityEvidence[]
}

export interface RawProduct {
  remoteId: string
  title: string
  description: string
  price: number
  stock: number
  sku: Array<{ id: string; name: string; price: number; stock: number }>
  images: string[]
  category: string
  attributes: Record<string, string>
  platformFields: Record<string, unknown>
  observedAt: string
  listingStatus?: string
}

export interface Cursor {
  value?: string
}

export interface ProductPage {
  items: RawProduct[]
  nextCursor?: Cursor
  source: 'fixture' | 'official_api'
  simulated: boolean
}

export interface MappingVersion {
  id: string
}

export interface CommerceProductDraft {
  platform: Platform
  remoteId: string
  title: string
  description: string
  price: number
  stock: number
  sku: RawProduct['sku']
  images: string[]
  category: string
  facts: Record<string, string | number>
  mappingVersion: string
  source: 'fixture' | 'official_api'
  listingStatus?: 'on_sale' | 'off_sale' | 'draft' | 'unknown'
  platformUpdatedAt?: string
  rawPlatformFields?: Record<string, unknown>
  mappingWarnings?: string[]
}

export interface PlatformWriteDraft {
  remoteId?: string
  fields: Record<string, unknown>
  idempotencyKey: string
}

export interface MediaUploadInput {
  visualRef: string
  role: 'main' | 'secondary'
  mimeType: string
  sha256: string
  bytes: Uint8Array
  idempotencyKey: string
}

export interface MediaUploadReceipt {
  platform: Platform
  visualRef: string
  role: 'main' | 'secondary'
  mediaId: string
  url?: string
  sha256: string
  simulated: boolean
}

export interface ValidationFinding {
  field: string
  code: 'NOT_ALLOWED' | 'REQUIRED' | 'INVALID_TYPE' | 'INVALID_VALUE'
  message: string
  severity: 'error' | 'warning'
}

export interface WriteReceipt {
  platform: Platform
  operation: 'create' | 'update'
  remoteId: string
  requestId: string
  status: 'submitted' | 'published'
  simulated: boolean
  idempotencyKey: string
}

export interface WriteIdentity {
  idempotencyKey: string
  remoteId?: string
}

export interface PlatformRejectionField {
  path: string
  rawCode?: string
  message: string
}

export interface PlatformRejection {
  rawCode: string
  message?: string
  fields: PlatformRejectionField[]
}

export interface WriteStatus {
  found: boolean
  state: 'submitted' | 'published' | 'rejected' | 'unknown'
  remoteId?: string
  requestId?: string
  simulated: boolean
  rejection?: PlatformRejection
}

export interface PlatformProfile {
  platform: Platform
  schemaProfile: string
  requiredFields: readonly string[]
  writableFields: readonly string[]
  fixture: RawProduct
  mapProduct(raw: RawProduct, mapping: MappingVersion): CommerceProductDraft
  validateWrite(input: PlatformWriteDraft): ValidationFinding[]
}

export interface PlatformConnector {
  readonly platform: Platform
  readonly profile: PlatformProfile
  authorize(input: AuthorizeInput): Promise<AuthorizeResult>
  exchangeCode(input: { code: string; state: string; codeVerifier?: string; workspaceId?: string }): Promise<CredentialRef>
  refreshCredential(ref: CredentialRef): Promise<CredentialRef>
  revoke(ref: CredentialRef): Promise<void>
  syncProducts(ctx: ConnectorContext, cursor?: Cursor): Promise<ProductPage>
  mapToCanonical(raw: RawProduct, mapping: MappingVersion): CommerceProductDraft
  validateWrite(input: PlatformWriteDraft): ValidationFinding[]
  createProduct(ctx: ConnectorContext, input: PlatformWriteDraft): Promise<WriteReceipt>
  updateProduct(ctx: ConnectorContext, input: PlatformWriteDraft): Promise<WriteReceipt>
  queryWrite(ctx: ConnectorContext, request: WriteIdentity): Promise<WriteStatus>
  uploadMedia?(ctx: ConnectorContext, input: MediaUploadInput): Promise<MediaUploadReceipt>
  normalizeError(error: unknown): NormalizedPlatformError
}

export interface FakeConnectorOptions {
  configured?: boolean
  allowFakeWrites?: boolean
  fault?: (operation: string) => unknown
}
