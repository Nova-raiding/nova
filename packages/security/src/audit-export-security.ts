import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export type AuditExportSecurityCode =
  | 'AUDIT_EXPORT_CURSOR_FORBIDDEN'
  | 'AUDIT_EXPORT_SCOPE_INVALID'
  | 'AUDIT_EXPORT_SCOPE_MISMATCH'
  | 'AUDIT_EXPORT_LINK_EXPIRED'
  | 'AUDIT_EXPORT_LINK_NOT_FOUND'

export class AuditExportSecurityError extends Error {
  constructor(readonly code: AuditExportSecurityCode, message: string) {
    super(message)
    this.name = 'AuditExportSecurityError'
  }
}

export interface AuditExportScope {
  tenantId: string
  workspaceId: string
  /** A platform scope is an exact platform identifier, never a wildcard. */
  platformId?: string
}

export interface AuditExportRequest {
  scope: AuditExportScope
  /** Exports are intentionally not cursor-paginated. */
  cursor?: unknown
}

export interface AuthorizedAuditExportScope {
  tenantId: string
  workspaceIds: readonly string[]
  platformIds?: readonly string[]
}

const WILDCARD = /[*?]/u
const CONTROL = /[\u0000-\u001f\u007f]/u
const MAX_LINK_TOKEN_LENGTH = 4096
const MAX_LINK_SECRET_LENGTH = 4096

function exactIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || CONTROL.test(value) || WILDCARD.test(value)) {
    throw new AuditExportSecurityError('AUDIT_EXPORT_SCOPE_INVALID', `${field} must be an exact identifier`)
  }
  return value.trim()
}

/**
 * Validates the security boundary before an export query is constructed.
 * Export is a bounded snapshot operation: a cursor (especially `*`) can
 * accidentally turn a scoped export into an unbounded or cross-scope read.
 */
export function validateAuditExportRequest(input: AuditExportRequest, authorized: AuthorizedAuditExportScope): AuditExportScope {
  if (input.cursor !== undefined && input.cursor !== null && input.cursor !== '') {
    throw new AuditExportSecurityError('AUDIT_EXPORT_CURSOR_FORBIDDEN', 'audit exports must not accept a cursor')
  }
  const tenantId = exactIdentifier(input.scope?.tenantId, 'tenantId')
  const workspaceId = exactIdentifier(input.scope?.workspaceId, 'workspaceId')
  const platformId = input.scope?.platformId === undefined ? undefined : exactIdentifier(input.scope.platformId, 'platformId')
  const authorizedTenant = exactIdentifier(authorized.tenantId, 'authorized tenantId')
  if (tenantId !== authorizedTenant || !authorized.workspaceIds.includes(workspaceId)) {
    throw new AuditExportSecurityError('AUDIT_EXPORT_SCOPE_MISMATCH', 'audit export is outside the authorized tenant/workspace scope')
  }
  if (platformId !== undefined && (!authorized.platformIds || !authorized.platformIds.includes(platformId))) {
    throw new AuditExportSecurityError('AUDIT_EXPORT_SCOPE_MISMATCH', 'audit export is outside the authorized platform scope')
  }
  return { tenantId, workspaceId, ...(platformId ? { platformId } : {}) }
}

export interface AuditExportLinkRecord {
  exportId: string
  scope: AuditExportScope
  token: string
  expiresAt: number
}

export interface AuditExportLinkStoreOptions {
  now?: () => number
  ttlMs?: number
  secret?: string
}

/** In-memory local link store. Production adapters must persist equivalent expiry/revocation semantics. */
export class AuditExportLinkStore {
  private readonly records = new Map<string, AuditExportLinkRecord>()
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly secret: string

