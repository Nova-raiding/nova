import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activateMerchantWorkspace,
  clearMerchantWorkspaceScope,
  configureMerchantWorkspaceScope,
  getMerchantWorkspaceScope,
  submitMerchantSupportRequest,
} from './api.js'

const envelope = (workspaceId: string, data: unknown) => new Response(JSON.stringify({
  request_id: 'support-workspace-switch',
  trace_id: 'support-workspace-switch',
  workspace_id: workspaceId,
  data,
  warnings: [],
  next_actions: [],
  error: null,
}), { headers: { 'content-type': 'application/json' } })

describe('merchant support submission workspace ownership', () => {
  beforeEach(() => {
    clearMerchantWorkspaceScope()
    vi.stubGlobal('window', Object.assign(globalThis, { setTimeout, clearTimeout, dispatchEvent: vi.fn() }))
  })

  afterEach(() => {
    clearMerchantWorkspaceScope()
    vi.unstubAllGlobals()
  })

  it('submits in A and rejects its late receipt after switching to B without retrying', async () => {
    configureMerchantWorkspaceScope(['ws_alpha', 'ws_beta'], 'ws_alpha')
    let resolveAlpha!: (response: Response) => void
    const fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      new Promise<Response>(resolve => { resolveAlpha = resolve }),
    )
    vi.stubGlobal('fetch', fetch)

    const pending = submitMerchantSupportRequest('/api', {
      subject: 'Alpha workspace intake',
      message: 'Please review the catalog access issue.',
      idempotency_key: 'support-intent-alpha',
    })
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toBe('/api/v1/support/requests')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('x-workspace-id')).toBe('ws_alpha')
    expect(JSON.parse(String(init?.body))).toMatchObject({
      subject: 'Alpha workspace intake',
      message: 'Please review the catalog access issue.',
      idempotency_key: 'support-intent-alpha',
    })

    activateMerchantWorkspace('ws_beta')
    resolveAlpha(envelope('ws_alpha', {
      ticket_id: '123e4567-e89b-12d3-a456-426614174000',
      ticket_number: 'SUP-20261011-001',
      status: 'open',
      replayed: false,
      replies_path: '/v1/support/requests/123e4567-e89b-12d3-a456-426614174000',
      submitted: true,
    }))

    await expect(pending).rejects.toMatchObject({ code: 'API_WORKSPACE_CONTEXT_CHANGED' })
    expect(fetch).toHaveBeenCalledOnce()
    expect(getMerchantWorkspaceScope().activeWorkspaceId).toBe('ws_beta')
  })
})
