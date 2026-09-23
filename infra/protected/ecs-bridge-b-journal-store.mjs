// Durable host-side journal primitives for the separately installed Bridge B
// runner. They fail closed on weak directory permissions, symlinks, stale
// locks, replayed nonce consumption, and non-atomic journal replacement.
import { createHash } from 'node:crypto'
import { open, lstat, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, basename, join, resolve } from 'node:path'
import {
  transitionBridgeBJournal,
  verifyBridgeBJournal,
} from './ecs-bridge-b-transition.mjs'

function assert(value, message) { if (!value) throw new Error(message) }
function nonceHash(value) { return createHash('sha256').update(value).digest('hex') }

async function secureDirectory(filePath) {
  const directory = resolve(dirname(filePath))
  const info = await lstat(directory)
  assert(info.isDirectory() && !info.isSymbolicLink(), 'Bridge B journal directory must be a real directory')
  assert(info.uid === process.getuid?.() && (info.mode & 0o077) === 0, 'Bridge B journal directory must be owned by the runner and mode 0700 or stricter')
  return directory
}

async function secureJournal(filePath) {
  const info = await lstat(filePath)
  assert(info.isFile() && !info.isSymbolicLink(), 'Bridge B journal must be a regular file')
  assert(info.uid === process.getuid?.() && (info.mode & 0o077) === 0, 'Bridge B journal must be owned by the runner and private')
  return JSON.parse(await readFile(filePath, 'utf8'))
}

async function withJournalLock(filePath, action) {
  const directory = await secureDirectory(filePath)
  const lockPath = `${filePath}.lock`
  let lock
  try { lock = await open(lockPath, 'wx', 0o600) } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('Bridge B journal is locked; inspect the active or stale lock before retrying')
    throw error
  }
  try {
    await lock.writeFile(`${process.pid}\n`)
    await lock.sync()
    return await action(directory)
  } finally {
    await lock.close()
    await unlink(lockPath).catch(() => {})
  }
}

async function writeAtomic(filePath, document, directory) {
  const tempPath = join(directory, `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`)
  const file = await open(tempPath, 'wx', 0o400)
  try {
    await file.writeFile(`${JSON.stringify(document)}\n`, 'utf8')
    await file.sync()
  } catch (error) {
    await file.close().catch(() => {})
    await unlink(tempPath).catch(() => {})
    throw error
  }
  await file.close()
  await rename(tempPath, filePath)
  const dir = await open(directory, 'r')
  try { await dir.sync() } finally { await dir.close() }
}

/** Create one journal per attempt; O_EXCL semantics prohibit attempt reuse. */
export async function initializeBridgeBJournal(filePath, signedSnapshot, publicPem, now = new Date()) {
  return withJournalLock(filePath, async directory => {
    verifyBridgeBJournal(signedSnapshot, publicPem, now)
    assert(signedSnapshot.phase === 'captured', 'Bridge B journal must begin in captured phase')
    const journal = await open(filePath, 'wx', 0o400)
    try {
      await journal.writeFile(`${JSON.stringify(signedSnapshot)}\n`, 'utf8')
      await journal.sync()
    } catch (error) {
      await journal.close().catch(() => {})
      await unlink(filePath).catch(() => {})
      throw error
    }
    await journal.close()
    const dir = await open(directory, 'r')
    try { await dir.sync() } finally { await dir.close() }
    return signedSnapshot
  })
}

/** Consume and persist the nonce exactly once, before any runtime mutation. */
export async function consumeBridgeBJournalNonce(filePath, deploymentNonce, privatePem, publicPem, now = new Date()) {
  return withJournalLock(filePath, async directory => {
    const current = await secureJournal(filePath)
    verifyBridgeBJournal(current, publicPem, now)
    assert(current.phase === 'captured', 'Bridge B nonce has already been consumed or attempt has advanced')
    assert(typeof deploymentNonce === 'string' && nonceHash(deploymentNonce) === current.deployment_nonce_sha256, 'Bridge B deployment nonce mismatch')
    const consumed = transitionBridgeBJournal(current, 'nonce_consumed', privatePem, publicPem, now)
    await writeAtomic(filePath, consumed, directory)
    return consumed
  })
}

/** Advance only the latest durable state, preventing stale-journal replay. */
export async function advanceBridgeBJournal(filePath, expectedPhase, nextPhase, privatePem, publicPem, now = new Date()) {
  return withJournalLock(filePath, async directory => {
    const current = await secureJournal(filePath)
    verifyBridgeBJournal(current, publicPem, now)
    assert(current.phase === expectedPhase, `Bridge B expected phase ${expectedPhase}, found ${current.phase}`)
    const updated = transitionBridgeBJournal(current, nextPhase, privatePem, publicPem, now)
    await writeAtomic(filePath, updated, directory)
    return updated
  })
}

