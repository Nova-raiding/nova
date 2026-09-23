import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rotateNewApiSession } from '../scripts/new-api-session-refresh.js'

describe('one-time New API session refresh', () => {
  it('uses an exact HTTPS Origin and atomically persists a rotated session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'new-api-session-'))
    const sessionFile = join(directory, 'session.json')
    try {
      const fetcher = vi.fn<typeof fetch>(async (input, init) => {
        expect(String(input)).toBe('https://relay.example.test/api/user/auth/refresh')
        expect(init?.headers).toMatchObject({ cookie: 'new_api_refresh=old', origin: 'https://relay.example.test' })
        return new Response(JSON.stringify({ data: { access_token: 'new-access', user: { id: 42 } } }), {
          headers: { 'set-cookie': 'new_api_refresh=new; Path=/api/user/auth; HttpOnly; Secure; SameSite=Strict' },
        })
      })
      await expect(rotateNewApiSession({ baseUrl: 'https://relay.example.test/v1', sessionFile, expectedUserId: '42', initialRefreshCookie: 'new_api_refresh=old', fetcher })).resolves.toEqual({ state: 'rotated', userId: '42' })
      const persisted = JSON.parse(await readFile(sessionFile, 'utf8')) as Record<string, unknown>
      expect(persisted).toMatchObject({ userToken: 'new-access', refreshCookie: 'new_api_refresh=new', userId: '42' })
      expect((await stat(sessionFile)).mode & 0o777).toBe(0o600)
      expect(fetcher).toHaveBeenCalledTimes(1)
      await expect(rotateNewApiSession({ baseUrl: 'https://relay.example.test', sessionFile, expectedUserId: '42', initialRefreshCookie: 'new_api_refresh=old', fetcher })).rejects.toMatchObject({ code: 'EEXIST' })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('retains its audit lock and never marks success without a secure rotated cookie', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'new-api-session-'))
    const sessionFile = join(directory, 'session.json')
    try {
      const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: { access_token: 'new-access', user: { id: 42 } } })))
      await expect(rotateNewApiSession({ baseUrl: 'https://relay.example.test', sessionFile, expectedUserId: '42', initialRefreshCookie: 'new_api_refresh=old', fetcher })).rejects.toThrow('NEW_API_REFRESH_ROTATION_MISSING')
      await expect(stat(`${sessionFile}.lock`)).resolves.toBeDefined()
      await expect(stat(sessionFile)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('rejects insecure session directories before sending a request', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'new-api-session-'))
    const sessionFile = join(directory, 'session.json')
    const fetcher = vi.fn<typeof fetch>()
    try {
      await import('node:fs/promises').then(fs => fs.chmod(directory, 0o755))
      await expect(rotateNewApiSession({ baseUrl: 'https://relay.example.test', sessionFile, expectedUserId: '42', initialRefreshCookie: 'new_api_refresh=old', fetcher })).rejects.toThrow('NEW_API_SESSION_DIRECTORY_UNSAFE')
      expect(fetcher).not.toHaveBeenCalled()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('rejects an unexpected account without persisting its session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'new-api-session-'))
    const sessionFile = join(directory, 'session.json')
    try {
      const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: { access_token: 'other-access', user: { id: 99 } } }), {
        headers: { 'set-cookie': 'new_api_refresh=other; Path=/api/user/auth; HttpOnly; Secure' },
      }))
      await expect(rotateNewApiSession({ baseUrl: 'https://relay.example.test', sessionFile, expectedUserId: '42', initialRefreshCookie: 'new_api_refresh=old', fetcher })).rejects.toThrow('NEW_API_REFRESH_IDENTITY_INVALID')
      await expect(stat(sessionFile)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(`${sessionFile}.lock`)).resolves.toBeDefined()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
