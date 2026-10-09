import { describe, expect, it } from 'vitest'
import { MemoryPasswordAuthRepository } from './password-auth-repository.js'

describe('memory merchant registration workspace validation', () => {
  it('rejects unknown and inactive workspaces without activating the application', async () => {
    const repository = new MemoryPasswordAuthRepository(undefined, id => id === 'ws-inactive' ? 'disabled' : undefined)
    await repository.register({ login: 'review@example.com', password: 'CorrectHorse123', enterpriseName: '企业', contactName: '管理员', termsAgreed: true })

    await expect(repository.reviewMerchantRegistration({ login: 'review@example.com', decision: 'approved', workspaceIds: ['ws-unknown'], reason: '审核并绑定企业' }))
      .rejects.toMatchObject({ code: 'AUTH_WORKSPACE_NOT_FOUND' })
    await expect(repository.reviewMerchantRegistration({ login: 'review@example.com', decision: 'approved', workspaceIds: ['ws-inactive'], reason: '审核并绑定企业' }))
      .rejects.toMatchObject({ code: 'AUTH_WORKSPACE_NOT_FOUND' })
    await expect(repository.listAccounts()).resolves.toEqual([
      expect.objectContaining({ login: 'review@example.com', status: 'merchant_pending', workspaceIds: [] }),
    ])
  })

  it('approves only when every selected workspace is known and active', async () => {
    const repository = new MemoryPasswordAuthRepository(undefined, id => id === 'ws-active' ? 'active' : undefined)
    await repository.register({ login: 'active-review@example.com', password: 'CorrectHorse123', enterpriseName: '企业', contactName: '管理员', termsAgreed: true })

    await expect(repository.reviewMerchantRegistration({ login: 'active-review@example.com', decision: 'approved', workspaceIds: ['ws-active'], actorId: 'operator', reason: '审核并绑定企业' }))
      .resolves.toMatchObject({ status: 'active', workspaceIds: ['ws-active'] })
  })
})
