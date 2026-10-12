import { describe, expect, it, vi } from 'vitest'
// @ts-ignore JavaScript runtime module
import { createManagedCredentialLoader, TEMPORARY_CREDENTIAL_ERROR_CODE } from './managed-credential-state.mjs'
// @ts-ignore JavaScript runtime module
import { loadManagedToken } from './managed-token.mjs'

describe('managed credential retry state', () => {
  it('invalidates a successful cache on forced transient failure and retries on normal ensure', async () => {
    const target: Record<string, string> = { MERCHANT_MCP_TOKEN_SOURCE: 'keychain', MERCHANT_MCP_BASE_URL: 'https://merchant.example.test/mcp', MERCHANT_WORKSPACE_ID: 'ws_test' }
    const record = { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_at: '2030-01-01T00:00:00Z' }
    const read = vi.fn().mockResolvedValueOnce(record)
      .mockRejectedValueOnce(new Error('MCP_KEYCHAIN_HELPER_INVALID: helper_timeout operation=read'))
      .mockResolvedValueOnce({ ...record, access_token: 'fixture-new-access', refresh_token: 'fixture-new-refresh' })
    const clear = vi.fn(() => {
      delete target.MERCHANT_MCP_TOKEN
      delete target.MERCHANT_MCP_REFRESH_TOKEN
      delete target.MERCHANT_MCP_TOKEN_EXPIRES_AT
    })
    const loader = createManagedCredentialLoader({ load: () => loadManagedToken(target, 'darwin', () => '', read), clear })

    await expect(loader.ensure()).resolves.toBe(true)
    await expect(loader.ensure()).resolves.toBe(true)
    expect(read).toHaveBeenCalledTimes(1)
    await expect(loader.ensure({ forceReload: true })).resolves.toBe(false)
    expect(read).toHaveBeenCalledTimes(2)
    expect(clear).toHaveBeenCalledTimes(1)
    expect(loader.isPermanentlyUnavailable()).toBe(false)
    expect(target).not.toHaveProperty('MERCHANT_MCP_TOKEN')
    expect(target).not.toHaveProperty('MERCHANT_MCP_REFRESH_TOKEN')
    expect(target).not.toHaveProperty('MERCHANT_MCP_TOKEN_EXPIRES_AT')
    await expect(loader.ensure()).resolves.toBe(true)
    expect(read).toHaveBeenCalledTimes(3)
    expect(target).toMatchObject({ MERCHANT_MCP_TOKEN: 'fixture-new-access', MERCHANT_MCP_REFRESH_TOKEN: 'fixture-new-refresh' })
  })

  it('coalesces concurrent forced and normal reads while refreshing a successful cache', async () => {
    let resolveRead: () => void = () => undefined
    const pending = new Promise<void>(resolve => { resolveRead = resolve })
    const load = vi.fn().mockResolvedValueOnce(undefined).mockReturnValueOnce(pending)
    const clear = vi.fn()
    const loader = createManagedCredentialLoader({ load, clear })
    await expect(loader.ensure()).resolves.toBe(true)

    const first = loader.ensure({ forceReload: true })
    const second = loader.ensure({ forceReload: true })
    const normal = loader.ensure()
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(2)
    resolveRead()
    await expect(Promise.all([first, second, normal])).resolves.toEqual([true, true, true])
    await expect(loader.ensure()).resolves.toBe(true)
    expect(load).toHaveBeenCalledTimes(2)
    expect(clear).not.toHaveBeenCalled()
  })

  it('does not reopen a permanent latch through forced reload even after an earlier success', async () => {
    const load = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('binding mismatch'))
    const clear = vi.fn()
    const loader = createManagedCredentialLoader({ load, clear })
    await expect(loader.ensure()).resolves.toBe(true)
    await expect(loader.ensure({ forceReload: true })).resolves.toBe(false)
    expect(loader.isPermanentlyUnavailable()).toBe(true)
    await expect(Promise.all([loader.ensure({ forceReload: true }), loader.ensure()])).resolves.toEqual([false, false])
    expect(load).toHaveBeenCalledTimes(2)
    expect(clear).toHaveBeenCalledTimes(1)
  })

  it('latches native access denial without retrying or retaining stale credentials', async () => {
    const target = { MERCHANT_MCP_TOKEN_SOURCE: 'keychain', MERCHANT_MCP_BASE_URL: 'https://merchant.example.test/mcp', MERCHANT_WORKSPACE_ID: 'ws_test', MERCHANT_MCP_TOKEN: 'stale', MERCHANT_MCP_REFRESH_TOKEN: 'stale-r', MERCHANT_MCP_TOKEN_EXPIRES_AT: '2030-01-01T00:00:00Z' }
    const read = vi.fn().mockRejectedValue(new Error('MCP_KEYCHAIN_HELPER_INVALID: keychain_osstatus=-25293 operation=read'))
    const clear = vi.fn()
    const loader = createManagedCredentialLoader({ load: () => loadManagedToken(target, 'darwin', () => '', read), clear })

    await expect(Promise.all([loader.ensure(), loader.ensure()])).resolves.toEqual([false, false])
    await expect(loader.ensure()).resolves.toBe(false)
    expect(loader.isPermanentlyUnavailable()).toBe(true)
    expect(read).toHaveBeenCalledTimes(1)
    expect(clear).toHaveBeenCalledTimes(1)
    expect(target).not.toHaveProperty('MERCHANT_MCP_TOKEN')
    expect(target).not.toHaveProperty('MERCHANT_MCP_REFRESH_TOKEN')
    expect(target).not.toHaveProperty('MERCHANT_MCP_TOKEN_EXPIRES_AT')
  })

  it('retries repeated native read timeouts, coalesces recovery, and reuses the successful load', async () => {
    const target = { MERCHANT_MCP_TOKEN_SOURCE: 'keychain', MERCHANT_MCP_BASE_URL: 'https://merchant.example.test/mcp', MERCHANT_WORKSPACE_ID: 'ws_test' }
    let resolveRead: (record: { access_token: string; refresh_token: string }) => void = () => undefined
    const pending = new Promise<{ access_token: string; refresh_token: string }>(resolve => { resolveRead = resolve })
    const timeout = new Error('MCP_KEYCHAIN_HELPER_INVALID: helper_timeout operation=read')
    const read = vi.fn().mockRejectedValueOnce(timeout).mockRejectedValueOnce(timeout).mockReturnValueOnce(pending)
    const clear = vi.fn()
    const loader = createManagedCredentialLoader({ load: () => loadManagedToken(target, 'darwin', () => '', read), clear })

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(loader.ensure()).resolves.toBe(false)
      expect(loader.isPermanentlyUnavailable()).toBe(false)
      expect(target).not.toHaveProperty('MERCHANT_MCP_TOKEN')
    }
    const first = loader.ensure()
    const second = loader.ensure()
    await Promise.resolve()
    expect(read).toHaveBeenCalledTimes(3)
    resolveRead({ access_token: 'fixture-access', refresh_token: 'fixture-refresh' })
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    await expect(loader.ensure()).resolves.toBe(true)
    expect(read).toHaveBeenCalledTimes(3)
    expect(clear).toHaveBeenCalledTimes(2)
    expect(target).toMatchObject({ MERCHANT_MCP_TOKEN: 'fixture-access', MERCHANT_MCP_REFRESH_TOKEN: 'fixture-refresh' })
    expect(loader.isPermanentlyUnavailable()).toBe(false)
  })

  it('fails a transient broker outage closed and retries on the next call', async () => {
    const transient = Object.assign(new Error('sanitized'), { code: TEMPORARY_CREDENTIAL_ERROR_CODE })
    const load = vi.fn().mockRejectedValueOnce(transient).mockResolvedValueOnce(undefined)
    const clear = vi.fn()
    const loader = createManagedCredentialLoader({ load, clear })

    await expect(loader.ensure()).resolves.toBe(false)
    expect(loader.isPermanentlyUnavailable()).toBe(false)
    await expect(loader.ensure()).resolves.toBe(true)
    expect(load).toHaveBeenCalledTimes(2)
    expect(clear).toHaveBeenCalledTimes(1)
  })

  it('coalesces a concurrent transient outage into one read and one clear', async () => {
    const transient = Object.assign(new Error('sanitized'), { code: TEMPORARY_CREDENTIAL_ERROR_CODE })
    let rejectRead: (error: Error) => void = () => undefined
    const pending = new Promise((_resolve, reject) => { rejectRead = reject })
    const load = vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce(undefined)
    const clear = vi.fn()
    const loader = createManagedCredentialLoader({ load, clear })

    const first = loader.ensure()
    const second = loader.ensure()
    rejectRead(transient)
    await expect(Promise.all([first, second])).resolves.toEqual([false, false])
    expect(load).toHaveBeenCalledTimes(1)
    expect(clear).toHaveBeenCalledTimes(1)
    expect(loader.isPermanentlyUnavailable()).toBe(false)

    await expect(loader.ensure()).resolves.toBe(true)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent reads and latches structural failures', async () => {
    const load = vi.fn().mockRejectedValue(new Error('binding mismatch'))
    const clear = vi.fn()
    const loader = createManagedCredentialLoader({ load, clear })

    await expect(Promise.all([loader.ensure(), loader.ensure()])).resolves.toEqual([false, false])
    await expect(loader.ensure()).resolves.toBe(false)
    expect(loader.isPermanentlyUnavailable()).toBe(true)
    expect(load).toHaveBeenCalledTimes(1)
    expect(clear).toHaveBeenCalledTimes(1)
  })
})
