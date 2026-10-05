import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-ignore JavaScript runtime module
import { loadManagedToken, withManagedRefreshLock } from './managed-token.mjs'

const configured = () => ({
  MERCHANT_MCP_TOKEN_SOURCE: 'launchd',
  MERCHANT_MCP_BASE_URL: 'https://merchant.example.test/mcp',
  MERCHANT_WORKSPACE_ID: 'ws_test',
  MERCHANT_MCP_TOKEN: 'stale-token',
  MERCHANT_MCP_REFRESH_TOKEN: 'stale-refresh-token',
  MERCHANT_MCP_TOKEN_EXPIRES_AT: '2026-09-29T00:00:00.000Z',
})
const read = (name: string) => ({ ...configured(), MERCHANT_MCP_TOKEN: 'fresh-token', MERCHANT_MCP_REFRESH_TOKEN: 'fresh-refresh-token' } as Record<string, string>)[name] || ''

describe('managed credential startup', () => {
  it.each(['sync', 'async'])('clears stale credentials and sanitizes a %s Keychain reader failure', async mode => {
    const env = { ...configured(), MERCHANT_MCP_TOKEN_SOURCE: 'keychain' }
    const reader = () => {
      const failure = new Error('sensitive-reader-error: stale-secret -25308')
      if (mode === 'sync') throw failure
      return Promise.reject(failure)
    }
    await expect(Promise.resolve().then(() => loadManagedToken(env, 'darwin', read, reader)))
      .rejects.toThrow(/^MCP_CREDENTIAL_SOURCE_INVALID: managed credentials unavailable or scope changed; reconnect with matching configuration\.$/u)
    expect(env).not.toHaveProperty('MERCHANT_MCP_TOKEN')
    expect(env).not.toHaveProperty('MERCHANT_MCP_REFRESH_TOKEN')
    expect(env).not.toHaveProperty('MERCHANT_MCP_TOKEN_EXPIRES_AT')
  })

  it.each([
    ['sync direct', 'KEYCHAIN_BROKER_UNAVAILABLE', 'sync'],
    ['async direct', 'KEYCHAIN_BROKER_TIMEOUT', 'async'],
    ['sync wrapped', 'MCP_KEYCHAIN_HELPER_INVALID: broker_unavailable', 'sync'],
    ['async wrapped', 'MCP_KEYCHAIN_HELPER_INVALID: broker_timeout', 'async'],
  ])('classifies a %s broker outage as temporary without exposing broker diagnostics', async (_label, message, mode) => {
    const env = { ...configured(), MERCHANT_MCP_TOKEN_SOURCE: 'keychain' }
    const reader = () => {
      const failure = new Error(message)
      if (mode === 'sync') throw failure
      return Promise.reject(failure)
    }
    const promise = Promise.resolve().then(() => loadManagedToken(env, 'darwin', read, reader))
    await expect(promise).rejects.toMatchObject({ code: 'MCP_CREDENTIAL_SOURCE_TEMPORARILY_UNAVAILABLE' })
    await expect(promise).rejects.not.toThrow(/KEYCHAIN_BROKER/u)
    expect(env).not.toHaveProperty('MERCHANT_MCP_TOKEN')
    expect(env).not.toHaveProperty('MERCHANT_MCP_REFRESH_TOKEN')
    expect(env).not.toHaveProperty('MERCHANT_MCP_TOKEN_EXPIRES_AT')
  })

  it('keeps the production authenticated IPC gate structural and non-retryable', async () => {
    const env = { ...configured(), MERCHANT_MCP_TOKEN_SOURCE: 'keychain' }
    const promise = Promise.resolve().then(() => loadManagedToken(env, 'darwin', read, () => {
      throw new Error('MCP_KEYCHAIN_HELPER_INVALID: authenticated_keychain_ipc_unavailable')
    }))
    await expect(promise).rejects.not.toMatchObject({ code: 'MCP_CREDENTIAL_SOURCE_TEMPORARILY_UNAVAILABLE' })
    await expect(promise).rejects.toThrow('MCP_CREDENTIAL_SOURCE_INVALID')
  })

  it('preserves explicit credentials by default without consulting launchd', () => {
    const env = { ...configured(), MERCHANT_MCP_TOKEN_SOURCE: '' }
    loadManagedToken(env, 'darwin', () => { throw new Error('must not read') })
    expect(env.MERCHANT_MCP_TOKEN).toBe('stale-token')
  })
  it('uses the fresh token only for the pinned endpoint and workspace', () => {
    const env = configured()
    loadManagedToken(env, 'darwin', read)
    expect(env.MERCHANT_MCP_TOKEN).toBe('fresh-token')
    expect(env.MERCHANT_MCP_REFRESH_TOKEN).toBe('fresh-refresh-token')
  })
  it.each(['MERCHANT_MCP_BASE_URL', 'MERCHANT_WORKSPACE_ID', 'MERCHANT_MCP_TOKEN', 'MERCHANT_MCP_REFRESH_TOKEN'])('fails closed when %s differs or is missing', name => {
    const env = configured()
    expect(() => loadManagedToken(env, 'darwin', (key: string) => key === name ? '' : read(key))).toThrow('MCP_CREDENTIAL_SOURCE_INVALID')
    expect(env.MERCHANT_MCP_TOKEN).toBeUndefined()
    expect(env.MERCHANT_MCP_REFRESH_TOKEN).toBeUndefined()
    expect(env.MERCHANT_MCP_TOKEN_EXPIRES_AT).toBeUndefined()
  })
  it.each(['MERCHANT_MCP_BASE_URL', 'MERCHANT_WORKSPACE_ID'])('rejects a different nonempty %s', name => {
    const env = configured()
    expect(() => loadManagedToken(env, 'darwin', (key: string) => key === name ? 'different' : read(key))).toThrow()
    expect(env.MERCHANT_MCP_TOKEN).toBeUndefined()
    expect(env.MERCHANT_MCP_REFRESH_TOKEN).toBeUndefined()
  })
  it.each(['linux', 'win32'])('rejects managed credentials on %s', platform => {
    expect(() => loadManagedToken(configured(), platform, read)).toThrow()
  })
  it('rejects unreadable credentials and placeholders', () => {
    expect(() => loadManagedToken(configured(), 'darwin', () => { throw new Error('sensitive-reader-error') })).toThrow('MCP_CREDENTIAL_SOURCE_INVALID')
    expect(() => loadManagedToken(configured(), 'darwin', (key: string) => key === 'MERCHANT_MCP_TOKEN' ? '${TOKEN}' : read(key))).toThrow()
    const env = configured()
    expect(() => loadManagedToken(env, 'darwin', (key: string) => key === 'MERCHANT_MCP_REFRESH_TOKEN' ? '${REFRESH_TOKEN}' : read(key))).toThrow('MCP_CREDENTIAL_SOURCE_INVALID')
    expect(env).not.toHaveProperty('MERCHANT_MCP_TOKEN')
    expect(env).not.toHaveProperty('MERCHANT_MCP_REFRESH_TOKEN')
  })
  it.each(['MERCHANT_ACTOR_ID', 'MERCHANT_MCP_ROLE'])('rejects unverifiable principal pin %s', name => {
    expect(() => loadManagedToken({ ...configured(), [name]: 'explicit' }, 'darwin', read)).toThrow()
  })
  it('rejects an unknown source', () => {
    expect(() => loadManagedToken({ ...configured(), MERCHANT_MCP_TOKEN_SOURCE: 'unknown' }, 'darwin', read)).toThrow()
  })
})


