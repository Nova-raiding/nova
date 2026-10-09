import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bootstrapMerchantWorkspace, clearMerchantWorkspaceScope, fetchMerchantSession, getMerchantWorkspaceScope } from './api.js'
import { MerchantWorkspaceBootstrapPage } from './MerchantWorkspaceBootstrapPage'

function envelope(data: unknown, status = 201) {
  return new Response(JSON.stringify({ request_id: 'bootstrap-test', trace_id: 'bootstrap-trace', workspace_id: '', data, warnings: [], next_actions: [], error: null }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('merchant first-workspace onboarding', () => {
  beforeEach(() => {
    clearMerchantWorkspaceScope()
    vi.stubGlobal('window', Object.assign(globalThis, { setTimeout, clearTimeout, dispatchEvent: vi.fn() }))
  })

  afterEach(() => {
    clearMerchantWorkspaceScope()
    vi.unstubAllGlobals()
  })

  it('lets a valid workspace-less merchant bootstrap without sending tenant scope, then recognizes the assigned session', async () => {
    const merchant = { id: 'merchant-1', login: 'first@example.test', accountType: 'merchant', status: 'active', roles: [], workspaceIds: [] }
    const sessionResponse = (workspaceIds: string[]) => new Response(JSON.stringify({ request_id: 'session-test', trace_id: 'session-trace', workspace_id: '', data: { account: { ...merchant, workspaceIds } }, warnings: [], next_actions: [], error: null }), { headers: { 'content-type': 'application/json' } })
    const fetch = vi.fn()
      .mockResolvedValueOnce(sessionResponse([]))
      .mockResolvedValueOnce(envelope({ workspace_id: 'ws_first_123', status: 'active', reused: false, next_action: 'local_plugin_connect' }))
      .mockResolvedValueOnce(sessionResponse(['ws_first_123']))
    vi.stubGlobal('fetch', fetch)

    const unassigned = await fetchMerchantSession('/api')
    expect(unassigned.workspaceIds).toEqual([])
    const created = await bootstrapMerchantWorkspace('/api', '首个企业工作区')
    expect(created).toMatchObject({ workspace_id: 'ws_first_123', status: 'active' })
    const session = await fetchMerchantSession('/api')
    expect(session.workspaceIds).toEqual(['ws_first_123'])
    expect(getMerchantWorkspaceScope()).toMatchObject({ workspaceIds: [], activeWorkspaceId: null })
    expect(fetch).toHaveBeenCalledTimes(3)
    const [bootstrapUrl, bootstrapInit] = fetch.mock.calls[1] as unknown as [string, RequestInit]
    const bootstrapHeaders = new Headers(bootstrapInit.headers)
    expect(bootstrapUrl).toBe('/api/v1/auth/workspace-bootstrap')
    expect(bootstrapInit.method).toBe('POST')
    expect(JSON.parse(String(bootstrapInit.body))).toEqual({ display_name: '首个企业工作区' })
    expect(bootstrapHeaders.has('x-workspace-id')).toBe(false)
    expect(bootstrapInit.credentials).toBe('include')
    for (const [, init] of fetch.mock.calls) expect(new Headers((init as RequestInit).headers).has('x-workspace-id')).toBe(false)
  })

  it('renders explicit first-workspace creation and logout recovery for an unassigned merchant', () => {
    const html = renderToStaticMarkup(createElement(MerchantWorkspaceBootstrapPage, {
      apiBaseUrl: '/api',
      account: { id: 'merchant-1', login: 'first@example.test', accountType: 'merchant', status: 'active', roles: [], workspaceIds: [] },
      onComplete: () => undefined,
      onLogout: () => undefined,
    }))
    expect(html).toContain('创建首次工作区')
    expect(html).toContain('id="merchant-workspace-display-name"')
    expect(html).toContain('创建工作区')
    expect(html).toContain('退出登录')
    expect(html).toContain('首次创建只会为当前登录账号建立一个工作区和所有者关系')
    const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
    const noWorkspaceRoute = app.slice(app.indexOf('if (apiBaseUrl && authState === \'authenticated\' && authAccount && !activeWorkspaceId)'), app.indexOf('return (\n    <div className="app-shell">'))
    expect(noWorkspaceRoute).toContain('if (authorizedWorkspaces.length === 0) return <MerchantWorkspaceBootstrapPage')
    expect(noWorkspaceRoute).toContain('onLogout={() => void handleMerchantLogout()}')
  })
})
