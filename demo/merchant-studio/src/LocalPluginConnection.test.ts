import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LocalPluginConnection } from './LocalPluginConnection'
import type { MerchantAuthAccount } from './api'

const account: MerchantAuthAccount = {
  id: 'merchant_fixture', login: 'merchant@example.test', accountType: 'merchant',
  status: 'active', roles: ['workspace_owner'], workspaceIds: ['workspace_fixture'],
}

describe('local plugin connection entry', () => {
  it('renders a real connection action only for an active merchant', () => {
    const markup = renderToStaticMarkup(React.createElement(LocalPluginConnection, { apiBaseUrl: '/api', account }))
    expect(markup).toContain('连接本地插件')
    expect(markup).toContain('<button')
    expect(markup).not.toContain('access_token')
    expect(markup).not.toContain('refresh_token')
    expect(renderToStaticMarkup(React.createElement(LocalPluginConnection, { apiBaseUrl: '/api', account: { ...account, status: 'suspended' } }))).toBe('')
    expect(renderToStaticMarkup(React.createElement(LocalPluginConnection, { apiBaseUrl: '/api', account: { ...account, accountType: 'platform' } }))).toBe('')
  })

  it('is wired to the authenticated topbar and never presents installation as completed', () => {
    const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
    const component = readFileSync(new URL('./LocalPluginConnection.tsx', import.meta.url), 'utf8')
    expect(app).toContain('apiBaseUrl && account && <LocalPluginConnection apiBaseUrl={apiBaseUrl} account={account}')
    expect(component).toContain('requestLocalPluginCredential(apiBaseUrl, account, controller.signal)')
    expect(component).toContain('待安装器接管 · 本地插件尚未连接')
    expect(component).toContain('当前也未接入可信安装器交接通道')
    expect(component).toContain('本次临时凭据已丢弃')
    expect(component).not.toMatch(/localStorage\s*\.|sessionStorage\s*\.|console\.|navigator\.clipboard|createObjectURL/u)
    expect(component).toContain('latestScope.current !== scope')
    expect(component).toContain('request.current?.abort()')
  })
})
