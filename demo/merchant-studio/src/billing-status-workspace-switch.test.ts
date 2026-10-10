import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activateMerchantWorkspace,
  clearMerchantWorkspaceScope,
  configureMerchantWorkspaceScope,
  fetchBillingStatus,
  getMerchantWorkspaceScope,
} from './api.js'

const envelope = (workspaceId: string, result: unknown) => new Response(JSON.stringify({
  request_id: 'billing-status-workspace-switch',
  trace_id: 'billing-status-workspace-switch',
  workspace_id: workspaceId,
  data: { jsonrpc: '2.0', id: 'billing-status', result },
  warnings: [],
  next_actions: [],
  error: null,
}), { headers: { 'content-type': 'application/json' } })

describe('billing status workspace ownership', () => {
  beforeEach(() => {
    clearMerchantWorkspaceScope()
    vi.stubGlobal('window', Object.assign(globalThis, { setTimeout, clearTimeout, dispatchEvent: vi.fn() }))
  })

  afterEach(() => {
    clearMerchantWorkspaceScope()
    vi.unstubAllGlobals()
  })

  it('rejects late balance and wallet snapshots from A after switching to B', async () => {
    configureMerchantWorkspaceScope(['ws_alpha', 'ws_beta'], 'ws_alpha')
    const resolvers: Array<(response: Response) => void> = []
    const fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      new Promise<Response>(resolve => { resolvers.push(resolve) }),
    )
    vi.stubGlobal('fetch', fetch)

    const pending = fetchBillingStatus('/api')
    expect(fetch).toHaveBeenCalledTimes(2)
    const calls = fetch.mock.calls.map(([, init]) => ({
      workspace: new Headers(init?.headers).get('x-workspace-id'),
      method: JSON.parse(String(init?.body)).method,
      params: JSON.parse(String(init?.body)).params,
    }))
    expect(calls).toEqual(expect.arrayContaining([
      { workspace: 'ws_alpha', method: 'creative-points.balance.get', params: {} },
      { workspace: 'ws_alpha', method: 'billing.transactions', params: { scope: 'workspace', limit: '20' } },
    ]))

    activateMerchantWorkspace('ws_beta')
    const balanceIndex = calls.findIndex(call => call.method === 'creative-points.balance.get')
    const walletIndex = calls.findIndex(call => call.method === 'billing.transactions')
    resolvers[balanceIndex]!(envelope('ws_alpha', { balance_state: 'known', available_points: 25 }))
    resolvers[walletIndex]!(envelope('ws_alpha', { balance_cny: '30.00', transactions: [] }))

    await expect(pending).rejects.toMatchObject({ code: 'API_WORKSPACE_CONTEXT_CHANGED' })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(getMerchantWorkspaceScope().activeWorkspaceId).toBe('ws_beta')
  })
})
