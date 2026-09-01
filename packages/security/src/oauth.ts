import { createHash, randomBytes } from 'node:crypto'

export interface OAuthState { state: string; workspaceId: string; actorId: string; platform: string; codeChallenge?: string; codeVerifier?: string; expiresAt: number; consumed: boolean }

export class OAuthStateError extends Error { constructor(public readonly code: 'INVALID_STATE' | 'STATE_EXPIRED' | 'STATE_REPLAYED' | 'STATE_SCOPE_MISMATCH', message: string) { super(message) } }

function safeOAuthText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new OAuthStateError('INVALID_STATE', `OAuth ${field} is invalid`)
  }
  return value
}

function validateOAuthInput(input: { workspaceId: string; actorId: string; platform: string; codeChallenge?: string; codeVerifier?: string }) {
  safeOAuthText(input.workspaceId, 'workspace')
  safeOAuthText(input.actorId, 'actor')
  safeOAuthText(input.platform, 'platform')
  if (input.codeChallenge !== undefined) safeOAuthText(input.codeChallenge, 'code challenge')
  if (input.codeVerifier !== undefined) safeOAuthText(input.codeVerifier, 'code verifier')
}

export class OAuthStateStore {
  private readonly states = new Map<string, OAuthState>()
  constructor(private readonly ttlMs = 600_000, private readonly now = () => Date.now()) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 15 * 60_000) throw new RangeError('OAuth state TTL is invalid')
  }
  issue(input: { workspaceId: string; actorId: string; platform: string; codeChallenge?: string; codeVerifier?: string }) {
    validateOAuthInput(input)
    const state = randomBytes(32).toString('base64url')
    this.states.set(state, { ...input, state, expiresAt: this.now() + this.ttlMs, consumed: false })
    return state
  }
  consume(state: string, expected: { workspaceId: string; platform: string }) {
    safeOAuthText(state, 'state')
    safeOAuthText(expected.workspaceId, 'workspace')
    safeOAuthText(expected.platform, 'platform')
    const record = this.states.get(state)
    if (!record) throw new OAuthStateError('INVALID_STATE', 'OAuth state is invalid')
    if (record.consumed) throw new OAuthStateError('STATE_REPLAYED', 'OAuth state has already been consumed')
    if (this.now() >= record.expiresAt) throw new OAuthStateError('STATE_EXPIRED', 'OAuth state has expired')
    if (record.workspaceId !== expected.workspaceId || record.platform !== expected.platform) throw new OAuthStateError('STATE_SCOPE_MISMATCH', 'OAuth state scope does not match callback')
    record.consumed = true
    return record
  }
  consumeCallback(state: string, platform: string) {
    safeOAuthText(state, 'state')
    safeOAuthText(platform, 'platform')
    const record = this.states.get(state)
    if (!record) throw new OAuthStateError('INVALID_STATE', 'OAuth state is invalid')
    return this.consume(state, { workspaceId: record.workspaceId, platform })
  }
}

const SECRET_KEYS = /access_token|refresh_token|client_secret|app_secret|authorization|credential|password/i
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, SECRET_KEYS.test(key) ? '[REDACTED]' : redactSecrets(child)]))
}

export function hashPkceVerifier(verifier: string) { return createHash('sha256').update(verifier).digest('base64url') }
