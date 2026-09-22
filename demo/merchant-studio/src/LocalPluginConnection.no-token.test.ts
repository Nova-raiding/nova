import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalPluginConnection, localPluginConnectUrl, localPluginLoginCommand } from './LocalPluginConnection'
import type { MerchantAuthAccount } from './api'

describe('local plugin guidance never signs browser credentials', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('renders the real component without calling fetch or retaining the signing entry point', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const account: MerchantAuthAccount = {
      id: 'merchant_no_token', login: 'no-token@example.test', accountType: 'merchant', status: 'active',
      roles: ['workspace_owner'], workspaceIds: ['ws_no_token'],
    }

    const markup = renderToStaticMarkup(React.createElement(LocalPluginConnection, { apiBaseUrl: 'https://merchant.example.test', account }))
    const source = readFileSync(new URL('./LocalPluginConnection.tsx', import.meta.url), 'utf8')

    expect(markup).toContain('连接 ChatGPT 本地插件')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(source).not.toContain("from './local-plugin-connection'")
    expect(source).not.toContain('requestLocalPluginCredential')
    expect(source).not.toContain('/v1/auth/mcp-token')
  })

  it('only puts non-secret routing data in the protocol URL', () => {
    const url = localPluginConnectUrl('https://yxsona.com/api', ['ws_safe-1'])
    expect(url).toBe('storenova://connect?api_origin=https%3A%2F%2Fyxsona.com&workspace=ws_safe-1')
    expect(url).not.toMatch(/(?:access|refresh)?_?token|password|secret|authorization|code=/iu)
  })

  it('does not generate executable guidance from an unsafe origin or workspace', () => {
    expect(localPluginLoginCommand('https://yxsona.com/api', ['ws_safe-1'])).toBe('node scripts/login-local-macos.mjs --base-url https://yxsona.com --workspace ws_safe-1')
    expect(localPluginLoginCommand('http://127.0.0.1:8787/api', ['workspace_safe_2'])).toBe('node scripts/login-local-macos.mjs --base-url http://127.0.0.1:8787 --workspace workspace_safe_2')
    expect(localPluginLoginCommand('http://yxsona.com/api', ['ws_safe'])).toBeNull()
    expect(localPluginLoginCommand('https://user:secret@yxsona.com/api', ['ws_safe'])).toBeNull()
    expect(localPluginLoginCommand('https://evil;id.example/api', ['ws_safe'])).toBeNull()
    expect(localPluginLoginCommand("https://evil.example';id/api", ['ws_safe'])).toBeNull()
    expect(localPluginLoginCommand('https://yxsona.com/api', ['ws_safe;open /tmp/pwned'])).toBeNull()
    expect(localPluginLoginCommand('https://yxsona.com/api', ['ws_one', 'ws_two'])).toBeNull()
    expect(localPluginLoginCommand('https://yxsona.com/api', [`ws_${'a'.repeat(121)}`])).toBeNull()
  })
})
