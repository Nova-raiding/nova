import { randomBytes } from 'node:crypto'
import type { OAuthState } from './oauth.js'
import { OAuthStateError } from './oauth.js'

export interface OAuthRedisPort {
  set(key: string, value: string, ttlSeconds: number): Promise<void>
  get(key: string): Promise<string | null>
  eval(script: string, keys: string[], args: string[]): Promise<unknown>
}

/** Redis-backed OAuth state with TTL and atomic one-time consumption. */
export class RedisOAuthStateStore {
  constructor(private readonly redis: OAuthRedisPort, private readonly prefix = 'merchant:oauth:state', private readonly ttlSeconds = 600) {
    if (typeof prefix !== 'string' || !prefix.trim() || /[\u0000-\u001f\u007f]/u.test(prefix) || !Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 900) {
      throw new RangeError('OAuth Redis state configuration is invalid')
    }
  }

  async issue(input: { workspaceId: string; actorId: string; platform: string; codeChallenge?: string; codeVerifier?: string }) {
    // Exercise the same input boundary as the local implementation before
    // serializing untrusted callback state into Redis.
    const workspaceId = safeOAuthText(input.workspaceId, 'workspace')
    const actorId = safeOAuthText(input.actorId, 'actor')
    const platform = safeOAuthText(input.platform, 'platform')
    const codeChallenge = input.codeChallenge === undefined ? undefined : safeOAuthText(input.codeChallenge, 'code challenge')
    const codeVerifier = input.codeVerifier === undefined ? undefined : safeOAuthText(input.codeVerifier, 'code verifier')
    const state = randomBytes(32).toString('base64url')
    const record: OAuthState = { workspaceId, actorId, platform, ...(codeChallenge ? { codeChallenge } : {}), ...(codeVerifier ? { codeVerifier } : {}), state, expiresAt: Date.now() + this.ttlSeconds * 1000, consumed: false }
    await this.redis.set(this.key(state), JSON.stringify(record), this.ttlSeconds)
    return state
  }

  async consume(state: string, expected: { workspaceId: string; platform: string }) {
    safeOAuthText(state, 'state')
    safeOAuthText(expected.workspaceId, 'workspace')
    safeOAuthText(expected.platform, 'platform')
    const result = await this.redis.eval(CONSUME_SCRIPT, [this.key(state)], [expected.workspaceId, expected.platform])
    const [status, payload] = Array.isArray(result) ? result : []
    if (status === 'missing') throw new OAuthStateError('INVALID_STATE', 'OAuth state is invalid')
    if (status === 'scope') throw new OAuthStateError('STATE_SCOPE_MISMATCH', 'OAuth state scope does not match')
    if (status !== 'ok' || typeof payload !== 'string' || !payload) throw new OAuthStateError('INVALID_STATE', 'OAuth state is invalid')
    let record: OAuthState
    try { record = JSON.parse(payload) as OAuthState } catch { throw new OAuthStateError('INVALID_STATE', 'OAuth state is invalid') }
    if (!record || record.state !== state || typeof record.workspaceId !== 'string' || typeof record.platform !== 'string' || typeof record.expiresAt !== 'number') {
      throw new OAuthStateError('INVALID_STATE', 'OAuth state is invalid')
    }
    if (Date.now() >= record.expiresAt) throw new OAuthStateError('STATE_EXPIRED', 'OAuth state has expired')
    record.consumed = true
    return record
  }

  async consumeCallback(state: string, platform: string) {
    safeOAuthText(state, 'state')
    safeOAuthText(platform, 'platform')
    const raw = await this.redis.get(this.key(state))
    if (!raw) throw new OAuthStateError('INVALID_STATE', 'OAuth state is invalid')
    let record: OAuthState
    try { record = JSON.parse(raw) as OAuthState } catch { throw new OAuthStateError('INVALID_STATE', 'OAuth state is invalid') }
    if (!record || typeof record.workspaceId !== 'string' || typeof record.platform !== 'string') throw new OAuthStateError('INVALID_STATE', 'OAuth state is invalid')
    return this.consume(state, { workspaceId: record.workspaceId, platform })
  }

  private key(state: string) { return `${this.prefix}:${state}` }
}

function safeOAuthText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new OAuthStateError('INVALID_STATE', `OAuth ${field} is invalid`)
  }
  return value
}

const CONSUME_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if not value then return {'missing', ''} end
local record = cjson.decode(value)
if record.workspaceId ~= ARGV[1] or record.platform ~= ARGV[2] then return {'scope', ''} end
redis.call('DEL', KEYS[1])
return {'ok', value}
`
