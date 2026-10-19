import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { localPluginAuthorizationHtml, localPluginLoginRequiredHtml, localPluginWorkspaceMismatchHtml, parseLocalPluginAuthorizationRequest, parseLocalPluginTokenRequest, validateLocalPluginRedirectUri } from './local-plugin-auth.js'

const verifier = 'local-plugin-pkce-verifier-000000000000000000000000000000000000'
const challenge = createHash('sha256').update(verifier).digest('base64url')
const state = 's'.repeat(43)
const redirectUri = 'http://127.0.0.1:49191/merchant-mcp-callback'

describe('local plugin PKCE contract', () => {
  it('accepts the fixed client, exact loopback callback, S256 and bound workspace/resource', () => {
    expect(parseLocalPluginAuthorizationRequest(new URLSearchParams({ response_type: 'code', client_id: 'local-desktop', redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256', scope: 'merchant', resource: 'https://yxsona.com/mcp', workspace_id: 'ws_store' }))).toMatchObject({ redirectUri, state, workspaceId: 'ws_store' })
    expect(parseLocalPluginTokenRequest(new URLSearchParams({ grant_type: 'authorization_code', client_id: 'local-desktop', redirect_uri: redirectUri, code: 'opaque-code', code_verifier: verifier, resource: 'https://yxsona.com/mcp', workspace_id: 'ws_store' }))).toMatchObject({ code: 'opaque-code', workspaceId: 'ws_store' })
    expect(parseLocalPluginAuthorizationRequest(new URLSearchParams({ response_type: 'code', client_id: 'local-desktop', redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256', scope: 'merchant', resource: 'https://yxsona.com/mcp', workspace_id: 'workspace_legacy_test' })).workspaceId).toBe('workspace_legacy_test')
  })

  it('accepts the rolling-upgrade deep-link workspace spelling and rejects conflicting aliases', () => {
    const authorization = new URLSearchParams({ response_type: 'code', client_id: 'local-desktop', redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256', scope: 'merchant', resource: 'https://yxsona.com/mcp', workspace: 'ws_store' })
    expect(parseLocalPluginAuthorizationRequest(authorization).workspaceId).toBe('ws_store')
    authorization.set('workspace_id', 'ws_other')
    expect(() => parseLocalPluginAuthorizationRequest(authorization)).toThrow('INVALID_REQUEST')
    const token = new URLSearchParams({ grant_type: 'authorization_code', client_id: 'local-desktop', redirect_uri: redirectUri, code: 'opaque-code', code_verifier: verifier, resource: 'https://yxsona.com/mcp', workspace: 'ws_store' })
    expect(parseLocalPluginTokenRequest(token).workspaceId).toBe('ws_store')
  })

  it.each([
    'http://localhost:49191/merchant-mcp-callback',
    'http://127.0.0.1/merchant-mcp-callback',
    'http://127.0.0.1:80/merchant-mcp-callback',
    'http://127.0.0.1:49191/other',
    'http://127.0.0.1:49191/merchant-mcp-callback?code=chosen',
    'http://127.0.0.1:049191/merchant-mcp-callback',
    'https://127.0.0.1:49191/merchant-mcp-callback',
  ])('rejects callback %s', value => expect(() => validateLocalPluginRedirectUri(value)).toThrow('INVALID_REDIRECT_URI'))

  it('keeps the complete authorization transaction on the login-required page without embedding credentials', () => {
    const request = parseLocalPluginAuthorizationRequest(new URLSearchParams({ response_type: 'code', client_id: 'local-desktop', redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256', scope: 'merchant', resource: 'https://yxsona.com/mcp', workspace_id: 'ws_store' }))
    const html = localPluginLoginRequiredHtml(request)
    expect(html).toContain('登录商家账号')
    expect(html).toContain('plugin_authorize=')
    expect(html).toContain(encodeURIComponent(redirectUri))
    expect(html).toContain(`state=${state}`)
    expect(html).toContain(`code_challenge=${challenge}`)
    expect(html).not.toMatch(/password|access_token|refresh_token/u)
  })

  it('renders a safe recovery page when the signed-in merchant lacks the requested workspace', () => {
    const request = parseLocalPluginAuthorizationRequest(new URLSearchParams({ response_type: 'code', client_id: 'local-desktop', redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256', scope: 'merchant', resource: 'https://yxsona.com/mcp', workspace_id: 'ws_store' }))
    const html = localPluginWorkspaceMismatchHtml(request)
    expect(html).toContain('当前账号无法连接此插件')
    expect(html).toContain('未授权、未创建访问凭据')
    expect(html).toContain('切换商家账号')
    const loginLink = html.match(/href="\/\?plugin_authorize=([^"]+)"/u)
    expect(loginLink?.[1]).toBeTruthy()
    const returnUrl = new URL(decodeURIComponent(loginLink![1]!), 'https://example.test')
    expect(returnUrl.pathname).toBe('/v1/auth/local-plugin/authorize')
    expect(returnUrl.searchParams.get('workspace_id')).toBe('ws_store')
    expect(returnUrl.searchParams.get('state')).toBe(state)
    expect(html).not.toMatch(/password|access_token|refresh_token/u)
  })

  it('renders an accessible, styled consent page bound to the escaped account and workspace', () => {
    const request = parseLocalPluginAuthorizationRequest(new URLSearchParams({ response_type: 'code', client_id: 'local-desktop', redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256', scope: 'merchant', resource: 'https://yxsona.com/mcp', workspace_id: 'ws_store' }))
    const html = localPluginAuthorizationHtml(request, { login: 'merchant<&>@example.test', workspaceId: 'ws_store' })
    expect(html).toContain('<meta name="viewport" content="width=device-width,initial-scale=1">')
    expect(html).toContain('class="summary" aria-label="授权账号与工作区"')
    expect(html).toContain('merchant&lt;&amp;&gt;@example.test')
    expect(html).toContain('仅连接此工作区的 Store Nova 本地插件')
    expect(html).toContain('不会因本次授权扣费或发布内容')
    expect(html).toContain('本次授权不会自动连接第三方店铺或执行店铺操作；后续任何店铺操作仍需单独的平台授权、规则确认和真实回执')
    expect(html).toContain('<button class="primary" type="submit">确认授权本地插件</button>')
    expect(html).toContain(`name="state" value="${state}"`)
    expect(html).not.toMatch(/access_token|refresh_token/u)
  })
})
