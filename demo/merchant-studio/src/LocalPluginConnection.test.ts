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
    expect(component).toContain('当前没有可信安装器交接')
    expect(component).toContain('此操作不会安装插件，也不会完成连接')
    expect(component).toContain('wrapClassName="merchant-local-plugin-modal"')
    expect(component).not.toContain('getContainer={false}')
    expect(app).toContain("event.target.closest('.merchant-local-plugin-modal')")
    expect(component).toContain('待安装器接管 · 本地插件尚未连接')
    expect(component).toContain('当前也未接入可信安装器交接通道')
    expect(component).toContain('本次临时凭据已丢弃')
    expect(component).not.toMatch(/localStorage\s*\.|sessionStorage\s*\.|console\.|navigator\.clipboard|createObjectURL/u)
    expect(component).toContain('latestScope.current !== scope')
    expect(component).toContain('request.current?.abort()')
  })

  it('opens confirmation without issuing a credential and requires a separate explicit confirmation', () => {
    const component = readFileSync(new URL('./LocalPluginConnection.tsx', import.meta.url), 'utf8')
    expect(component).toContain("<Button onClick={() => { setState({ scope, status: 'confirmation' }); setOpen(true) }}>连接本地插件</Button>")
    expect(component).toContain("current?.status === 'confirmation' && <Button type=\"primary\" onClick={(event) => { event.stopPropagation(); void connect() }}>确认签发短期凭据</Button>")
    expect(component.indexOf("status: 'confirmation'")).toBeLessThan(component.indexOf('requestLocalPluginCredential(apiBaseUrl, account, controller.signal)'))
    expect(component).not.toMatch(/连接本地插件<\/Button>[\s\S]{0,80}connect\(\)/u)
  })

  it('cancels without requesting and keeps retry behind an explicit action', () => {
    const component = readFileSync(new URL('./LocalPluginConnection.tsx', import.meta.url), 'utf8')
    const closeBody = component.match(/const close = \(\) => \{([\s\S]*?)\n  \}/u)?.[1] ?? ''
    expect(closeBody).toContain('request.current?.abort()')
    expect(closeBody).toContain('setOpen(false)')
    expect(closeBody).not.toContain('requestLocalPluginCredential')
    expect(component).toContain("current?.status === 'error' && <Button type=\"primary\" onClick={(event) => { event.stopPropagation(); void connect() }}>重试验证</Button>")
    expect(component).toContain("<Button onClick={(event) => { event.stopPropagation(); close() }}>")
  })

  it('invalidates an in-flight request when the account scope changes', () => {
    const component = readFileSync(new URL('./LocalPluginConnection.tsx', import.meta.url), 'utf8')
    expect(component).toContain('const scope = JSON.stringify([apiBaseUrl, account.id, account.login, account.status, account.workspaceIds])')
    expect(component).toContain('latestScope.current !== scope')
    expect(component).toMatch(/useEffect\(\(\) => \{[\s\S]*request\.current\?\.abort\(\)[\s\S]*\}, \[scope\]\)/u)
    expect(component).toContain("open={open && state?.scope === scope}")
  })
})
