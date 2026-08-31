import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryAssetParseRepository } from '../../../packages/persistence/src/asset-parse-repository.js'
import { AssetParseExecutionError, executeAssetParse } from './asset-parse-runtime.js'

afterEach(() => vi.useRealTimers())

describe('executeAssetParse', () => {
  it('commits one non-empty result and replays it without invoking the parser', async () => {
    const repository = new MemoryAssetParseRepository(); const parse = vi.fn(async () => ({ title: '商品' }))
    await expect(executeAssetParse({ repository, workspaceId: 'ws_a', assetId: 'asset_a', timeoutMs: 1_000, parse })).resolves.toMatchObject({ replayed: false, record: { state: 'succeeded', facts: { title: '商品' } } })
    await expect(executeAssetParse({ repository, workspaceId: 'ws_a', assetId: 'asset_a', timeoutMs: 1_000, parse })).resolves.toMatchObject({ replayed: true, record: { state: 'succeeded' } })
    expect(parse).toHaveBeenCalledTimes(1)
  })

  it('forces a deadline even when the parser ignores its signal and records a retryable failure', async () => {
    vi.useFakeTimers()
    const repository = new MemoryAssetParseRepository()
    const expire = vi.spyOn(repository, 'expire')
    const fail = vi.spyOn(repository, 'fail')
    const classifyFailure = vi.fn(() => ({ code: 'SHOULD_NOT_OVERRIDE_TIMEOUT', message: 'wrong', retryable: false }))
    const execution = executeAssetParse({ repository, workspaceId: 'ws_a', assetId: 'asset_timeout', timeoutMs: 50, parse: async () => await new Promise(() => undefined), classifyFailure })
    const assertion = expect(execution).rejects.toMatchObject({ code: 'ASSET_PARSE_TIMEOUT', record: { state: 'failed', retryable: true } })
    await vi.advanceTimersByTimeAsync(50)
    await assertion
    expect(expire).toHaveBeenCalledOnce()
    expect(expire).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws_a', assetId: 'asset_timeout', leaseToken: expect.any(String), now: expect.any(String) }))
    expect(fail).not.toHaveBeenCalled()
    expect(classifyFailure).not.toHaveBeenCalled()
    await expect(repository.get({ workspaceId: 'ws_a', assetId: 'asset_timeout' })).resolves.toMatchObject({ state: 'failed', errorCode: 'ASSET_PARSE_TIMEOUT' })
  })

  it('records classified non-retryable corruption without exposing the original error object', async () => {
    const repository = new MemoryAssetParseRepository()
    const expire = vi.spyOn(repository, 'expire')
    const fail = vi.spyOn(repository, 'fail')
    const execution = executeAssetParse({
      repository, workspaceId: 'ws_a', assetId: 'asset_corrupt', timeoutMs: 1_000,
      parse: async () => { throw new Error('raw parser detail') },
      classifyFailure: () => ({ code: 'ASSET_DOCUMENT_CORRUPT', message: 'document is corrupt', retryable: false }),
    })
    await expect(execution).rejects.toEqual(expect.objectContaining<Partial<AssetParseExecutionError>>({ code: 'ASSET_DOCUMENT_CORRUPT', message: 'document is corrupt', record: expect.objectContaining({ retryable: false }) }))
    expect(fail).toHaveBeenCalledOnce()
    expect(expire).not.toHaveBeenCalled()
    await expect(repository.claim({ workspaceId: 'ws_a', assetId: 'asset_corrupt', leaseMs: 1_000 })).rejects.toMatchObject({ code: 'ASSET_PARSE_ATTEMPTS_EXHAUSTED' })
  })

  it('turns an empty parser response into a durable failure', async () => {
    const repository = new MemoryAssetParseRepository()
    await expect(executeAssetParse({ repository, workspaceId: 'ws_a', assetId: 'asset_empty', timeoutMs: 1_000, parse: async () => ({}) })).rejects.toMatchObject({ code: 'ASSET_PARSE_EMPTY', record: { state: 'failed' } })
  })
})
