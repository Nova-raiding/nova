import { describe, expect, it } from 'vitest'
import { AuditExportLinkStore, AuditExportSecurityError, validateAuditExportRequest } from './audit-export-security.js'

const authorized = { tenantId: 'tenant_1', workspaceIds: ['ws_1', 'ws_2'] as const, platformIds: ['taobao'] as const }
const scope = { tenantId: 'tenant_1', workspaceId: 'ws_1', platformId: 'taobao' }
const rejectsWithCode = (run: () => unknown, code: string) => {
  try { run(); throw new Error('expected function to throw') } catch (error) { expect(error).toMatchObject({ code }) }
}

describe('audit export security boundary', () => {
  it('rejects wildcard and any cursor instead of treating it as an export scope', () => {
    expect(() => validateAuditExportRequest({ scope, cursor: '*' }, authorized)).toThrowError(new AuditExportSecurityError('AUDIT_EXPORT_CURSOR_FORBIDDEN', 'audit exports must not accept a cursor'))
    rejectsWithCode(() => validateAuditExportRequest({ scope, cursor: 'opaque-page-2' }, authorized), 'AUDIT_EXPORT_CURSOR_FORBIDDEN')
    rejectsWithCode(() => validateAuditExportRequest({ scope: { ...scope, workspaceId: '*' } }, authorized), 'AUDIT_EXPORT_SCOPE_INVALID')
    rejectsWithCode(() => validateAuditExportRequest({ scope: { ...scope, platformId: '*' } }, authorized), 'AUDIT_EXPORT_SCOPE_INVALID')
  })

  it('requires an exact tenant, workspace and authorized platform scope', () => {
    rejectsWithCode(() => validateAuditExportRequest({ scope: { ...scope, tenantId: 'tenant_2' } }, authorized), 'AUDIT_EXPORT_SCOPE_MISMATCH')
    rejectsWithCode(() => validateAuditExportRequest({ scope: { ...scope, workspaceId: 'ws_other' } }, authorized), 'AUDIT_EXPORT_SCOPE_MISMATCH')
    rejectsWithCode(() => validateAuditExportRequest({ scope: { ...scope, platformId: 'jd' } }, authorized), 'AUDIT_EXPORT_SCOPE_MISMATCH')
    rejectsWithCode(() => validateAuditExportRequest({ scope }, { tenantId: 'tenant_1', workspaceIds: ['ws_1'] }), 'AUDIT_EXPORT_SCOPE_MISMATCH')
    expect(validateAuditExportRequest({ scope }, authorized)).toEqual(scope)
  })

  it('issues scope-bound links and rejects cross-tenant/workspace/platform resolution', () => {
    let now = 1_000_000
    const store = new AuditExportLinkStore({ now: () => now, ttlMs: 5_000, secret: 'local-test-secret' })
    const link = store.issue({ exportId: 'export_1', scope })
    expect(store.resolve(link.token, scope)).toMatchObject({ exportId: 'export_1', scope })
    rejectsWithCode(() => store.resolve(link.token, { ...scope, tenantId: 'tenant_2' }), 'AUDIT_EXPORT_SCOPE_MISMATCH')
    rejectsWithCode(() => store.resolve(link.token, { ...scope, workspaceId: 'ws_2' }), 'AUDIT_EXPORT_SCOPE_MISMATCH')
    rejectsWithCode(() => store.resolve(link.token, { ...scope, platformId: 'jd' }), 'AUDIT_EXPORT_SCOPE_MISMATCH')
  })

  it('cleans expired links and does not allow an expired token to be reused', () => {
    let now = 1_000_000
    const store = new AuditExportLinkStore({ now: () => now, ttlMs: 5_000, secret: 'local-test-secret' })
    const link = store.issue({ exportId: 'export_1', scope })
    expect(store.size()).toBe(1)
    now += 5_000
    expect(store.cleanupExpired()).toBe(1)
    expect(store.size()).toBe(0)
    rejectsWithCode(() => store.resolve(link.token, scope), 'AUDIT_EXPORT_LINK_NOT_FOUND')
  })

  it('fails closed for malformed runtime tokens and scopes', () => {
    const store = new AuditExportLinkStore({ secret: 'local-test-secret' })
    const link = store.issue({ exportId: 'export_1', scope })
    rejectsWithCode(() => store.resolve(null as unknown as string, scope), 'AUDIT_EXPORT_LINK_NOT_FOUND')
    rejectsWithCode(() => store.resolve(`${link.token.slice(0, -43)}${'!'.repeat(43)}`, scope), 'AUDIT_EXPORT_LINK_NOT_FOUND')
    rejectsWithCode(() => store.resolve(link.token, { ...scope, workspaceId: null as unknown as string }), 'AUDIT_EXPORT_SCOPE_INVALID')
    rejectsWithCode(() => store.resolve(link.token, { ...scope, platformId: '\n' }), 'AUDIT_EXPORT_SCOPE_INVALID')
  })

  it('fails closed for unsafe signing configuration and clock evidence', () => {
    rejectsWithCode(() => new AuditExportLinkStore({ secret: '' }), 'AUDIT_EXPORT_SCOPE_INVALID')
    rejectsWithCode(() => new AuditExportLinkStore({ secret: 'secret\nvalue' }), 'AUDIT_EXPORT_SCOPE_INVALID')
    rejectsWithCode(() => new AuditExportLinkStore({ secret: 'x'.repeat(4097) }), 'AUDIT_EXPORT_SCOPE_INVALID')
    const invalidClock = new AuditExportLinkStore({ now: () => Number.NaN, secret: 'local-test-secret' })
    rejectsWithCode(() => invalidClock.issue({ exportId: 'export_1', scope }), 'AUDIT_EXPORT_SCOPE_INVALID')
  })
})
