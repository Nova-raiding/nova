import { describe, expect, it, vi } from 'vitest'
import { navigatePlatformAuthorization, startPlatformAuthorization, type PlatformAuthorizationReply } from './platform-oauth-launch'

describe('platform OAuth user activation', () => {
  it('opens a private blank tab synchronously before requesting and navigating to consent', async () => {
    const sequence: string[] = []
    const meta = { name: '', content: '' }
    const popup = {
      opener: {} as Window | null,
      document: { createElement: vi.fn(() => meta), head: { appendChild: vi.fn(() => sequence.push('referrer-policy')) } },
      location: { replace: vi.fn(() => sequence.push('navigate')) },
      close: vi.fn(() => sequence.push('close')),
    } as unknown as Window
    const openWindow = vi.fn((url: string, target: string) => {
      sequence.push('open')
      expect(url).toBe('about:blank')
      expect(target).toBe('_blank')
      return popup
    })
    let resolveAuthorization!: (reply: PlatformAuthorizationReply) => void
    const authorize = vi.fn(() => {
      sequence.push('authorize')
      return new Promise<PlatformAuthorizationReply>(resolve => { resolveAuthorization = resolve })
    })

    const attempt = startPlatformAuthorization(openWindow, authorize)
    expect(attempt.status).toBe('pending')
    expect(sequence).toEqual(['open', 'referrer-policy', 'authorize'])
    expect(popup.opener).toBeNull()
    expect(meta).toEqual({ name: 'referrer', content: 'no-referrer' })
    expect(popup.location.replace).not.toHaveBeenCalled()

    resolveAuthorization({ mode: 'official_api', authorizationUrl: 'https://platform.example/authorize?state=server-issued' })
    if (attempt.status !== 'pending') throw new Error('popup unexpectedly blocked')
    const result = await attempt.result
    navigatePlatformAuthorization(attempt.popup, result.authorizationUrl!)
    expect(popup.location.replace).toHaveBeenCalledExactlyOnceWith('https://platform.example/authorize?state=server-issued')
    expect(sequence).toEqual(['open', 'referrer-policy', 'authorize', 'navigate'])
    expect(() => navigatePlatformAuthorization(popup, 'javascript:alert(1)')).toThrow('未通过安全校验')
  })
})
