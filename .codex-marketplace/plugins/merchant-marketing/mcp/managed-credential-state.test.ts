import { describe, expect, it, vi } from 'vitest'
// @ts-ignore JavaScript runtime module
import { createManagedCredentialLoader, TEMPORARY_CREDENTIAL_ERROR_CODE } from './managed-credential-state.mjs'

describe('managed credential retry state', () => {
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
