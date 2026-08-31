import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NewApiSelfLogClient } from './provider-usage-log.js'

describe('NewApiSelfLogClient', () => {
  it('reads paginated user logs with user credentials and normalizes tokens', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: { items: [{ id: 'r1', user_id: 'u1', model_name: 'm', prompt_tokens: 2, completion_tokens: '3', quota: 0.01 }], total: 1 } }), { headers: { 'content-type': 'application/json' } }))
    const client = new NewApiSelfLogClient({ baseUrl: 'https://relay.example.test', userToken: 'session', userId: 'u1', fetcher, pageSize: 200 })
    await expect(client.listPage({ page: 2 })).resolves.toMatchObject({ page: 2, pageSize: 100, complete: true, items: [{ providerRecordId: 'r1', inputTokens: 2, outputTokens: 3, totalTokens: 5 }] })
    expect(fetcher.mock.calls[0]?.[0].toString()).toContain('p=2')
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: 'Bearer session', 'New-Api-User': 'u1' })
  })

  it('rejects model API credentials as a substitute for user log credentials', () => {
    expect(() => new NewApiSelfLogClient({ baseUrl: 'https://relay.example.test', userToken: '', userId: 'u1' })).toThrow('PROVIDER_USAGE_USER_CREDENTIALS_REQUIRED')
  })

  it('refreshes an expired short-lived user token and retries the log request once', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/user/auth/refresh') {
        expect(init?.headers).toMatchObject({ cookie: 'new_api_refresh=refresh-session' })
        return new Response(JSON.stringify({ data: { access_token: 'fresh-token' } }), { headers: { 'content-type': 'application/json', 'set-cookie': 'new_api_refresh=rotated-session; Path=/api/user/auth; HttpOnly' } })
      }
      const authorization = (init?.headers as Record<string, string>)?.authorization
      if (authorization === 'Bearer expired-token') return new Response('{}', { status: 401 })
      expect(authorization).toBe('Bearer fresh-token')
      return new Response(JSON.stringify({ data: { items: [{ id: 'r1', total_tokens: 5 }], total: 1 } }), { headers: { 'content-type': 'application/json' } })
    })
    const client = new NewApiSelfLogClient({ baseUrl: 'https://relay.example.test', userToken: 'expired-token', refreshCookie: 'new_api_refresh=refresh-session', userId: 'u1', fetcher })
    await expect(client.listPage()).resolves.toMatchObject({ items: [{ providerRecordId: 'r1', totalTokens: 5 }] })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('persists a rotated refresh session and restores it after a process restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'provider-usage-session-'))
    const sessionFile = join(directory, 'session.json')
    try {
      const firstFetcher = vi.fn<typeof fetch>(async (input) => {
        const url = new URL(String(input))
        if (url.pathname === '/api/user/auth/refresh') return new Response(JSON.stringify({ data: { access_token: 'fresh-token' } }), { headers: { 'content-type': 'application/json', 'set-cookie': 'new_api_refresh=rotated-session; Path=/api/user/auth; HttpOnly' } })
        return new Response(JSON.stringify({ data: { items: [{ id: 'r1', total_tokens: 5 }], total: 1 } }), { headers: { 'content-type': 'application/json' } })
      })
      const first = new NewApiSelfLogClient({ baseUrl: 'https://relay.example.test', refreshCookie: 'new_api_refresh=initial-session', sessionFile, userId: 'u1', fetcher: firstFetcher })
      await first.listPage()
      await expect(readFile(sessionFile, 'utf8')).resolves.toContain('new_api_refresh=rotated-session')

      const secondFetcher = vi.fn<typeof fetch>(async (_input, init) => {
        expect(init?.headers).toMatchObject({ authorization: 'Bearer fresh-token' })
        return new Response(JSON.stringify({ data: { items: [{ id: 'r2', total_tokens: 7 }], total: 1 } }), { headers: { 'content-type': 'application/json' } })
      })
      const restarted = new NewApiSelfLogClient({ baseUrl: 'https://relay.example.test', sessionFile, userId: 'u1', fetcher: secondFetcher })
      await expect(restarted.listPage()).resolves.toMatchObject({ items: [{ providerRecordId: 'r2', totalTokens: 7 }] })
      expect(secondFetcher).toHaveBeenCalledTimes(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('fails closed on malformed records and non-https remote origins', async () => {
    expect(() => new NewApiSelfLogClient({ baseUrl: 'http://relay.example.test', userToken: 'session', userId: 'u1' })).toThrow('PROVIDER_USAGE_BASE_URL_MUST_BE_HTTPS')
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: { items: [{ model_name: 'm' }] } })))
    const client = new NewApiSelfLogClient({ baseUrl: 'https://relay.example.test', userToken: 'session', userId: 'u1', fetcher })
    await expect(client.listPage()).rejects.toThrow('PROVIDER_USAGE_RECORD_INVALID')
  })

  it('walks every provider page and rejects duplicate provider records', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const page = new URL(String(input)).searchParams.get('p')
      const payload = page === '1'
        ? { data: { items: [{ id: 'r1', prompt_tokens: 1, completion_tokens: 2 }], total: 2 } }
        : { data: { items: [{ id: 'r2', prompt_tokens: 3, completion_tokens: 4 }], total: 2 } }
      return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })
    })
    const client = new NewApiSelfLogClient({ baseUrl: 'https://relay.example.test', userToken: 'session', userId: 'u1', fetcher, pageSize: 1 })
    await expect(client.listAll()).resolves.toMatchObject({ pages: 2, complete: true, records: [{ providerRecordId: 'r1' }, { providerRecordId: 'r2' }] })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