describe('shared managed refresh lock', () => {
  it('times out a waiting process without running its refresh operation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'refresh-lock-busy-'))
    const scope = { root, origin: 'https://merchant.example.test', workspaceId: 'ws_test', source: 'keychain', timeoutMs: 50 }
    let release!: () => void
    let acquired!: () => void
    const ready = new Promise<void>(resolve => { acquired = resolve })
    const held = withManagedRefreshLock(scope, async () => { acquired(); await new Promise<void>(resolve => { release = resolve }) })
    let called = false
    try {
      await ready
      await expect(withManagedRefreshLock(scope, async () => { called = true })).rejects.toThrow('MCP_REFRESH_LOCK_BUSY')
      expect(called).toBe(false)
    } finally { release(); await held; await rm(root, { recursive: true, force: true }) }
  })

  it('retains dispatch evidence after a persistence failure but permits a newly bound refresh credential', async () => {
    const root = await mkdtemp(join(tmpdir(), 'refresh-lock-dispatched-'))
    const scope = { root, origin: 'https://merchant.example.test', workspaceId: 'ws_test', source: 'keychain' }
    try {
      await expect(withManagedRefreshLock(scope, async (mark: (token: string) => Promise<void>) => {
        await mark('old-single-use-refresh')
        throw new Error('credential persistence failed')
      })).rejects.toThrow('credential persistence failed')
      await expect(withManagedRefreshLock(scope, (mark: (token: string) => Promise<void>) => mark('old-single-use-refresh'))).rejects.toMatchObject({ code: 'EEXIST' })
      await expect(withManagedRefreshLock(scope, (mark: (token: string) => Promise<void>) => mark('new-binding-refresh'))).resolves.toBeUndefined()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
