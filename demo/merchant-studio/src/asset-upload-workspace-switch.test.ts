import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activateMerchantWorkspace,
  clearMerchantWorkspaceScope,
  configureMerchantWorkspaceScope,
  uploadAsset,
} from './api.js'

describe('asset upload workspace ownership', () => {
  beforeEach(() => {
    clearMerchantWorkspaceScope()
    vi.stubGlobal('window', Object.assign(globalThis, { setTimeout, clearTimeout, dispatchEvent: vi.fn() }))
  })

  afterEach(() => {
    clearMerchantWorkspaceScope()
    vi.unstubAllGlobals()
  })

  it('does not send a delayed file read under the workspace selected afterward', async () => {
    configureMerchantWorkspaceScope(['ws_alpha', 'ws_beta'], 'ws_alpha')
    let resolveBytes!: (value: ArrayBuffer) => void
    const file = {
      name: 'products.csv',
      type: 'text/csv',
      arrayBuffer: vi.fn(() => new Promise<ArrayBuffer>((resolve) => { resolveBytes = resolve })),
    } as unknown as File
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)

    const pending = uploadAsset('/api', file)
    expect(file.arrayBuffer).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()

    activateMerchantWorkspace('ws_beta')
    resolveBytes(new ArrayBuffer(1))

    await expect(pending).rejects.toMatchObject({ code: 'API_WORKSPACE_CONTEXT_CHANGED' })
    expect(fetch).not.toHaveBeenCalled()
  })
})
