import { describe, expect, it, vi } from 'vitest'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NewApiSelfLogClient } from './provider-usage-log.js'

describe('NewApiSelfLogClient', () => {
  it.each([
    { cost_cny: 0.01, currency: null },
    { cost_cny: 0.01, currency: 'CNY', cost_currency: 'USD' },
    { cost_cny: 0.01, actual_cost_cny: 0.02 },
    { cost_cny: 0.01, actual_cost_cny: 'invalid' },
    { cost_cny: 0.01, user_id: null },
    { cost_cny: 0.01, user_id: -1 },
  ])('rejects ambiguous provider evidence %j', async fields => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: { items: [{ id: 'receipt-1', ...fields }], total: 1 } })))
    const client = new NewApiSelfLogClient({ baseUrl: 'https://relay.example.test', userToken: 'session', userId: 'u1', fetcher })
    await expect(client.listPage()).rejects.toThrow('PROVIDER_USAGE_RECORD_INVALID')
  })

  it('reads paginated user logs with user credentials and normalizes tokens', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: { items: [{ id: 'r1', user_id: 'u1', model_name: 'm', prompt_tokens: 2, completion_tokens: '3', quota: 0.01 }], total: 1 } }), { headers: { 'content-type': 'application/json' } }))
    const client = new NewApiSelfLogClient({ baseUrl: 'https://relay.example.test', userToken: 'session', userId: 'u1', fetcher, pageSize: 200 })
    await expect(client.listPage({ page: 2 })).resolves.toMatchObject({ page: 2, pageSize: 100, complete: true, items: [{ providerRecordId: 'r1', inputTokens: 2, outputTokens: 3, totalTokens: 5 }] })
    expect(fetcher.mock.calls[0]?.[0].toString()).toContain('p=2')
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: 'Bearer session', 'New-Api-User': 'u1' })
  })

  it('keeps provider currency cost separate from quota units', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: { items: [{ id: 'priced-1', prompt_tokens: 2, completion_tokens: 3, quota: 987654, cost_cny: '0.0125', currency: 'CNY' }], total: 1 } })))
    const client = new NewApiSelfLogClient({ baseUrl: 'https://relay.example.test', userToken: 'session', userId: 'u1', fetcher })
    await expect(client.listPage()).resolves.toMatchObject({ items: [{ providerRecordId: 'priced-1', quota: 987654, costCny: 0.0125, costCurrency: 'CNY' }] })
  })

  it('rejects a currency marker without an explicit amount', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: { items: [{ id: 'currency-only', quota: 10, currency: 'CNY' }], total: 1 } })))
    const client = new NewApiSelfLogClient({ baseUrl: 'https://relay.example.test', userToken: 'session', userId: 'u1', fetcher })
    await expect(client.listPage()).rejects.toThrow('PROVIDER_USAGE_RECORD_INVALID')
  })

  it('rejects a malformed explicit provider cost instead of treating quota as currency', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: { items: [{ id: 'bad-cost', prompt_tokens: 1, quota: 10, cost_cny: 'not-a-number' }], total: 1 } })))
    const client = new NewApiSelfLogClient({ baseUrl: 'https://relay.example.test', userToken: 'session', userId: 'u1', fetcher })
    await expect(client.listPage()).rejects.toThrow('PROVIDER_USAGE_RECORD_INVALID')
  })

  it('rejects an explicit non-CNY currency instead of importing it as CNY', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: { items: [{ id: 'usd-cost', cost_cny: 0.01, currency: 'USD' }], total: 1 } })))
    const client = new NewApiSelfLogClient({ baseUrl: 'https://relay.example.test', userToken: 'session', userId: 'u1', fetcher })
    await expect(client.listPage()).rejects.toThrow('PROVIDER_USAGE_RECORD_INVALID')
  })

  it('rejects model API credentials as a substitute for user log credentials', () => {
    expect(() => new NewApiSelfLogClient({ baseUrl: 'https://relay.example.test', userToken: '', userId: 'u1' })).toThrow('PROVIDER_USAGE_USER_CREDENTIALS_REQUIRED')
  })

  it('does not rotate a refresh cookie without a durable shared session file', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const client = new NewApiSelfLogClient({ baseUrl: 'https://relay.example.test', refreshCookie: 'new_api_refresh=initial', userId: 'u1', fetcher })
    await expect(client.listPage()).rejects.toThrow('PROVIDER_USAGE_SESSION_FILE_REQUIRED_FOR_REFRESH')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('refreshes an expired short-lived user token and retries the log request once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'provider-usage-session-'))
    const sessionFile = join(directory, 'session.json')
    try {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/user/auth/refresh') {
        expect(init?.headers).toMatchObject({ cookie: 'new_api_refresh=refresh-session', origin: 'https://relay.example.test' })
        return new Response(JSON.stringify({ data: { access_token: 'fresh-token', user: { id: 'u1' } } }), { headers: { 'content-type': 'application/json', 'set-cookie': 'new_api_refresh=rotated-session; Path=/api/user/auth; HttpOnly; Secure' } })
      }
      const authorization = (init?.headers as Record<string, string>)?.authorization
      if (authorization === 'Bearer expired-token') return new Response('{}', { status: 401 })
      expect(authorization).toBe('Bearer fresh-token')
      return new Response(JSON.stringify({ data: { items: [{ id: 'r1', total_tokens: 5 }], total: 1 } }), { headers: { 'content-type': 'application/json' } })
    })
    const client = new NewApiSelfLogClient({ baseUrl: 'https://relay.example.test', userToken: 'expired-token', refreshCookie: 'new_api_refresh=refresh-session', sessionFile, userId: 'u1', fetcher })
    await expect(client.listPage()).resolves.toMatchObject({ items: [{ providerRecordId: 'r1', totalTokens: 5 }] })
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect((await stat(sessionFile)).mode & 0o777).toBe(0o600)
    await expect(stat(`${sessionFile}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('persists a rotated refresh session and restores it after a process restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'provider-usage-session-'))
    const sessionFile = join(directory, 'session.json')
    try {
      const firstFetcher = vi.fn<typeof fetch>(async (input) => {
        const url = new URL(String(input))
        if (url.pathname === '/api/user/auth/refresh') return new Response(JSON.stringify({ data: { access_token: 'fresh-token', user: { id: 'u1' } } }), { headers: { 'content-type': 'application/json', 'set-cookie': 'new_api_refresh=rotated-session; Path=/api/user/auth; HttpOnly; Secure' } })
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

  it('does not persist a refreshed session for the wrong user or missing secure rotation', async () => {
    for (const response of [
        new Response(JSON.stringify({ data: { access_token: 'other-token', user: { id: 'u2' } } }), { headers: { 'set-cookie': 'new_api_refresh=other; Path=/api/user/auth; HttpOnly; Secure' } }),
        new Response(JSON.stringify({ data: { access_token: 'fresh-token', user: { id: 'u1' } } }), { headers: { 'set-cookie': 'new_api_refresh=rotated; Path=/api/user/auth; HttpOnly' } }),
      ]) {
      const directory = await mkdtemp(join(tmpdir(), 'provider-usage-session-'))
      const sessionFile = join(directory, 'session.json')
      try {
        const fetcher = vi.fn<typeof fetch>(async () => response)
        const client = new NewApiSelfLogClient({ baseUrl: 'https://relay.example.test', refreshCookie: 'new_api_refresh=initial', sessionFile, userId: 'u1', fetcher })
        await expect(client.listPage()).rejects.toThrow(/PROVIDER_USAGE_REFRESH_(IDENTITY|ROTATION)_INVALID/u)
        await expect(readFile(sessionFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(stat(`${sessionFile}.lock`)).resolves.toBeDefined()
        expect(fetcher).toHaveBeenCalledTimes(1)
      } finally { await rm(directory, { recursive: true, force: true }) }
    }
  })

  it('blocks concurrent refreshes and retains the lock after an ambiguous response', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'provider-usage-session-'))
    const sessionFile = join(directory, 'session.json')
    let rejectFirst: ((reason?: unknown) => void) | undefined
    const pending = new Promise<Response>((_resolve, reject) => { rejectFirst = reject })
    try {
      const firstFetcher = vi.fn<typeof fetch>(async () => pending)
      const secondFetcher = vi.fn<typeof fetch>()
      const first = new NewApiSelfLogClient({ baseUrl: 'https://relay.example.test', refreshCookie: 'new_api_refresh=initial', sessionFile, userId: 'u1', fetcher: firstFetcher })
      const second = new NewApiSelfLogClient({ baseUrl: 'https://relay.example.test', refreshCookie: 'new_api_refresh=initial', sessionFile, userId: 'u1', fetcher: secondFetcher })
      const firstAttempt = first.listPage()
      await vi.waitFor(() => expect(firstFetcher).toHaveBeenCalledTimes(1))
      await expect(second.listPage()).rejects.toMatchObject({ code: 'EEXIST' })
      expect(secondFetcher).not.toHaveBeenCalled()
      rejectFirst?.(new Error('ambiguous upstream timeout'))
      await expect(firstAttempt).rejects.toThrow('ambiguous upstream timeout')
      await expect(stat(`${sessionFile}.lock`)).resolves.toBeDefined()
      await expect(first.listPage()).rejects.toMatchObject({ code: 'EEXIST' })
      expect(firstFetcher).toHaveBeenCalledTimes(1)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('reuses a newer persisted session from another replica instead of rotating again', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'provider-usage-session-'))
    const sessionFile = join(directory, 'session.json')
    const logResponse = () => new Response(JSON.stringify({ data: { items: [{ id: 'r1', total_tokens: 1 }], total: 1 } }))
    try {
      await writeFile(sessionFile, JSON.stringify({ userToken: 'old-token', refreshCookie: 'new_api_refresh=old', userId: 'u1' }), { mode: 0o600 })
      let secondLogCalls = 0
      const secondFetcher = vi.fn<typeof fetch>(async (input, init) => {
        expect(new URL(String(input)).pathname).toBe('/api/log/self')
        secondLogCalls += 1
        const token = (init?.headers as Record<string, string>).authorization
        if (secondLogCalls === 1) { expect(token).toBe('Bearer old-token'); return logResponse() }
        if (token === 'Bearer old-token') return new Response('{}', { status: 401 })
        expect(token).toBe('Bearer new-token')
        return logResponse()
      })
      const second = new NewApiSelfLogClient({ baseUrl: 'https://relay.example.test', sessionFile, userId: 'u1', fetcher: secondFetcher })
      await second.listPage()
      const firstFetcher = vi.fn<typeof fetch>(async (input) => {
        if (new URL(String(input)).pathname === '/api/user/auth/refresh') return new Response(JSON.stringify({ data: { access_token: 'new-token', user: { id: 'u1' } } }), { headers: { 'set-cookie': 'new_api_refresh=new; Path=/api/user/auth; HttpOnly; Secure' } })
        return new Response('{}', { status: 401 })
      })
      const first = new NewApiSelfLogClient({ baseUrl: 'https://relay.example.test', sessionFile, userId: 'u1', fetcher: firstFetcher })
      await expect(first.listPage()).rejects.toThrow('PROVIDER_USAGE_HTTP_401')
      await expect(second.listPage()).resolves.toMatchObject({ items: [{ providerRecordId: 'r1' }] })
      expect(secondFetcher).toHaveBeenCalledTimes(3)
      expect(firstFetcher.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/api/user/auth/refresh')).toHaveLength(1)
      await expect(stat(`${sessionFile}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('rejects a world-readable session directory before using a refresh cookie', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'provider-usage-session-'))
    const sessionFile = join(directory, 'session.json')
    const fetcher = vi.fn<typeof fetch>()
    try {
      await chmod(directory, 0o755)
      const client = new NewApiSelfLogClient({ baseUrl: 'https://relay.example.test', refreshCookie: 'new_api_refresh=initial', sessionFile, userId: 'u1', fetcher })
      await expect(client.listPage()).rejects.toThrow('PROVIDER_USAGE_SESSION_DIRECTORY_UNSAFE')
      expect(fetcher).not.toHaveBeenCalled()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('fails closed on malformed records and non-https remote origins', async () => {
    expect(() => new NewApiSelfLogClient({ baseUrl: 'http://relay.example.test', userToken: 'session', userId: 'u1' })).toThrow('PROVIDER_USAGE_BASE_URL_MUST_BE_HTTPS')
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: { items: [{ model_name: 'm' }] } })))
    const client = new NewApiSelfLogClient({ baseUrl: 'https://relay.example.test', userToken: 'session', userId: 'u1', fetcher })
    await expect(client.listPage()).rejects.toThrow('PROVIDER_USAGE_RECORD_INVALID')
  })

  it('does not persist a refreshed session for the wrong user or missing secure rotation', async () => {
    for (const response of [
        new Response(JSON.stringify({ data: { access_token: 'other-token', user: { id: 'u2' } } }), { headers: { 'set-cookie': 'new_api_refresh=other; Path=/api/user/auth; HttpOnly; Secure' } }),
        new Response(JSON.stringify({ data: { access_token: 'fresh-token', user: { id: 'u1' } } }), { headers: { 'set-cookie': 'new_api_refresh=rotated; Path=/api/user/auth; HttpOnly' } }),
      ]) {
      const directory = await mkdtemp(join(tmpdir(), 'provider-usage-session-'))
      const sessionFile = join(directory, 'session.json')
      try {
        const fetcher = vi.fn<typeof fetch>(async () => response)
        const client = new NewApiSelfLogClient({ baseUrl: 'https://relay.example.test', refreshCookie: 'new_api_refresh=initial', sessionFile, userId: 'u1', fetcher })
        await expect(client.listPage()).rejects.toThrow(/PROVIDER_USAGE_REFRESH_(IDENTITY|ROTATION)_INVALID/u)
        await expect(readFile(sessionFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(stat(`${sessionFile}.lock`)).resolves.toBeDefined()
        expect(fetcher).toHaveBeenCalledTimes(1)
      } finally { await rm(directory, { recursive: true, force: true }) }
    }
  })

  it('blocks concurrent refreshes and retains the lock after an ambiguous response', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'provider-usage-session-'))
    const sessionFile = join(directory, 'session.json')
    let rejectFirst: ((reason?: unknown) => void) | undefined
    const pending = new Promise<Response>((_resolve, reject) => { rejectFirst = reject })
    try {
      const firstFetcher = vi.fn<typeof fetch>(async () => pending)
      const secondFetcher = vi.fn<typeof fetch>()
      const first = new NewApiSelfLogClient({ baseUrl: 'https://relay.example.test', refreshCookie: 'new_api_refresh=initial', sessionFile, userId: 'u1', fetcher: firstFetcher })
      const second = new NewApiSelfLogClient({ baseUrl: 'https://relay.example.test', refreshCookie: 'new_api_refresh=initial', sessionFile, userId: 'u1', fetcher: secondFetcher })
      const firstAttempt = first.listPage()
      await vi.waitFor(() => expect(firstFetcher).toHaveBeenCalledTimes(1))
      await expect(second.listPage()).rejects.toMatchObject({ code: 'EEXIST' })
      expect(secondFetcher).not.toHaveBeenCalled()
      rejectFirst?.(new Error('ambiguous upstream timeout'))
      await expect(firstAttempt).rejects.toThrow('ambiguous upstream timeout')
      await expect(stat(`${sessionFile}.lock`)).resolves.toBeDefined()
      await expect(first.listPage()).rejects.toMatchObject({ code: 'EEXIST' })
      expect(firstFetcher).toHaveBeenCalledTimes(1)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('reuses a newer persisted session from another replica instead of rotating again', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'provider-usage-session-'))
    const sessionFile = join(directory, 'session.json')
    const logResponse = () => new Response(JSON.stringify({ data: { items: [{ id: 'r1', total_tokens: 1 }], total: 1 } }))
    try {
      await writeFile(sessionFile, JSON.stringify({ userToken: 'old-token', refreshCookie: 'new_api_refresh=old', userId: 'u1' }), { mode: 0o600 })
      let secondLogCalls = 0
      const secondFetcher = vi.fn<typeof fetch>(async (input, init) => {
        expect(new URL(String(input)).pathname).toBe('/api/log/self')
        secondLogCalls += 1
        const token = (init?.headers as Record<string, string>).authorization
        if (secondLogCalls === 1) { expect(token).toBe('Bearer old-token'); return logResponse() }
        if (token === 'Bearer old-token') return new Response('{}', { status: 401 })
        expect(token).toBe('Bearer new-token')
        return logResponse()
      })
      const second = new NewApiSelfLogClient({ baseUrl: 'https://relay.example.test', sessionFile, userId: 'u1', fetcher: secondFetcher })
      await second.listPage()
      const firstFetcher = vi.fn<typeof fetch>(async (input) => {
        if (new URL(String(input)).pathname === '/api/user/auth/refresh') return new Response(JSON.stringify({ data: { access_token: 'new-token', user: { id: 'u1' } } }), { headers: { 'set-cookie': 'new_api_refresh=new; Path=/api/user/auth; HttpOnly; Secure' } })
        return new Response('{}', { status: 401 })
      })
      const first = new NewApiSelfLogClient({ baseUrl: 'https://relay.example.test', sessionFile, userId: 'u1', fetcher: firstFetcher })
      await expect(first.listPage()).rejects.toThrow('PROVIDER_USAGE_HTTP_401')
      await expect(second.listPage()).resolves.toMatchObject({ items: [{ providerRecordId: 'r1' }] })
      expect(secondFetcher).toHaveBeenCalledTimes(3)
      expect(firstFetcher.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/api/user/auth/refresh')).toHaveLength(1)
      await expect(stat(`${sessionFile}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('rejects a world-readable session directory before using a refresh cookie', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'provider-usage-session-'))
    const sessionFile = join(directory, 'session.json')
    const fetcher = vi.fn<typeof fetch>()
    try {
      await chmod(directory, 0o755)
      const client = new NewApiSelfLogClient({ baseUrl: 'https://relay.example.test', refreshCookie: 'new_api_refresh=initial', sessionFile, userId: 'u1', fetcher })
      await expect(client.listPage()).rejects.toThrow('PROVIDER_USAGE_SESSION_DIRECTORY_UNSAFE')
      expect(fetcher).not.toHaveBeenCalled()
    } finally { await rm(directory, { recursive: true, force: true }) }
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

  it('returns an exact provider actual-cost receipt and never promotes quota-only rows', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: { items: [
      { id: 'provider-actual-1', prompt_tokens: 4, completion_tokens: 6, total_tokens: 10, quota: 1234, cost_cny: '0.021', currency: 'CNY' },
    ], total: 1 } }), { headers: { 'content-type': 'application/json' } }))
    const client = new NewApiSelfLogClient({ baseUrl: 'https://relay.example.test', userToken: 'session', userId: 'u1', fetcher })
    await expect(client.readActualCostReceipt('provider-actual-1')).resolves.toMatchObject({ providerRecordId: 'provider-actual-1', costCny: 0.021, costCurrency: 'CNY' })
    await expect(client.readActualCostReceipt('other-provider-id')).rejects.toThrow('PROVIDER_USAGE_RECEIPT_NOT_FOUND')
  })

  it('fails closed when the provider statement contains any unpriced quota row', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: { items: [
      { id: 'provider-priced', prompt_tokens: 1, completion_tokens: 1, cost_cny: 0.01, currency: 'CNY' },
      { id: 'provider-quota-only', prompt_tokens: 1, completion_tokens: 1, quota: 9 },
    ], total: 2 } }), { headers: { 'content-type': 'application/json' } }))
    const client = new NewApiSelfLogClient({ baseUrl: 'https://relay.example.test', userToken: 'session', userId: 'u1', fetcher })
    await expect(client.readActualCostReceipt('provider-priced')).rejects.toThrow('PROVIDER_USAGE_ACTUAL_COST_INCOMPLETE')
  })

  it('rejects an explicitly cross-user provider row before actual-cost settlement', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: { items: [
      { id: 'provider-other-user', user_id: 2, prompt_tokens: 1, completion_tokens: 1, cost_cny: 0.01, currency: 'CNY' },
    ], total: 1 } }), { headers: { 'content-type': 'application/json' } }))
    const client = new NewApiSelfLogClient({ baseUrl: 'https://relay.example.test', userToken: 'session', userId: 'u1', fetcher })
    await expect(client.readActualCostReceipt('provider-other-user')).rejects.toThrow('PROVIDER_USAGE_IDENTITY_MISMATCH')
  })

  it('rejects unsafe provider request identifiers before making a log request', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const client = new NewApiSelfLogClient({ baseUrl: 'https://relay.example.test', userToken: 'session', userId: 'u1', fetcher })
    await expect(client.readActualCostReceipt('provider-\u0001-id')).rejects.toThrow('PROVIDER_USAGE_REQUEST_ID_INVALID')
    expect(fetcher).not.toHaveBeenCalled()
  })
})
