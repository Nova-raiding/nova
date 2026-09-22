import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { detectLocalPluginPlatform, LocalPluginConnection, localPluginConnectUrl } from './LocalPluginConnection'
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

  it('points to the installed local CLI without claiming installation or connection', () => {
    const component = readFileSync(new URL('./LocalPluginConnection.tsx', import.meta.url), 'utf8')
    expect(component).toContain('node scripts/login-local-macos.mjs --base-url ${apiOrigin} --workspace ${workspaceId}')
    expect(component).toContain('node scripts/build-keychain-helper.mjs')
    expect(component).toContain('一键连接需要已安装的 Store Nova Helper')
    expect(component).toContain('不代表插件已经安装或连接成功')
    expect(component).toContain('macOS 钥匙串（Keychain）')
    expect(component).toContain('Windows 凭据管理器（Credential Manager）')
    expect(component).toContain('onboarding.status')
    expect(component).toContain('不要执行远程 curl 管道命令')
  })

  it('uses platform hints for guidance only', () => {
    expect(detectLocalPluginPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)', 'MacIntel')).toBe('macos')
    expect(detectLocalPluginPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Win32')).toBe('windows')
    expect(detectLocalPluginPlatform('Mozilla/5.0 (X11; Linux x86_64)', 'Linux x86_64')).toBe('other')
    const source = readFileSync(new URL('./LocalPluginConnection.tsx', import.meta.url), 'utf8')
    expect(source).toContain("body: JSON.stringify({ workspace_id: workspaceId })")
    expect(source).not.toMatch(/body:\s*JSON\.stringify\([^)]*(?:platform|userAgent|credentialStore)/u)
  })

  it('builds a credential-free custom protocol URL from validated public identifiers', () => {
    const url = localPluginConnectUrl('https://yxsona.com/api', ['ws_safe-1'], 'connect_123456789012')
    expect(url).toBe('storenova://connect?api_origin=https%3A%2F%2Fyxsona.com&workspace=ws_safe-1&request_id=connect_123456789012')
    expect(url).not.toMatch(/token|password|code=/u)
    expect(localPluginConnectUrl('http://yxsona.com/api', ['ws_safe-1'])).toBeNull()
    expect(localPluginConnectUrl('https://yxsona.com/api', ['ws_safe-1'], 'unsafe')).toBeNull()
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

  it('does not expose browser credential, storage, download, or protocol-handler paths', () => {
    const component = readFileSync(new URL('./LocalPluginConnection.tsx', import.meta.url), 'utf8')
    expect(component).not.toContain('requestLocalPluginCredential')
    expect(component).not.toContain('/v1/auth/mcp-token')
    expect(component).not.toMatch(/access_token|refresh_token|localStorage\s*\.|sessionStorage\s*\.|console\.|navigator\.clipboard|createObjectURL|location\.href\s*=|window\.open/u)
  })
})
