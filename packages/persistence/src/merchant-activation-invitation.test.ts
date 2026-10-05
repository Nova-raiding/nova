import { describe, expect, it, vi } from 'vitest'
import { MemoryPasswordAuthRepository, PostgresPasswordAuthRepository } from './password-auth-repository.js'
import type { SqlClient, SqlPool } from './repository.js'
const input = { login: 'invited@example.com', enterpriseName: '客户企业', contactName: '客户本人', workspaceIds: ['workspace-1'], createWorkspace: false,
  actorId: 'operator-1', reason: '按客户合同邀请开户', idempotencyKey: 'invite-request-1' }

describe('existing workspace invitation least-privilege SQL', () => {
  it('stages a pending colleague with scoped SELECT and never requests tenant root UPDATE privileges', async () => {
    let workspaceScope = '', platformScope = false, account: Record<string, unknown> | undefined
    const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      if (sql.includes("set_config('app.platform_scope'")) platformScope = true
      if (sql.includes("set_config('app.workspace_id'")) workspaceScope = String(params[0])
      if (sql.includes('SELECT id FROM workspaces')) {
        if (/FOR\s+(SHARE|UPDATE|KEY SHARE)/iu.test(sql)) throw Object.assign(new Error('permission denied for table workspaces'), { code: '42501' })
        expect(platformScope).toBe(true)
        expect(workspaceScope).toBe(input.workspaceIds[0])
        return { rows: [{ id: workspaceScope }] }
      }
      if (sql.includes('INSERT INTO platform_password_accounts')) account = {
        id: params[0], identityId: params[1], login: params[2], accountType: 'merchant', enterpriseName: params[3], contactName: params[4], passwordHash: params[5],
        workspaceIds: params[6], status: 'merchant_pending', roles: ['merchant'], authEpoch: 0, revision: 1, failedAttempts: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }
      if (sql.includes('login_identifier AS login')) return { rows: account ? [account] : [] }
      return { rows: [] }
    })
    const repository = new PostgresPasswordAuthRepository({ connect: async () => ({ query, release: vi.fn() }) as unknown as SqlClient } as SqlPool)
    const result = await repository.createMerchantInvitation(input)
    expect(result.account).toMatchObject({ status: 'merchant_pending', workspaceIds: input.workspaceIds })
    expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE workspaces'))).toBe(false)
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO workspaces'))).toBe(false)
    expect(query.mock.calls.some(([sql]) => sql.includes('workspace_members') && sql.includes("'invited'"))).toBe(true)
    expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT')
  })
})

describe('safe merchant account activation invitation', () => {
  it('opens only a pending identity then the customer chooses their own password, with no commercial qualification event', async () => {
    const repository = new MemoryPasswordAuthRepository()
    const invitation = await repository.createMerchantInvitation(input)
    expect(invitation.account.status).toBe('merchant_pending')
    expect(invitation.account.workspaceIds).toEqual(['workspace-1'])
    expect(invitation.invitation.token).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    await expect(repository.login({ login: input.login, password: 'CustomerPassword123' })).rejects.toThrow()
    await expect(repository.confirmMerchantInvitation({ token: invitation.invitation.token!, password: 'CustomerPassword123', termsAgreed: false })).rejects.toMatchObject({ code: 'AUTH_TERMS_REQUIRED' })
    // The ordinary reset endpoint cannot consume an activation invitation.
    await expect(repository.confirmPasswordReset(invitation.invitation.token!, 'CustomerPassword123')).rejects.toMatchObject({ code: 'AUTH_RESET_TOKEN_INVALID' })
    const account = await repository.confirmMerchantInvitation({ token: invitation.invitation.token!, password: 'CustomerPassword123', termsAgreed: true })
    expect(account.status).toBe('active')
    expect((await repository.login({ login: input.login, password: 'CustomerPassword123' })).principal.account.id).toBe(account.id)
    await expect(repository.confirmMerchantInvitation({ token: invitation.invitation.token!, password: 'OtherPassword123', termsAgreed: true })).rejects.toMatchObject({ code: 'AUTH_ACTIVATION_TOKEN_INVALID' })
    expect(repository.events.some(event => String(event.eventType).includes('payment') || String(event.eventType).includes('entitlement'))).toBe(false)
    expect(JSON.stringify(repository.events)).not.toContain(invitation.invitation.token)
  })
  it('serializes duplicate create requests and never replays the raw invitation credential', async () => {
    const repository = new MemoryPasswordAuthRepository()
    const results = await Promise.all([repository.createMerchantInvitation(input), repository.createMerchantInvitation(input)])
    expect(results[0]!.account.id).toBe(results[1]!.account.id)
    expect(results.filter(result => result.invitation.token)).toHaveLength(1)
    expect(results[1]!.invitation.replayed).toBe(true)
    await expect(repository.createMerchantInvitation({ ...input, reason: '不同申请内容不允许重放' })).rejects.toMatchObject({ code: 'AUTH_ACTIVATION_IDEMPOTENCY_CONFLICT' })
    expect(await repository.listAccounts()).toHaveLength(1)
  })
  it('reissue invalidates the old link and cannot reset an activated or unrelated existing account', async () => {
    const repository = new MemoryPasswordAuthRepository()
    const first = await repository.createMerchantInvitation(input)
    const second = await repository.createMerchantInvitation({ ...input, action: 'reissue', idempotencyKey: 'invite-request-2' })
    expect(second.account.id).toBe(first.account.id)
    expect(second.invitation.token).not.toBe(first.invitation.token)
    await expect(repository.confirmMerchantInvitation({ token: first.invitation.token!, password: 'CustomerPassword123', termsAgreed: true })).rejects.toMatchObject({ code: 'AUTH_ACTIVATION_TOKEN_INVALID' })
    await repository.confirmMerchantInvitation({ token: second.invitation.token!, password: 'CustomerPassword123', termsAgreed: true })
    await expect(repository.createMerchantInvitation({ ...input, action: 'reissue', idempotencyKey: 'invite-request-3' })).rejects.toMatchObject({ code: 'AUTH_ACTIVATION_REISSUE_UNAVAILABLE' })
    await expect(repository.createMerchantInvitation({ ...input, login: 'unknown@example.com', action: 'reissue', idempotencyKey: 'invite-request-4' })).rejects.toMatchObject({ code: 'AUTH_ACTIVATION_REISSUE_UNAVAILABLE' })
  })
  it('new Workspace invitation is explicit and first customer activation does not authorize commercial spending', async () => {
    const repository = new MemoryPasswordAuthRepository()
    await expect(repository.createMerchantInvitation({ ...input, workspaceIds: [] })).rejects.toMatchObject({ code: 'AUTH_ACCOUNT_PROVISIONING_INVALID' })
    const result = await repository.createMerchantInvitation({ ...input, workspaceIds: [], createWorkspace: true })
    expect(result.account.workspaceIds[0]).toMatch(/^ws_/u)
    expect(result.account.roles).toEqual(['merchant'])
    expect(result.account.status).toBe('merchant_pending')
  })
})
