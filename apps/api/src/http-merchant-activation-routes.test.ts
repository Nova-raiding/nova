import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { MemoryPasswordAuthRepository } from '../../../packages/persistence/src/password-auth-repository.js'
import { handleMerchantActivationRoute, inviteMerchantAccount, merchantActivationPath } from './http-merchant-activation-routes.js'
import { authorizeMerchantAccount } from './http-ops-merchant-account-authorization.js'
const request = (method = 'POST') => ({ method, headers: {} }) as IncomingMessage
const input = { login: 'invited@example.com', enterprise_name: '企业', contact_name: '本人', workspace_ids: [], create_workspace: true, reason: '客户申请安全开户', idempotency_key: 'invitation-api-1' }
const deps = (repository: MemoryPasswordAuthRepository, value: Record<string, unknown> = input) => ({ repository, readBody: async () => value, requireOperationsRole: vi.fn(() => 'operator-1'), requestActor: () => 'operator-1', publicOrigin: 'https://yxsona.com', production: true })
describe('merchant invitation and public activation boundaries', () => {
  it('requires real Ops authorization before creating anything and rejects old payment/password fields', async () => {
    const repository = new MemoryPasswordAuthRepository(), dependencies = deps(repository)
    dependencies.requireOperationsRole.mockImplementation(() => { throw Object.assign(new Error('forbidden'), { code: 'FORBIDDEN' }) })
    await expect(inviteMerchantAccount(request(), dependencies)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(inviteMerchantAccount(request(), deps(repository, { ...input, password: 'OperatorPassword123', payment_status: 'verified' }))).rejects.toMatchObject({ code: 'AUTH_ACCOUNT_INVITATION_INVALID' })
    expect(await repository.listAccounts()).toHaveLength(0)
  })
  it('returns a one-time fragment invitation at the actual merchant /api proxy path, never a password or a paid grant', async () => {
    const response = await inviteMerchantAccount(request(), deps(new MemoryPasswordAuthRepository()))
    expect(response.status).toBe(201)
    const view = response.data as { invitation: { activation_link: string; delivery_status: string }; commercial_qualification_granted: boolean; capabilities_granted: string[] }
    const url = new URL(view.invitation.activation_link)
    expect(url.pathname).toBe(`/api${merchantActivationPath}`)
    expect(url.search).toBe('')
    expect(url.hash).toMatch(/^#token=/u)
    expect(view.invitation.delivery_status).toBe('not_sent')
    expect(view.commercial_qualification_granted).toBe(false)
    expect(view.capabilities_granted).toEqual([])
    expect(JSON.stringify(response.data)).not.toContain('password')
  })
  it('public activation HTML has no user/token facts, no-store, CSP and no referer; POST consumes customer token without session/payment authority', async () => {
    const repository = new MemoryPasswordAuthRepository(), result = await repository.createMerchantInvitation({ login: input.login, enterpriseName: input.enterprise_name, contactName: input.contact_name, workspaceIds: [], createWorkspace: true, actorId: 'operator', reason: input.reason, idempotencyKey: input.idempotency_key })
    const headers = new Map<string, string>(), end = vi.fn(), res = { setHeader: (key: string, value: string) => headers.set(key, value), end } as unknown as ServerResponse
    const send = vi.fn()
    expect(await handleMerchantActivationRoute(request('GET'), res, merchantActivationPath, { repository, readBody: async () => ({}), send })).toBe(true)
    expect(headers.get('cache-control')).toBe('no-store')
    expect(headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(headers.get('referrer-policy')).toBe('no-referrer')
    expect(end.mock.calls[0]?.[0]).not.toContain(result.invitation.token)
    await handleMerchantActivationRoute(request(), res, merchantActivationPath, { repository, readBody: async () => ({ token: result.invitation.token!, password: 'CustomerPassword123', terms_agreed: true }), send })
    expect(send).toHaveBeenCalledWith(200, { activated: true, login_required: true, commercial_qualification_granted: false })
    expect(headers.has('set-cookie')).toBe(false)
    await expect(handleMerchantActivationRoute(request(), res, merchantActivationPath, { repository, readBody: async () => ({ token: result.invitation.token!, password: 'CustomerPassword123', terms_agreed: true }), send })).rejects.toMatchObject({ code: 'AUTH_ACTIVATION_TOKEN_INVALID' })
  })
  it('invalid production origin fails before account creation', async () => {
    const repository = new MemoryPasswordAuthRepository()
    await expect(inviteMerchantAccount(request(), { ...deps(repository), publicOrigin: 'http://example.com' })).rejects.toMatchObject({ code: 'AUTH_ACTIVATION_ORIGIN_UNAVAILABLE' })
    expect(await repository.listAccounts()).toHaveLength(0)
  })
  it('legacy authorization cannot create payment/entitlement facts and permits only exact historical replay lookup', async () => {
    const find = vi.fn(async () => undefined)
    const dependencies = { body: async () => ({ login: input.login, workspace_id: 'workspace-1', idempotency_key: 'legacy-key-1', payment_status: 'verified', amount_fen: 1 }), requireOperationsRole: () => 'operator', operations: () => ({ find }) as never }
    await expect(authorizeMerchantAccount(request(), dependencies)).rejects.toMatchObject({ code: 'MERCHANT_LEGACY_AUTHORIZATION_DISABLED', status: 410 })
    find.mockResolvedValueOnce({ after: { idempotency_key: 'legacy-key-1', order_id: 'old-legal-order' } } as never)
    expect(await authorizeMerchantAccount(request(), dependencies)).toEqual({ status: 200, data: { idempotency_key: 'legacy-key-1', order_id: 'old-legal-order', replayed: true, read_only: true } })
  })
})
