import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activateMerchantWorkspace,
  clearMerchantWorkspaceScope,
  configureMerchantWorkspaceScope,
  confirmPublish,
  getMerchantWorkspaceScope,
} from './api.js'

const envelope = (workspaceId: string, data: unknown) => new Response(JSON.stringify({
  request_id: 'publish-confirm-workspace-switch',
  trace_id: 'publish-confirm-workspace-switch',
  workspace_id: workspaceId,
  data,
  warnings: [],
  next_actions: [],
  error: null,
}), { headers: { 'content-type': 'application/json' } })

describe('publish confirmation workspace ownership', () => {
  beforeEach(() => {
    clearMerchantWorkspaceScope()
    vi.stubGlobal('window', Object.assign(globalThis, { setTimeout, clearTimeout, dispatchEvent: vi.fn() }))
  })

  afterEach(() => {
    clearMerchantWorkspaceScope()
    vi.unstubAllGlobals()
  })

  it('binds publish confirmation to A and rejects its late receipt after switching to B', async () => {
    configureMerchantWorkspaceScope(['ws_alpha', 'ws_beta'], 'ws_alpha')
    let resolveAlpha!: (response: Response) => void
    const fetch = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      new Promise<Response>(resolve => { resolveAlpha = resolve }),
    )
    vi.stubGlobal('fetch', fetch)

    const pending = confirmPublish('/api', {
      task_id: 'task-alpha',
      content_version_id: 'content-alpha-v4',
      confirmation_hash: 'confirm-hash-alpha',
      remote_snapshot_hash: 'remote-snapshot-alpha',
      account_id: 'store-alpha',
    }, 'publish-alpha-once')
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toBe('/api/v1/publish-jobs')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('x-workspace-id')).toBe('ws_alpha')
    expect(new Headers(init?.headers).get('idempotency-key')).toBe('publish-alpha-once')
    expect(JSON.parse(String(init?.body))).toEqual({
      task_id: 'task-alpha',
      content_version_id: 'content-alpha-v4',
      confirmation_hash: 'confirm-hash-alpha',
      remote_snapshot_hash: 'remote-snapshot-alpha',
      account_id: 'store-alpha',
    })

    activateMerchantWorkspace('ws_beta')
    resolveAlpha(envelope('ws_alpha', {
      id: 'publish-job-alpha', taskId: 'task-alpha', contentVersionId: 'content-alpha-v4',
      status: 'queued', accountId: 'store-alpha',
    }))

    await expect(pending).rejects.toMatchObject({ code: 'API_WORKSPACE_CONTEXT_CHANGED' })
    expect(fetch).toHaveBeenCalledOnce()
    expect(getMerchantWorkspaceScope().activeWorkspaceId).toBe('ws_beta')
  })
})
