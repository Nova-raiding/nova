import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { detectLocalPluginPlatform, LocalPluginConnection, localPluginConnectUrl, localPluginEnrollUrl, localPluginLoginCommand, parsePluginPairFragment } from './LocalPluginConnection'
import type { MerchantAuthAccount } from './api'

const account: MerchantAuthAccount = {
  id: 'merchant_fixture', login: 'merchant@example.test', accountType: 'merchant',
  status: 'active', roles: ['workspace_owner'], workspaceIds: ['workspace_fixture'],
}

describe('local plugin connection entry', () => {
  it('renders installation guidance only for an active merchant', () => {
    const markup = renderToStaticMarkup(React.createElement(LocalPluginConnection, { apiBaseUrl: '/api', account }))
    expect(markup).toContain('连接 ChatGPT 本地插件')
    expect(markup).toContain('尚未验证')
    expect(markup).toContain('<button')
    expect(markup).not.toContain('access_token')
    expect(markup).not.toContain('refresh_token')
    expect(markup).toContain('disabled=""')
    expect(renderToStaticMarkup(React.createElement(LocalPluginConnection, { apiBaseUrl: '/api', account: { ...account, status: 'suspended' } }))).toBe('')
    expect(renderToStaticMarkup(React.createElement(LocalPluginConnection, { apiBaseUrl: '/api', account: { ...account, accountType: 'platform' } }))).toBe('')
  })

  it('keeps the authenticated topbar and safe body Portal contract', () => {
    const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
    const component = readFileSync(new URL('./LocalPluginConnection.tsx', import.meta.url), 'utf8')
    expect(app).toContain('apiBaseUrl && account && <LocalPluginConnection apiBaseUrl={apiBaseUrl} account={account}')
    expect(component).toContain('wrapClassName="merchant-local-plugin-modal"')
    expect(component).not.toContain('getContainer={false}')
    expect(app).toContain("event.target.closest('.merchant-local-plugin-modal')")
  })

  it('presents a one-click entry without showing shell commands to merchants', () => {
    const component = readFileSync(new URL('./LocalPluginConnection.tsx', import.meta.url), 'utf8')
    const markup = renderToStaticMarkup(React.createElement(LocalPluginConnection, { apiBaseUrl: '/api', account }))
    expect(markup).toContain('连接 ChatGPT 本地插件')
    expect(markup).toContain('安装与故障帮助')
    expect(markup).not.toMatch(/login-local|login\.cmd|runtime\/node/u)
    expect(component).toContain('install-instances/pair')
    expect(component).toContain('installation_id: installationId')
    expect(component).toContain('检查 Store Nova 插件是否已连接')
    expect(component).not.toContain('onboarding.status')
  })

  it('uses platform hints for guidance only', () => {
    expect(detectLocalPluginPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)', 'MacIntel')).toBe('macos')
    expect(detectLocalPluginPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Win32')).toBe('windows')
    expect(detectLocalPluginPlatform('Mozilla/5.0 (X11; Linux x86_64)', 'Linux x86_64')).toBe('other')
    const source = readFileSync(new URL('./LocalPluginConnection.tsx', import.meta.url), 'utf8')
    expect(source).toContain("body: JSON.stringify({ workspace_id: workspaceId, installation_id: installationId })")
    expect(source).not.toMatch(/body:\s*JSON\.stringify\([^)]*(?:platform|userAgent|credentialStore)/u)
  })

  it('builds a credential-free custom protocol URL from validated public identifiers', () => {
    const url = localPluginConnectUrl('https://yxsona.com/api', ['ws_safe-1'], 'connect_123456789012')
    expect(url).toBe('storenova://connect?api_origin=https%3A%2F%2Fyxsona.com&workspace=ws_safe-1&request_id=connect_123456789012')
    expect(url).not.toMatch(/token|password|code=/u)
    expect(localPluginConnectUrl('http://yxsona.com/api', ['ws_safe-1'])).toBeNull()
    expect(localPluginConnectUrl('https://yxsona.com/api', ['ws_safe-1'], 'unsafe')).toBeNull()
    expect(localPluginEnrollUrl('https://yxsona.com/api', ['ws_safe-1'], undefined, 'account_123')).toBe('storenova://enroll?api_origin=https%3A%2F%2Fyxsona.com&workspace=ws_safe-1&account_id=account_123')
  })

  it('accepts only a current pairing for an authorized workspace', () => {
    const pair = { installation_id: '11111111-1111-4111-8111-111111111111', pairing_token: 'p'.repeat(43),
      workspace_id: 'ws_safe-1', expires_at: new Date(Date.now() + 60_000).toISOString() }
    const fragment = `#plugin_pair=${Buffer.from(JSON.stringify(pair)).toString('base64url')}`
    expect(parsePluginPairFragment(fragment, ['ws_safe-1'])).toEqual(pair)
    expect(parsePluginPairFragment(fragment, ['ws_foreign'])).toBeNull()
    expect(parsePluginPairFragment('#plugin_pair=unsafe', ['ws_safe-1'])).toBeNull()
  })

  it('requires explicit selection for multiple authorized workspaces', () => {
    const workspaces = ['ws_first', 'ws_second']
    expect(localPluginConnectUrl('https://yxsona.com/api', workspaces)).toBeNull()
    expect(localPluginConnectUrl('https://yxsona.com/api', workspaces, undefined, 'ws_foreign')).toBeNull()
    expect(localPluginConnectUrl('https://yxsona.com/api', workspaces, undefined, 'ws_second')).toContain('workspace=ws_second')
    const markup = renderToStaticMarkup(React.createElement(LocalPluginConnection, { apiBaseUrl: '/api', account: { ...account, workspaceIds: workspaces } }))
    expect(markup).toContain('选择插件工作区')
    expect(markup).toContain('disabled=""')
  })

  it('shows platform-specific commands from the bundled runtime', () => {
    expect(localPluginLoginCommand('https://yxsona.com/api', ['ws_first', 'ws_second'], 'ws_second', 'macos')).toBe('./runtime/node scripts/login-local-macos.mjs --base-url https://yxsona.com --workspace ws_second')
    expect(localPluginLoginCommand('https://yxsona.com/api', ['ws_first', 'ws_second'], 'ws_second', 'windows')).toBe('login.cmd --workspace ws_second')
    expect(localPluginLoginCommand('http://127.0.0.1:8787/api', ['ws_first'], undefined, 'windows')).toBe('runtime\\node.exe scripts\\login-local-windows.mjs --base-url http://127.0.0.1:8787 --workspace ws_first')
    expect(localPluginLoginCommand('https://yxsona.com/api', ['ws_first'], 'ws_foreign', 'windows')).toBeNull()
    expect(localPluginLoginCommand('https://yxsona.com/api', ['ws_first'], undefined, 'other')).toBeNull()
  })

  it('keeps installation help brief', () => {
    const component = readFileSync(new URL('./LocalPluginConnection.tsx', import.meta.url), 'utf8')
    expect(component).toContain('点击连接并按浏览器提示打开本地插件')
    expect(component).toContain('一键授权暂未开放')
    expect(component).not.toContain('查看安装与登录步骤')
  })

  it('keeps account and workspace guidance isolated when identity changes', () => {
    const component = readFileSync(new URL('./LocalPluginConnection.tsx', import.meta.url), 'utf8')
    expect(component).toContain('const scope = JSON.stringify([apiBaseUrl, account.id, account.login, account.status, account.workspaceIds])')
    expect(component).toContain('open={openScope === scope}')
    expect(component).toContain('/^(?:ws_|workspace_)[A-Za-z0-9_-]{1,120}$/u')
    expect(component).toContain("base.protocol === 'http:' && base.hostname === '127.0.0.1'")
    expect(component).toContain('base.username || base.password')
    expect(component).toContain('shellSafeOrigin.test(base.origin)')
    expect(component).not.toContain('<API_ORIGIN>')
  })

  it('stores only the public installation id in browser state', () => {
    const component = readFileSync(new URL('./LocalPluginConnection.tsx', import.meta.url), 'utf8')
    expect(component).not.toContain('requestLocalPluginCredential')
    expect(component).not.toContain('/v1/auth/mcp-token')
    expect(component).toContain('window.localStorage.setItem(installationKey, result.installation_id)')
    expect(component).not.toMatch(/access_token|refresh_token|sessionStorage\s*\.|console\.|navigator\.clipboard|createObjectURL|location\.href\s*=|window\.open/u)
  })
})
