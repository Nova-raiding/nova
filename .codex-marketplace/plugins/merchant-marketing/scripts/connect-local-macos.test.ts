import { describe, expect, it } from 'vitest'
// @ts-expect-error Native Node helper module intentionally has no build step.
import { parseConnectUrl, parseEnrollUrl } from './connect-local-macos.mjs'

describe('Store Nova custom protocol helper', () => {
  const valid = 'storenova://connect?api_origin=https%3A%2F%2Fyxsona.com&workspace=ws_guirenniaoniao&request_id=req_1234567890abcdef'

  it('accepts only the non-secret one-time connection metadata', () => {
    expect(parseConnectUrl(valid)).toEqual({ baseUrl: 'https://yxsona.com', workspaceId: 'ws_guirenniaoniao', requestId: 'req_1234567890abcdef' })
  })

  it('accepts a complete installation challenge without allowing partial proof fields', () => {
    const url = new URL(valid)
    for (const [key, value] of Object.entries({ account_id: 'account_123',
      installation_id: '11111111-1111-4111-8111-111111111111',
      challenge_id: '22222222-2222-4222-8222-222222222222', server_nonce: 'n'.repeat(43),
      challenge_issued_at: '2026-09-28T00:00:00.000Z', challenge_expires_at: '2026-09-28T00:02:00.000Z' })) url.searchParams.set(key, value)
    expect(parseConnectUrl(url.toString()).proof).toMatchObject({ account_id: 'account_123', server_nonce: 'n'.repeat(43) })
    url.searchParams.delete('challenge_id')
    expect(() => parseConnectUrl(url.toString())).toThrow('PARAMETERS_INVALID')
  })

  it('requires an account-scoped enrollment target', () => {
    const validEnroll = 'storenova://enroll?api_origin=https%3A%2F%2Fyxsona.com&workspace=ws_guirenniaoniao&account_id=account_123'
    expect(parseEnrollUrl(validEnroll)).toEqual({ baseUrl: 'https://yxsona.com', workspaceId: 'ws_guirenniaoniao', accountId: 'account_123' })
    expect(() => parseEnrollUrl(validEnroll.replace('&account_id=account_123', ''))).toThrow()
  })

  it.each([
    `${valid}&token=secret`, `${valid}&password=secret`, `${valid}&code=secret`,
    valid.replace('storenova://connect', 'https://connect'),
    valid.replace('request_id=req_1234567890abcdef', 'request_id=short'),
    valid.replace('https%3A%2F%2Fyxsona.com', 'not-a-url'),
    `${valid}&workspace=ws_other`,
    valid.replace('https%3A%2F%2Fyxsona.com', 'https%3A%2F%2Fu%3Ap%40yxsona.com'),
  ])('fails closed for unsafe or ambiguous URL %s', value => {
    expect(() => parseConnectUrl(value)).toThrow(/^LOCAL_PLUGIN_CONNECT_/u)
  })
})
