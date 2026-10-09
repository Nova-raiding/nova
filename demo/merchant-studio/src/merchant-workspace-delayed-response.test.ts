import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activateMerchantWorkspace, clearMerchantWorkspaceScope, configureMerchantWorkspaceScope, requestApi } from './api.js'

function envelope(workspaceId: string) {
  return JSON.stringify({ request_id: 'delayed-body-request', trace_id: 'delayed-body-trace', workspace_id: workspaceId,
    data: { items: ['stale'] }, warnings: [], next_actions: [], error: null })
}

describe('merchant workspace response body race', () => {
  beforeEach(() => {
    clearMerchantWorkspaceScope()
    vi.stubGlobal('window', Object.assign(globalThis, { setTimeout, clearTimeout, dispatchEvent: vi.fn() }))
  })

  afterEach(() => {
    clearMerchantWorkspaceScope()
    vi.unstubAllGlobals()
  })

  it('drops a scoped response when workspace changes while its body is still streaming', async () => {
    configureMerchantWorkspaceScope(['ws_alpha', 'ws_beta'], 'ws_alpha')
    let releaseBody!: () => void
    let markBodyReadStarted!: () => void
    const bodyReadStarted = new Promise<void>(resolve => { markBodyReadStarted = resolve })
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        markBodyReadStarted()
        return new Promise<void>(resolve => {
          releaseBody = () => {
            controller.enqueue(new TextEncoder().encode(envelope('ws_alpha')))
            controller.close()
            resolve()
          }
        })
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'content-type': 'application/json' } })))

    const pending = requestApi('/api', '/v1/products')
    await bodyReadStarted
    activateMerchantWorkspace('ws_beta')
    releaseBody()

    await expect(pending).rejects.toMatchObject({ code: 'API_WORKSPACE_CONTEXT_CHANGED' })
  })
})
