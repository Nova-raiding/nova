import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { MemoryPasswordAuthRepository } from '../../../packages/persistence/src/password-auth-repository.js'
import { handlePasswordAuthRoute } from './http-password-auth-routes.js'

describe('password auth account type boundary', () => {
  it('revokes a merchant session when the platform login entry is requested', async () => {
    const repository = new MemoryPasswordAuthRepository()
    const account = await repository.createMerchantAccount({
      login: 'merchant.fixture@example.test',
      password: 'MerchantFixture123',
      enterpriseName: 'Fixture merchant',
      contactName: 'Fixture user',
      workspaceIds: ['workspace-fixture'],
      actorId: 'test-operator',
      reason: 'test fixture account',
    })
    const logout = vi.spyOn(repository, 'logout')
    const setHeader = vi.fn()
    const send = vi.fn()
    const req = { method: 'POST', headers: {}, socket: {} } as IncomingMessage
    const res = { setHeader } as unknown as ServerResponse

    await expect(handlePasswordAuthRoute(req, res, '/v1/auth/login', {
      repository,
      readBody: async () => ({ login: account.login, password: 'MerchantFixture123', account_type: 'platform' }),
      send,
      production: false,
      publicOrigin: 'http://localhost',
      workspaceBootstrap: {} as never,
    })).rejects.toMatchObject({ code: 'AUTH_ACCOUNT_TYPE_MISMATCH', status: 403 })

    expect(logout).toHaveBeenCalledOnce()
    const issuedToken = logout.mock.calls[0]?.[0]
    expect(issuedToken).toEqual(expect.any(String))
    expect(await repository.authenticate(issuedToken!)).toBeUndefined()
    expect(setHeader).not.toHaveBeenCalledWith('set-cookie', expect.anything())
    expect(send).not.toHaveBeenCalled()
  })
})
