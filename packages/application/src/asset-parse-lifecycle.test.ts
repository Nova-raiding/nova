import { afterEach, describe, expect, it, vi } from 'vitest'
import { runWithAssetParseDeadline } from './asset-parse-lifecycle.js'

afterEach(() => vi.useRealTimers())

describe('asset parse lifecycle', () => {
  it('combines caller cancellation and a hard parsing deadline', async () => {
    vi.useFakeTimers()
    const timedOut = runWithAssetParseDeadline(async () => await new Promise(() => undefined), 50)
    const timeoutAssertion = expect(timedOut).rejects.toMatchObject({ name: 'TimeoutError' })
    await vi.advanceTimersByTimeAsync(50)
    await timeoutAssertion

    const caller = new AbortController()
    const cancelled = runWithAssetParseDeadline(async signal => await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })), 5_000, caller.signal)
    caller.abort(Object.assign(new Error('lost'), { code: 'ASSET_PARSE_LEASE_LOST' }))
    await expect(cancelled).rejects.toMatchObject({ code: 'ASSET_PARSE_LEASE_LOST' })
  })
})
