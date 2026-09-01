/**
 * Local JIT grant state machine used to exercise the same linearization
 * boundary as a durable grant store.  The production adapter must replace the
 * process mutex with a database transaction/row lock; this module deliberately
 * does not pretend to be a distributed store.
 */

export type JitGrantRejection = 'revoked' | 'expired' | 'max_uses' | 'scope_mismatch' | 'actor_mismatch' | 'not_found'

export interface JitGrantRecord {
  id: string
  actorId: string
  workspaceId: string
  capability: string
  scopeHash: string
  issuedAt: number
  expiresAt: number
  maxUses: number
  useCount: number
  revision: number
  revokedAt?: number
}

export interface JitGrantDecision {
  allowed: boolean
  reason: 'allowed' | JitGrantRejection
  grant?: JitGrantRecord
}

export interface JitGrantStoreOptions {
  now?: () => number
  idFactory?: () => string
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${field} must be a non-empty safe string`)
  }
  return value
}

function safePositive(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 100) throw new RangeError(`${field} must be between 1 and 100`)
  return value as number
}

/**
 * A small, deterministic local adapter for concurrency and fail-closed tests.
 * Every consume and revoke is serialized, so max-use cannot be oversold and a
 * revoke that linearizes first prevents every later consume.
 */
export class LocalJitGrantStore {
  private readonly grants = new Map<string, JitGrantRecord>()
  private readonly now: () => number
  private readonly idFactory: () => string
  private tail: Promise<void> = Promise.resolve()

  constructor(options: JitGrantStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.idFactory = options.idFactory ?? (() => `jit_${Math.random().toString(36).slice(2, 14)}`)
  }

  async issue(input: Omit<JitGrantRecord, 'id' | 'useCount' | 'revision' | 'revokedAt'> & { id?: string }): Promise<JitGrantRecord> {
    return this.serialized(() => {
      const actorId = text(input.actorId, 'actorId')
      const workspaceId = text(input.workspaceId, 'workspaceId')
      const capability = text(input.capability, 'capability')
      const scopeHash = text(input.scopeHash, 'scopeHash')
      if (!Number.isSafeInteger(input.issuedAt) || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= input.issuedAt) throw new RangeError('grant time window is invalid')
      const maxUses = safePositive(input.maxUses, 'maxUses')
      const id = text(input.id ?? this.idFactory(), 'id')
      if (this.grants.has(id)) throw new Error('JIT grant id already exists')
      const grant: JitGrantRecord = { id, actorId, workspaceId, capability, scopeHash, issuedAt: input.issuedAt, expiresAt: input.expiresAt, maxUses, useCount: 0, revision: 1 }
      this.grants.set(id, grant)
      return this.clone(grant)
    })
  }

  async consume(input: { id: string; actorId: string; workspaceId: string; capability: string; scopeHash: string; at?: number }): Promise<JitGrantDecision> {
    return this.serialized(() => {
      const id = text(input.id, 'id')
      const grant = this.grants.get(id)
      if (!grant) return { allowed: false, reason: 'not_found' }
      const at = input.at ?? this.now()
      if (!Number.isSafeInteger(at)) return { allowed: false, reason: 'expired' }
      if (grant.actorId !== input.actorId) return { allowed: false, reason: 'actor_mismatch' }
      if (grant.workspaceId !== input.workspaceId || grant.capability !== input.capability || grant.scopeHash !== input.scopeHash) return { allowed: false, reason: 'scope_mismatch' }
      if (grant.revokedAt !== undefined) return { allowed: false, reason: 'revoked' }
      if (at < grant.issuedAt || at >= grant.expiresAt) return { allowed: false, reason: 'expired' }
      if (grant.useCount >= grant.maxUses) return { allowed: false, reason: 'max_uses' }
      grant.useCount += 1
      grant.revision += 1
      return { allowed: true, reason: 'allowed', grant: this.clone(grant) }
    })
  }

  async revoke(input: { id: string; actorId: string; at?: number }): Promise<JitGrantDecision> {
    return this.serialized(() => {
      const id = text(input.id, 'id')
      const grant = this.grants.get(id)
      if (!grant) return { allowed: false, reason: 'not_found' }
      if (grant.actorId !== input.actorId) return { allowed: false, reason: 'actor_mismatch' }
      if (grant.revokedAt !== undefined) return { allowed: false, reason: 'revoked', grant: this.clone(grant) }
      grant.revokedAt = input.at ?? this.now()
      grant.revision += 1
      return { allowed: true, reason: 'allowed', grant: this.clone(grant) }
    })
  }

  async get(id: string): Promise<JitGrantRecord | undefined> {
    return this.serialized(() => {
      const grant = this.grants.get(text(id, 'id'))
      return grant ? this.clone(grant) : undefined
    })
  }

  private serialized<T>(operation: () => T): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>(resolve => { release = resolve })
    return previous.then(operation).finally(release)
  }

  private clone(grant: JitGrantRecord): JitGrantRecord { return { ...grant } }
}
