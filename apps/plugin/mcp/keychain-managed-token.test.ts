import { describe, expect, it } from 'vitest'
// @ts-ignore JavaScript runtime module
import { loadManagedToken } from './managed-token.mjs'
// @ts-ignore JavaScript runtime module
import { TEMPORARY_CREDENTIAL_ERROR_CODE } from './managed-credential-state.mjs'

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

  it.each(['sync', 'async'])('classifies a %s native read timeout as temporary and clears every stale credential', async mode => {
    const target = { ...env(), MERCHANT_MCP_TOKEN: 'stale', MERCHANT_MCP_REFRESH_TOKEN: 'stale-r', MERCHANT_MCP_TOKEN_EXPIRES_AT: '2030-01-01T00:00:00Z' }
    const failure = new Error('MCP_KEYCHAIN_HELPER_INVALID: helper_timeout operation=read')
    const read = () => { if (mode === 'sync') throw failure; return Promise.reject(failure) }
    const result = Promise.resolve().then(() => loadManagedToken(target, 'darwin', () => '', read))
    await expect(result).rejects.toMatchObject({
      code: TEMPORARY_CREDENTIAL_ERROR_CODE,
      message: 'MCP_CREDENTIAL_SOURCE_INVALID: managed credential service temporarily unavailable.',
    })
    expect(target).not.toHaveProperty('MERCHANT_MCP_TOKEN')
    expect(target).not.toHaveProperty('MERCHANT_MCP_REFRESH_TOKEN')
    expect(target).not.toHaveProperty('MERCHANT_MCP_TOKEN_EXPIRES_AT')
  })

  it.each([
    'MCP_KEYCHAIN_HELPER_INVALID: helper_timeout operation=write',
    'MCP_KEYCHAIN_HELPER_INVALID: keychain_osstatus=-25293 operation=read',
    'MCP_KEYCHAIN_CREDENTIAL_INVALID',
    'MCP_KEYCHAIN_HELPER_INVALID: helper_timeout operation=read extra-diagnostic',
  ])('keeps non-retryable store failures permanent and sanitized: %s', async message => {
    const target = { ...env(), MERCHANT_MCP_TOKEN: 'stale', MERCHANT_MCP_REFRESH_TOKEN: 'stale-r', MERCHANT_MCP_TOKEN_EXPIRES_AT: '2030-01-01T00:00:00Z' }
    const result = loadManagedToken(target, 'darwin', () => '', async () => { throw new Error(message) })
    await expect(result).rejects.toThrow('MCP_CREDENTIAL_SOURCE_INVALID: managed credentials unavailable or scope changed; reconnect with matching configuration.')
    await expect(result).rejects.not.toHaveProperty('code')
    expect(target).not.toHaveProperty('MERCHANT_MCP_TOKEN')
    expect(target).not.toHaveProperty('MERCHANT_MCP_REFRESH_TOKEN')
    expect(target).not.toHaveProperty('MERCHANT_MCP_TOKEN_EXPIRES_AT')
  })
})
