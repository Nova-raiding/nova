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
  constructor(private readonly redis: OAuthRedisPort, private readonly prefix = 'merchant:oauth:state', private readonly ttlSeconds = 600) {}

  async issue(input: { workspaceId: string; actorId: string; platform: string; codeChallenge?: string; codeVerifier?: string }) {
    const state = randomBytes(32).toString('base64url')
    const record: OAuthState = { ...input, state, expiresAt: Date.now() + this.ttlSeconds * 1000, consumed: false }
    await this.redis.set(this.key(state), JSON.stringify(record), this.ttlSeconds)
    return state
  }

  async consume(state: string, expected: { workspaceId: string; platform: string }) {
    const result = await this.redis.eval(CONSUME_SCRIPT, [this.key(state)], [expected.workspaceId, expected.platform])
    const [status, payload] = Array.isArray(result) ? result : []
    if (status === 'missing') throw new OAuthStateError('INVALID_STATE', 'OAuth state is invalid')
    if (status === 'scope') throw new OAuthStateError('STATE_SCOPE_MISMATCH', 'OAuth state scope does not match')
    if (status !== 'ok' || typeof payload !== 'string' || !payload) throw new OAuthStateError('INVALID_STATE', 'OAuth state is invalid')
    const record = JSON.parse(payload) as OAuthState
    if (Date.now() >= record.expiresAt) throw new OAuthStateError('STATE_EXPIRED', 'OAuth state has expired')
    record.consumed = true
    return record
  }

  async consumeCallback(state: string, platform: string) {
    const raw = await this.redis.get(this.key(state))
    if (!raw) throw new OAuthStateError('INVALID_STATE', 'OAuth state is invalid')
    const record = JSON.parse(raw) as OAuthState
    return this.consume(state, { workspaceId: record.workspaceId, platform })
  }

  private key(state: string) { return `${this.prefix}:${state}` }
}

const CONSUME_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if not value then return {'missing', ''} end
local record = cjson.decode(value)
if record.workspaceId ~= ARGV[1] or record.platform ~= ARGV[2] then return {'scope', ''} end
redis.call('DEL', KEYS[1])
return {'ok', value}
`