  constructor(options: AuditExportLinkStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.ttlMs = options.ttlMs ?? 5 * 60_000
    this.secret = options.secret ?? randomBytes(32).toString('hex')
    if (typeof this.now !== 'function') throw new AuditExportSecurityError('AUDIT_EXPORT_SCOPE_INVALID', 'link clock is invalid')
    if (typeof this.secret !== 'string' || !this.secret || this.secret.length > MAX_LINK_SECRET_LENGTH || CONTROL.test(this.secret)) throw new AuditExportSecurityError('AUDIT_EXPORT_SCOPE_INVALID', 'link secret is invalid')
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1_000 || this.ttlMs > 15 * 60_000) throw new AuditExportSecurityError('AUDIT_EXPORT_SCOPE_INVALID', 'link TTL is invalid')
  }

  issue(input: { exportId: string; scope: AuditExportScope }): AuditExportLinkRecord {
    const exportId = exactIdentifier(input.exportId, 'exportId')
    const scope = validateAuditExportRequest({ scope: input.scope }, { tenantId: input.scope.tenantId, workspaceIds: [input.scope.workspaceId], platformIds: input.scope.platformId ? [input.scope.platformId] : undefined })
    const issuedAt = this.now()
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new AuditExportSecurityError('AUDIT_EXPORT_SCOPE_INVALID', 'link clock is invalid')
    const expiresAt = issuedAt + this.ttlMs
    const unsigned = `${exportId}.${scope.tenantId}.${scope.workspaceId}.${scope.platformId ?? ''}.${expiresAt}.${randomBytes(18).toString('base64url')}`
    const signature = createHmac('sha256', this.secret).update(unsigned).digest('base64url')
    const token = `${unsigned}.${signature}`
    const record = { exportId, scope, token, expiresAt }
    this.records.set(token, record)
    return { ...record }
  }

  resolve(token: string, expectedScope: AuditExportScope): AuditExportLinkRecord {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_LINK_TOKEN_LENGTH || CONTROL.test(token)) {
      throw new AuditExportSecurityError('AUDIT_EXPORT_LINK_NOT_FOUND', 'audit export link is invalid')
    }
    const expectedTenantId = exactIdentifier(expectedScope?.tenantId, 'tenantId')
    const expectedWorkspaceId = exactIdentifier(expectedScope?.workspaceId, 'workspaceId')
    const expectedPlatformId = expectedScope?.platformId === undefined ? undefined : exactIdentifier(expectedScope.platformId, 'platformId')
    this.cleanupExpired()
    const record = this.records.get(token)
    if (!record) throw new AuditExportSecurityError('AUDIT_EXPORT_LINK_NOT_FOUND', 'audit export link was not found')
    if (record.expiresAt <= this.now()) {
      this.records.delete(token)
      throw new AuditExportSecurityError('AUDIT_EXPORT_LINK_EXPIRED', 'audit export link has expired')
    }
    const dot = token.lastIndexOf('.')
    if (dot <= 0) throw new AuditExportSecurityError('AUDIT_EXPORT_LINK_NOT_FOUND', 'audit export link is invalid')
    const expected = createHmac('sha256', this.secret).update(token.slice(0, dot)).digest('base64url')
    const actual = token.slice(dot + 1)
    if (!/^[A-Za-z0-9_-]{43}$/u.test(actual) || expected.length !== actual.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) throw new AuditExportSecurityError('AUDIT_EXPORT_LINK_NOT_FOUND', 'audit export link is invalid')
    if (record.scope.tenantId !== expectedTenantId || record.scope.workspaceId !== expectedWorkspaceId || record.scope.platformId !== expectedPlatformId) throw new AuditExportSecurityError('AUDIT_EXPORT_SCOPE_MISMATCH', 'audit export link is outside the requested scope')
    return { ...record }
  }

  revoke(token: string): boolean { return this.records.delete(token) }

  cleanupExpired(now = this.now()): number {
    let removed = 0
    for (const [token, record] of this.records) if (record.expiresAt <= now) { this.records.delete(token); removed += 1 }
    return removed
  }

  size(): number { this.cleanupExpired(); return this.records.size }
}
