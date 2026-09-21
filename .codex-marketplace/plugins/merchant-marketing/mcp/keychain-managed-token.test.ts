import { describe, expect, it } from 'vitest'
// @ts-ignore JavaScript runtime module
import { loadManagedToken } from './managed-token.mjs'

describe('keychain managed token startup', () => {
  const env = () => ({ MERCHANT_MCP_TOKEN_SOURCE: 'keychain', MERCHANT_MCP_BASE_URL: 'https://merchant.example.test/mcp', MERCHANT_WORKSPACE_ID: 'ws_test' })

  it('loads a token pair for the exact normalized origin/workspace binding', async () => {
    const target = env()
    await loadManagedToken(target, 'darwin', () => '', async (scope: unknown) => {
      expect(scope).toEqual({ apiOrigin: 'https://merchant.example.test', workspaceId: 'ws_test' })
      return { access_token: 'a', refresh_token: 'r', expires_at: '2030-01-01T00:00:00Z' }
    })
    expect(target).toMatchObject({ MERCHANT_MCP_TOKEN: 'a', MERCHANT_MCP_REFRESH_TOKEN: 'r' })
  })

  it('clears credentials and fails closed on unsupported platform or persistence failure', async () => {
    for (const platform of ['linux', 'win32']) expect(() => loadManagedToken(env(), platform, () => '', async () => null)).toThrow('MCP_CREDENTIAL_SOURCE_INVALID')
    const target = { ...env(), MERCHANT_MCP_TOKEN: 'stale', MERCHANT_MCP_REFRESH_TOKEN: 'stale-r' }
    await expect(loadManagedToken(target, 'darwin', () => '', async () => { throw new Error('secret detail') })).rejects.toThrow('MCP_CREDENTIAL_SOURCE_INVALID')
    expect(target).not.toHaveProperty('MERCHANT_MCP_TOKEN')
    expect(target).not.toHaveProperty('MERCHANT_MCP_REFRESH_TOKEN')
  })
})
