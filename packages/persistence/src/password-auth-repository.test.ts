import { describe, expect, it } from 'vitest'
import { MemoryPasswordAuthRepository } from './password-auth-repository.js'

describe('password authentication', () => {
  it('registers with an Argon2id hash, logs in with an opaque session, and rotates refresh', async () => {
    const auth = new MemoryPasswordAuthRepository()
    const registered = await auth.register({ login: 'merchant@example.com', password: 'CorrectHorse123', enterpriseName: '示例企业', contactName: '张三', termsAgreed: true })
    expect(registered.account.status).toBe('merchant_pending')
    expect(JSON.stringify(registered)).not.toContain('passwordHash')
    await expect(auth.login({ login: 'merchant@example.com', password: 'bad' })).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' })
    await expect(auth.login({ login: 'merchant@example.com', password: 'CorrectHorse123' })).rejects.toMatchObject({ code: 'AUTH_ACCOUNT_NOT_ACTIVE' })
    await auth.activateMerchantAccount({ login: 'merchant@example.com', workspaceIds: ['ws_demo'] })
    const logged = await auth.login({ login: 'merchant@example.com', password: 'CorrectHorse123', ip: '127.0.0.1' })
    expect(logged.token).toEqual(expect.any(String))
    expect(logged.principal.account).not.toHaveProperty('passwordHash')
    const refreshed = await auth.refresh(logged.token)
    expect(refreshed.token).not.toBe(logged.token)
    expect(await auth.authenticate(logged.token)).toBeUndefined()
    expect((await auth.authenticate(refreshed.token))?.sessionId).toBe(refreshed.principal.sessionId)
  })

  it('locks after five failures and uses one-time reset to revoke sessions', async () => {
    const auth = new MemoryPasswordAuthRepository()
    await auth.register({ login: 'lock@example.com', password: 'CorrectHorse123', enterpriseName: '企业', contactName: '李四', termsAgreed: true })
    await auth.activateMerchantAccount({ login: 'lock@example.com', workspaceIds: ['ws_demo'] })
    for (let i = 0; i < 5; i += 1) await expect(auth.login({ login: 'lock@example.com', password: 'wrong-password' })).rejects.toBeDefined()
    await expect(auth.login({ login: 'lock@example.com', password: 'CorrectHorse123' })).rejects.toMatchObject({ code: 'AUTH_ACCOUNT_LOCKED' })
    const reset = await auth.requestPasswordReset('lock@example.com')
    expect(reset.token).toEqual(expect.any(String))
    await auth.confirmPasswordReset(reset.token!, 'NewCorrectHorse123')
    await expect(auth.confirmPasswordReset(reset.token!, 'AnotherCorrect123')).rejects.toMatchObject({ code: 'AUTH_RESET_TOKEN_INVALID' })
    const logged = await auth.login({ login: 'lock@example.com', password: 'NewCorrectHorse123' })
    expect(logged.principal.account.status).toBe('active')
    expect(auth.events.map(event => event.eventType)).toEqual(expect.arrayContaining(['auth.registered', 'auth.login_failed', 'auth.locked', 'auth.password_reset_requested', 'auth.password_reset_confirmed']))
  })

  it('does not expose account existence in reset requests and rejects platform registration through the merchant flow', async () => {
    const auth = new MemoryPasswordAuthRepository()
    expect(await auth.requestPasswordReset('unknown@example.com')).toEqual({ accepted: true })
    await auth.ensurePlatformAccount({ login: 'ops@example.com', passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$invalid$invalid' })
    await expect(auth.register({ login: 'ops@example.com', password: 'CorrectHorse123', enterpriseName: '企业', contactName: '管理员', termsAgreed: true })).rejects.toMatchObject({ code: 'AUTH_LOGIN_ALREADY_EXISTS' })
  })
})
