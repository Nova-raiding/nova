import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

type Fetcher = typeof fetch

export interface RefreshOptions {
  baseUrl: string
  sessionFile: string
  initialRefreshCookie?: string
  expectedUserId: string
  fetcher?: Fetcher
}

function originFor(baseUrl: string): string {
  const url = new URL(baseUrl)
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('NEW_API_SESSION_ORIGIN_INVALID')
  return url.origin
}

function refreshCookie(value: string | undefined): string {
  const match = /^new_api_refresh=([^;\s]+)$/u.exec(value?.trim() ?? '')
  if (!match) throw new Error('NEW_API_REFRESH_COOKIE_INVALID')
  return match[0]
}

async function readSession(path: string): Promise<{ refreshCookie: string } | undefined> {
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
      throw new Error('NEW_API_SESSION_FILE_UNSAFE')
    }
    const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    return { refreshCookie: refreshCookie(typeof value.refreshCookie === 'string' ? value.refreshCookie : undefined) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function secureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
    throw new Error('NEW_API_SESSION_DIRECTORY_UNSAFE')
  }
}

function rotatedCookie(response: Response): string {
  const candidates = response.headers.getSetCookie().filter(value => value.startsWith('new_api_refresh='))
  if (candidates.length !== 1) throw new Error('NEW_API_REFRESH_ROTATION_MISSING')
  const value = candidates[0]!
  if (!/;\s*HttpOnly(?:;|$)/iu.test(value) || !/;\s*Secure(?:;|$)/iu.test(value) || !/;\s*Path=\/api\/user\/auth(?:;|$)/iu.test(value)) {
    throw new Error('NEW_API_REFRESH_COOKIE_FLAGS_INVALID')
  }
  return refreshCookie(value.split(';', 1)[0])
}

/** One network refresh, then same-directory fsync + atomic rename. Never logs credentials. */
export async function rotateNewApiSession(options: RefreshOptions): Promise<{ state: 'rotated'; userId: string }> {
  const origin = originFor(options.baseUrl)
  const path = resolve(options.sessionFile)
  const directory = dirname(path)
  const expectedUserId = options.expectedUserId.trim()
  if (!expectedUserId || path === directory) throw new Error('NEW_API_SESSION_ARGUMENTS_INVALID')
  await secureDirectory(directory)
  const lockPath = `${path}.lock`
  const lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try {
    await lock.writeFile(`${process.pid}\n`)
    await lock.sync()
    const prior = await readSession(path)
    const cookie = prior?.refreshCookie ?? refreshCookie(options.initialRefreshCookie)
    const response = await (options.fetcher ?? fetch)(`${origin}/api/user/auth/refresh`, {
      method: 'POST',
      headers: { accept: 'application/json', cookie, origin },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`NEW_API_REFRESH_HTTP_${response.status}`)
    const length = Number(response.headers.get('content-length') ?? '')
    if (Number.isFinite(length) && length > 64 * 1024) throw new Error('NEW_API_REFRESH_RESPONSE_TOO_LARGE')
    const body = await response.text()
    if (body.length > 64 * 1024) throw new Error('NEW_API_REFRESH_RESPONSE_TOO_LARGE')
    const payload = JSON.parse(body) as { data?: { access_token?: unknown; user?: { id?: unknown } } }
    const accessToken = payload.data?.access_token
    const userId = payload.data?.user?.id
    if (typeof accessToken !== 'string' || !accessToken.trim() || String(userId ?? '') !== expectedUserId) {
      throw new Error('NEW_API_REFRESH_IDENTITY_INVALID')
    }
    const nextCookie = rotatedCookie(response)
    const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`
    const temporary = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    try {
      await temporary.writeFile(`${JSON.stringify({ userToken: accessToken, refreshCookie: nextCookie, userId: expectedUserId, rotatedAt: new Date().toISOString() })}\n`)
      await temporary.sync()
    } finally { await temporary.close() }
    await rename(temporaryPath, path)
    const dir = await open(directory, constants.O_RDONLY)
    try { await dir.sync() } finally { await dir.close() }
    return { state: 'rotated', userId: expectedUserId }
  } finally {
    await lock.close()
    // Keep the lock, even on success. This is intentionally one-shot: replaying
    // an old cookie after an ambiguous response can revoke the upstream session.
    // Any owner-only temporary artifact also remains for manual recovery.
  }
}

async function main(): Promise<void> {
  const expectedOrigin = process.argv.find(value => value.startsWith('--confirm-origin='))?.slice('--confirm-origin='.length)
  const baseUrl = process.env.MODEL_RELAY_LOG_BASE_URL?.trim() ?? ''
  const sessionFile = process.env.MODEL_RELAY_LOG_SESSION_FILE?.trim() ?? ''
  const expectedUserId = process.env.MODEL_RELAY_LOG_USER_ID?.trim() ?? ''
  if (process.argv.includes('--execute') && expectedOrigin === originFor(baseUrl) && sessionFile && expectedUserId) {
    const result = await rotateNewApiSession({ baseUrl, sessionFile, expectedUserId, initialRefreshCookie: process.env.MODEL_RELAY_LOG_REFRESH_COOKIE })
    console.log(JSON.stringify(result))
    return
  }
  throw new Error('NEW_API_REFRESH_REQUIRES_EXECUTE_AND_EXACT_ORIGIN_CONFIRMATION')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(JSON.stringify({ state: 'blocked', code: error instanceof Error ? error.message : 'NEW_API_REFRESH_FAILED' }))
    process.exitCode = 1
  })
}
