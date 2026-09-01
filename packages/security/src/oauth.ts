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

// Match the common snake_case, kebab-case and camelCase spellings emitted by
// OAuth clients and provider SDKs. Redaction is deliberately key-based: the
// value is never inspected or partially retained once a secret-shaped field
// is encountered.
const SECRET_KEYS = /(?:access[\s_-]?token|refresh[\s_-]?token|client[\s_-]?secret|app[\s_-]?secret|(?:authorization|auth)[\s_-]?(?:code|token)|api[\s_-]?key|private[\s_-]?key|code[\s_-]?(?:verifier|challenge)|credential|password|passphrase)/iu
const REDACTION_MAX_DEPTH = 8
const REDACTION_MAX_STRING = 2048
export function redactSecrets(value: unknown): unknown {
  const seen = new WeakSet<object>()
  const visit = (current: unknown, depth: number): unknown => {
    if (depth > REDACTION_MAX_DEPTH) return '[TRUNCATED]'
    if (typeof current === 'string') return current.length > REDACTION_MAX_STRING ? `${current.slice(0, REDACTION_MAX_STRING)}...[TRUNCATED]` : current
    if (!current || typeof current !== 'object') return current
    if (seen.has(current)) return '[CIRCULAR]'
    seen.add(current)
    if (Array.isArray(current)) return current.slice(0, 100).map(item => visit(item, depth + 1))
    return Object.fromEntries(Object.entries(current).map(([key, child]) => [key, SECRET_KEYS.test(key) ? '[REDACTED]' : visit(child, depth + 1)]))
  }
  return visit(value, 0)
}

export function hashPkceVerifier(verifier: string) { return createHash('sha256').update(verifier).digest('base64url') }
