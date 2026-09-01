import { describe, expect, it } from 'vitest'
import { OAuthStateError, OAuthStateStore, hashPkceVerifier, redactSecrets } from './oauth.js'
import { RedisOAuthStateStore, type OAuthRedisPort } from './redis-oauth.js'

describe('OAuth security', () => {
  it('binds callback state to workspace/platform and consumes it once', () => {
    let time = 1000
    const store = new OAuthStateStore(600, () => time)
    const state = store.issue({ workspaceId: 'ws_1', actorId: 'actor_1', platform: 'taobao' })
    expect(() => store.consume(state, { workspaceId: 'ws_2', platform: 'taobao' })).toThrowError(OAuthStateError)
    expect(store.consume(state, { workspaceId: 'ws_1', platform: 'taobao' }).actorId).toBe('actor_1')
    expect(() => store.consume(state, { workspaceId: 'ws_1', platform: 'taobao' })).toThrowError(/consumed/)
    const expired = store.issue({ workspaceId: 'ws_1', actorId: 'actor_1', platform: 'jd' })
    time = 2000
    expect(() => store.consume(expired, { workspaceId: 'ws_1', platform: 'jd' })).toThrowError(/expired/)
    const callbackState = store.issue({ workspaceId: 'ws_1', actorId: 'actor_1', platform: 'pinduoduo' })
    expect(store.consumeCallback(callbackState, 'pinduoduo').workspaceId).toBe('ws_1')
    const wrongPlatform = store.issue({ workspaceId: 'ws_1', actorId: 'actor_1', platform: 'jd' })
    expect(() => store.consumeCallback(wrongPlatform, 'taobao')).toThrowError(/scope/)
  })

  it('redacts secret-shaped keys recursively', () => {
    expect(redactSecrets({ access_token: 'a', nested: { client_secret: 'b', ok: 'c' } })).toEqual({ access_token: '[REDACTED]', nested: { client_secret: '[REDACTED]', ok: 'c' } })
    expect(redactSecrets({ accessToken: 'a', refreshToken: 'b', apiKey: 'c', privateKey: 'd', authorizationCode: 'e', codeVerifier: 'f', visible: 'ok' })).toEqual({ accessToken: '[REDACTED]', refreshToken: '[REDACTED]', apiKey: '[REDACTED]', privateKey: '[REDACTED]', authorizationCode: '[REDACTED]', codeVerifier: '[REDACTED]', visible: 'ok' })
    expect(hashPkceVerifier('verifier')).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('bounds audit redaction for circular and deeply nested evidence', () => {
    const circular: Record<string, unknown> = { safe: 'ok', accessToken: 'secret' }
    circular.self = circular
    expect(redactSecrets(circular)).toEqual({ safe: 'ok', accessToken: '[REDACTED]', self: '[CIRCULAR]' })

    let nested: Record<string, unknown> = { value: 'leaf' }
    for (let depth = 0; depth < 12; depth++) nested = { nested }
    let bounded: unknown = redactSecrets(nested)
    for (let depth = 0; depth < 9; depth++) bounded = (bounded as { nested: unknown }).nested
    expect(bounded).toBe('[TRUNCATED]')
  })

  it('uses TTL-backed Redis state with one-time atomic consumption semantics', async () => {
    const data = new Map<string, string>()
    const redis: OAuthRedisPort = {
      async set(key, value) { data.set(key, value) },
      async get(key) { return data.get(key) ?? null },
      async eval(_script, keys, args) {
        const raw = data.get(keys[0]!)
        if (!raw) return ['missing', '']
        const record = JSON.parse(raw) as { workspaceId: string; platform: string }
        if (record.workspaceId !== args[0] || record.platform !== args[1]) return ['scope', '']
        data.delete(keys[0]!)
        return ['ok', raw]
      },
    }
    const store = new RedisOAuthStateStore(redis, 'test:oauth', 60)
    const state = await store.issue({ workspaceId: 'ws_redis', actorId: 'actor', platform: 'jd', codeVerifier: 'verifier' })
    await expect(store.consume(state, { workspaceId: 'ws_other', platform: 'jd' })).rejects.toThrow(/scope/)
    await expect(store.consume(state, { workspaceId: 'ws_redis', platform: 'jd' })).resolves.toMatchObject({ codeVerifier: 'verifier', consumed: true })
    await expect(store.consume(state, { workspaceId: 'ws_redis', platform: 'jd' })).rejects.toThrow(/invalid/)
  })

  it('rejects unsafe state inputs and malformed Redis records fail closed', async () => {
    const store = new OAuthStateStore()
    expect(() => store.issue({ workspaceId: 'ws\n1', actorId: 'actor', platform: 'jd' })).toThrowError(/workspace is invalid/)
    expect(() => new OAuthStateStore(0)).toThrow(/TTL is invalid/)

    const data = new Map<string, string>()
    const redis: OAuthRedisPort = {
      async set(key, value) { data.set(key, value) },
      async get(key) { return data.get(key) ?? null },
      async eval(script, keys) {
        const raw = data.get(keys[0]!)
        if (!raw) return ['missing', '']
        if (script.includes('pcall(cjson.decode')) {
          try { JSON.parse(raw) } catch { return ['invalid', ''] }
        }
        return ['ok', raw]
      },
    }
    const redisStore = new RedisOAuthStateStore(redis, 'test:oauth', 60)
    const state = await redisStore.issue({ workspaceId: 'ws_1', actorId: 'actor', platform: 'jd' })
    data.set(`test:oauth:${state}`, '{malformed')
    await expect(redisStore.consume(state, { workspaceId: 'ws_1', platform: 'jd' })).rejects.toMatchObject({ code: 'INVALID_STATE' })

    const validRecord = JSON.stringify({ state, workspaceId: 'ws_1', actorId: 'actor', platform: 'jd', expiresAt: Number.NaN, consumed: false })
    data.set(`test:oauth:${state}`, validRecord)
    await expect(redisStore.consume(state, { workspaceId: 'ws_1', platform: 'jd' })).rejects.toMatchObject({ code: 'INVALID_STATE' })

    data.set(`test:oauth:${state}`, JSON.stringify({ state, workspaceId: 'ws_1', actorId: { forged: true }, platform: 'jd', expiresAt: Date.now() + 30_000, consumed: false }))
    await expect(redisStore.consume(state, { workspaceId: 'ws_1', platform: 'jd' })).rejects.toMatchObject({ code: 'INVALID_STATE' })
  })
})
