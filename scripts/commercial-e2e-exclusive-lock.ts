import { randomUUID } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname } from 'node:path'

type LockRecord = { pid: number; host: string; token: string; startedAt: string }
const staleMalformedLockMs = 10 * 60_000

function lockRecord(path: string): LockRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockRecord>
    if (Number.isSafeInteger(value.pid) && value.pid! > 0 && typeof value.host === 'string'
      && typeof value.token === 'string' && /^[0-9a-f-]{36}$/u.test(value.token)
      && typeof value.startedAt === 'string') return value as LockRecord
  } catch { /* incomplete or malformed lock is handled conservatively below */ }
  return undefined
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}

function sameFile(path: string, dev: number, ino: number): boolean {
  try { const stat = lstatSync(path); return stat.isFile() && !stat.isSymbolicLink() && stat.dev === dev && stat.ino === ino }
  catch { return false }
}

function reclaimDeadLock(path: string): boolean {
  let before
  try { before = lstatSync(path) } catch { return true }
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('OPS_E2E_COMMERCIAL_LOCK_INVALID')
  const record = lockRecord(path)
  if (record) {
    // A lock from another host is never reclaimed: PID namespaces may differ.
    if (record.host !== hostname() || processIsAlive(record.pid)) return false
  } else if (Date.now() - before.mtimeMs < staleMalformedLockMs) return false

  // rename is the atomic claim on stale cleanup: only one contender can move
  // the old path. Verify the moved inode before deleting it.
  const quarantine = `${path}.stale-${randomUUID()}`
  try { renameSync(path, quarantine) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; return false }
  try {
    const moved = lstatSync(quarantine)
    if (moved.dev !== before.dev || moved.ino !== before.ino) {
      // The path changed between inspection and rename. Restore only when the
      // canonical lock name is vacant; otherwise leave the other owner's lock.
      try { renameSync(quarantine, path) } catch { /* preserve evidence in quarantine */ }
      return false
    }
    unlinkSync(quarantine)
    return true
  } catch { return false }
}

/** Acquire a process-scoped exclusive lock, reclaiming only provably dead local owners. */
export function acquireCommercialE2eLock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = randomUUID()
    let fd: number
    try { fd = openSync(path, 'wx', 0o600) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (!reclaimDeadLock(path)) throw new Error('OPS_E2E_COMMERCIAL_SALES_ALREADY_RUNNING')
      continue
    }
    const identity = fstatSync(fd)
    try {
      const record: LockRecord = { pid: process.pid, host: hostname(), token, startedAt: new Date().toISOString() }
      writeFileSync(fd, JSON.stringify(record))
    } catch (error) {
      closeSync(fd)
      if (sameFile(path, identity.dev, identity.ino)) unlinkSync(path)
      throw error
    }
    closeSync(fd)
    let released = false
    return () => {
      if (released) return
      released = true
      if (!sameFile(path, identity.dev, identity.ino)) return
      const current = lockRecord(path)
      if (current?.token !== token || current.pid !== process.pid || current.host !== hostname()) return
      unlinkSync(path)
    }
  }
  throw new Error('OPS_E2E_COMMERCIAL_LOCK_RETRY_EXHAUSTED')
}
