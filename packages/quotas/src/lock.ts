import { randomUUID } from 'node:crypto'

export interface LeaseLockStore {
  acquire(key: string, token: string, ttlMs: number): Promise<boolean>
  release(key: string, token: string): Promise<void>
}

export class DistributedLockBusyError extends Error {
  readonly code = 'PUBLISH_LOCK_BUSY'
  readonly retryable = true
  readonly unknown = false
  constructor(readonly key: string) {
    super(`publish lock is busy; retry later (${key})`)
    this.name = 'DistributedLockBusyError'
  }
}

export class KeyedLeaseLock {
  constructor(private readonly store: LeaseLockStore, private readonly options: { ttlMs?: number; waitMs?: number; pollMs?: number } = {}) {}

  async run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const token = randomUUID()
    const ttlMs = Math.max(1_000, this.options.ttlMs ?? 60_000)
    const deadline = Date.now() + Math.max(0, this.options.waitMs ?? 30_000)
    let acquired = false
    while (!acquired) {
      acquired = await this.store.acquire(key, token, ttlMs)
      if (acquired) break
      if (Date.now() >= deadline) throw new DistributedLockBusyError(key)
      await new Promise(resolve => setTimeout(resolve, Math.max(10, this.options.pollMs ?? 100)))
    }
    try { return await action() } finally { await this.store.release(key, token) }
  }
}

export class InMemoryLeaseLockStore implements LeaseLockStore {
  private readonly leases = new Map<string, { token: string; expiresAt: number }>()
  constructor(private readonly now: () => number = () => Date.now()) {}

  async acquire(key: string, token: string, ttlMs: number): Promise<boolean> {
    const current = this.leases.get(key)
    const now = this.now()
    if (current && current.expiresAt > now) return current.token === token
    this.leases.set(key, { token, expiresAt: now + ttlMs })
    return true
  }

  async release(key: string, token: string): Promise<void> {
    if (this.leases.get(key)?.token === token) this.leases.delete(key)
  }
}
