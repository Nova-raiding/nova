import { describe, expect, it } from 'vitest'
// @ts-expect-error Native installer module intentionally has no build step.
import { enrollLocalMac } from './enroll-local-macos.mjs'

describe('macOS local plugin enrollment', () => {
  it('registers an installation key and opens a short-lived pairing fragment', async () => {
    let saved: Record<string, unknown> | undefined
    let opened = ''
    const response = { installation_id: '11111111-1111-4111-8111-111111111111',
      key_id: '', platform: 'macos', pairing_token: 'p'.repeat(43),
      pairing_expires_at: new Date(Date.now() + 60_000).toISOString() }
    const result = await enrollLocalMac({ baseUrl: 'https://yxsona.com', workspaceId: 'ws_guirenniaoniao', accountId: 'account_123',
      store: { load: () => saved, save: (value: Record<string, unknown>) => { saved = value } },
      fetchImpl: async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        expect(body.platform).toBe('macos')
        expect(body.installation_public_key_spki).toMatch(/^[A-Za-z0-9_-]+$/u)
        // The registration response must echo the generated key fingerprint.
        const { createHash } = await import('node:crypto')
        response.key_id = createHash('sha256').update(Buffer.from(body.installation_public_key_spki, 'base64url')).digest('base64url')
        return new Response(JSON.stringify({ data: response }), { status: 201, headers: { 'content-type': 'application/json' } })
      },
      openBrowser: (url: string) => { opened = url },
    })
    expect(result).toMatchObject({ ok: true, pairing_started: true, installation_id: response.installation_id })
    expect(saved?.installation_id).toBe(response.installation_id)
    expect(opened).toMatch(/^https:\/\/yxsona\.com\/#plugin_pair=/u)
    const pair = JSON.parse(Buffer.from(opened.split('#plugin_pair=')[1]!, 'base64url').toString())
    expect(pair).toMatchObject({ installation_id: response.installation_id, workspace_id: 'ws_guirenniaoniao' })
    expect(opened).not.toContain('installation_private_key_pkcs8')
  })

  it('refuses a mismatched registration key without saving an identity', async () => {
    let saved = false
    await expect(enrollLocalMac({ baseUrl: 'https://yxsona.com', workspaceId: 'ws_test', accountId: 'account_123',
      store: { load: () => undefined, save: () => { saved = true } },
      fetchImpl: async () => new Response(JSON.stringify({ data: { installation_id: '11111111-1111-4111-8111-111111111111',
        key_id: 'wrong', platform: 'macos', pairing_token: 'p'.repeat(43), pairing_expires_at: new Date(Date.now() + 60_000).toISOString() } }), { status: 201 }),
      openBrowser: () => {},
    })).rejects.toThrow('LOCAL_PLUGIN_ENROLL_FAILED')
    expect(saved).toBe(false)
  })
})
