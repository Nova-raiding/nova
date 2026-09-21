import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { localPluginLoginRequiredHtml, parseLocalPluginAuthorizationRequest, parseLocalPluginTokenRequest, validateLocalPluginRedirectUri } from './local-plugin-auth.js'

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
    expect(html).toContain('target="_blank"')
    expect(html).toContain(encodeURIComponent(redirectUri))
    expect(html).toContain(`state=${state}`)
    expect(html).toContain(`code_challenge=${challenge}`)
    expect(html).not.toMatch(/password|access_token|refresh_token/u)
  })
})
