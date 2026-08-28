import { createHash, randomUUID } from 'node:crypto'
import type {
  AuthorizeInput, AuthorizeResult, ConnectorContext, CredentialRef, Cursor, FakeConnectorOptions, MappingVersion,
  NormalizedPlatformError, PlatformConnector, PlatformProfile, PlatformWriteDraft, ProductPage, RawProduct, WriteIdentity, WriteReceipt, WriteStatus,
} from './types.js'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export class FakePlatformConnector implements PlatformConnector {
  readonly platform: PlatformConnector['platform']
  private readonly writes = new Map<string, WriteStatus>()
  private revoked = false
  private readonly options: Required<Pick<FakeConnectorOptions, 'configured' | 'allowFakeWrites'>> & Pick<FakeConnectorOptions, 'fault'>

  constructor(readonly profile: PlatformProfile, options: FakeConnectorOptions = {}) {
    this.platform = profile.platform
    this.options = { configured: options.configured ?? false, allowFakeWrites: options.allowFakeWrites ?? true, fault: options.fault }
  }

  private throwFault(operation: string) { if (this.options.fault) { const fault = this.options.fault(operation); if (fault) throw fault } }
  private notConfigured<T>(): never { throw new ConnectorFailure(this.normalizeError({ code: 'NOT_CONFIGURED', message: `${this.platform} official API is not configured` })) as never }

  async authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    this.throwFault('authorize')
    if (!this.options.configured) return { ok: false, platform: this.platform, mode: 'not_configured', code: 'NOT_CONFIGURED', message: `${this.platform} official API is not configured` }
    return { ok: true, platform: this.platform, mode: 'fixture', authorizationUrl: `https://fixture.invalid/${this.platform}/authorize?state=${encodeURIComponent(input.state)}` }
  }
  async exchangeCode(input: { code: string; state: string; codeVerifier?: string; workspaceId?: string }): Promise<CredentialRef> {
    this.throwFault('exchangeCode'); if (!this.options.configured) this.notConfigured()
    this.revoked = false
    return {
      accountId: `acct_${this.platform}_${hash(input.state).slice(0, 8)}`,
      credentialRef: `fixture-secret/${this.platform}/${randomUUID()}`,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      expiresAt: new Date(Date.now() + 30 * 24 * 3600_000).toISOString(),
      scope: 'fixture.product.read fixture.product.write',
      refreshable: true,
    }
  }
  async refreshCredential(ref: CredentialRef) { this.throwFault('refreshCredential'); if (!this.options.configured) this.notConfigured(); if (this.revoked) this.unauthorized(); return { ...ref, expiresAt: new Date(Date.now() + 3600_000).toISOString() } }
  async revoke(_ref: CredentialRef) { this.throwFault('revoke'); if (!this.options.configured) this.notConfigured(); this.revoked = true }
  async syncProducts(_ctx: ConnectorContext, cursor?: Cursor): Promise<ProductPage> {
    this.throwFault('syncProducts')
    if (this.revoked) this.unauthorized()
    return { items: cursor?.value ? [] : [structuredClone(this.profile.fixture)], source: 'fixture', simulated: true }
  }
  mapToCanonical(raw: RawProduct, mapping: MappingVersion) { return this.profile.mapProduct(raw, mapping) }
  validateWrite(input: PlatformWriteDraft) { return this.profile.validateWrite(input) }
  async createProduct(ctx: ConnectorContext, input: PlatformWriteDraft) { return this.write('create', ctx, input) }
  async updateProduct(ctx: ConnectorContext, input: PlatformWriteDraft) { return this.write('update', ctx, input) }
  async queryWrite(_ctx: ConnectorContext, request: WriteIdentity): Promise<WriteStatus> {
    this.throwFault('queryWrite')
    if (this.revoked) this.unauthorized()
    return this.writes.get(request.idempotencyKey) ?? { found: false, state: 'unknown', simulated: true }
  }
  normalizeError(error: unknown): NormalizedPlatformError {
    const candidate = error as { code?: string; message?: string; status?: number; unknown?: boolean; retryable?: boolean } | undefined
    const code = candidate?.code
    const normalizedCode: NormalizedPlatformError['code'] = ['NOT_CONFIGURED', 'UNAUTHORIZED', 'RATE_LIMITED', 'TIMEOUT', 'CONFLICT', 'VALIDATION_FAILED', 'NOT_FOUND', 'REMOTE_ERROR'].includes(code ?? '') ? code as NormalizedPlatformError['code'] : 'UNKNOWN'
    const unknown = candidate?.unknown === true || normalizedCode === 'TIMEOUT'
    const retryable = candidate?.retryable ?? ['RATE_LIMITED', 'TIMEOUT', 'REMOTE_ERROR'].includes(normalizedCode)
    return { code: normalizedCode, message: candidate?.message ?? 'Unknown connector failure', retryable, unknown, status: candidate?.status, platform: this.platform }
  }

  private async write(operation: 'create' | 'update', _ctx: ConnectorContext, input: PlatformWriteDraft): Promise<WriteReceipt> {
    this.throwFault(operation)
    if (this.revoked) this.unauthorized()
    if (!this.options.configured && !this.options.allowFakeWrites) this.notConfigured()
    const findings = this.validateWrite(input)
    if (findings.some(finding => finding.severity === 'error')) throw new ConnectorFailure(this.normalizeError({ code: 'VALIDATION_FAILED', message: findings.map(finding => finding.message).join('; '), retryable: false }))
    const existing = this.writes.get(input.idempotencyKey)
    if (existing?.requestId) return { platform: this.platform, operation, remoteId: existing.remoteId ?? input.remoteId ?? `${this.platform}-fake-created`, requestId: existing.requestId, status: existing.state === 'published' ? 'published' : 'submitted', simulated: true, idempotencyKey: input.idempotencyKey }
    const receipt: WriteReceipt = { platform: this.platform, operation, remoteId: input.remoteId ?? `${this.platform}-fake-created`, requestId: `fake_req_${randomUUID()}`, status: 'submitted', simulated: true, idempotencyKey: input.idempotencyKey }
    this.writes.set(input.idempotencyKey, { found: true, state: 'submitted', remoteId: receipt.remoteId, requestId: receipt.requestId, simulated: true })
    return receipt
  }

  private unauthorized<T = never>(): T {
    throw new ConnectorFailure(this.normalizeError({ code: 'UNAUTHORIZED', message: `${this.platform} fixture credential has been revoked` })) as T
  }
}

export class ConnectorFailure extends Error {
  constructor(readonly normalized: NormalizedPlatformError) { super(normalized.message) }
}
