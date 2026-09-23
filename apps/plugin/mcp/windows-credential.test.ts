import { describe, expect, it } from 'vitest'
// @ts-expect-error Native helper module intentionally has no TS build step.
import { createWindowsInstallationIdentityStore, readWindowsCredential, writeWindowsCredential } from './windows-credential.mjs'
// @ts-ignore JavaScript runtime module
import { loadManagedToken, validatedRotatedCredential } from './managed-token.mjs'

const target = { apiOrigin: 'https://yxsona.com', workspaceId: 'ws_test' }
const bundle = { schema_version: '1', api_origin: target.apiOrigin, workspace_id: target.workspaceId,
  access_token: 'access-secret', refresh_token: 'refresh-secret', expires_at: '2027-01-01T00:00:00.000Z' }

describe('Windows Credential Manager bridge', () => {
  it('loads only the exact Windows origin/workspace credential and fails closed on missing storage', async () => {
    const env = { MERCHANT_MCP_TOKEN_SOURCE: 'windows_credential_manager', MERCHANT_MCP_BASE_URL: target.apiOrigin,
      MERCHANT_WORKSPACE_ID: target.workspaceId, MERCHANT_MCP_TOKEN: 'stale', MERCHANT_MCP_REFRESH_TOKEN: 'stale-refresh' }
    await loadManagedToken(env, 'win32', () => { throw new Error('launchd must not run') }, undefined,
      async (scope: unknown) => { expect(scope).toEqual(target); return bundle })
    expect(env.MERCHANT_MCP_TOKEN).toBe(bundle.access_token)
    expect(env.MERCHANT_MCP_REFRESH_TOKEN).toBe(bundle.refresh_token)
    const missing = { ...env }
    await expect(loadManagedToken(missing, 'win32', () => '', undefined, async () => { throw new Error('secret') }))
      .rejects.toThrow('MCP_CREDENTIAL_SOURCE_INVALID')
    expect(missing).not.toHaveProperty('MERCHANT_MCP_TOKEN')
    expect(missing).not.toHaveProperty('MERCHANT_MCP_REFRESH_TOKEN')
    expect(() => loadManagedToken({ ...env }, 'darwin', () => '', undefined, async () => bundle))
      .toThrow('MCP_CREDENTIAL_SOURCE_INVALID')
  })

  it('requires complete bound metadata before persisting a rotated Windows token', () => {
    const context = { tokenSource: 'windows_credential_manager', workspaceId: target.workspaceId, apiOrigin: target.apiOrigin }
    const full = { access_token: 'new-access', refresh_token: 'new-refresh', workspace_id: target.workspaceId,
      token_type: 'Bearer', scope: 'merchant', expires_in: 3600 }
    expect(validatedRotatedCredential(full, context)).toMatchObject({ bundle: { api_origin: target.apiOrigin,
      workspace_id: target.workspaceId, access_token: 'new-access', refresh_token: 'new-refresh' } })
    for (const field of ['workspace_id', 'token_type', 'scope', 'expires_in']) {
      const incomplete = { ...full } as Record<string, unknown>
      delete incomplete[field]
      expect(validatedRotatedCredential(incomplete, context)).toBeNull()
    }
  })
  it('passes the credential record through helper stdin request data, never command arguments', () => {
    let request: Record<string, string> | undefined
    writeWindowsCredential(target, bundle, { runHelper: (value: Record<string, string>) => { request = value; return '' } })
    expect(request).toMatchObject({ operation: 'write', target: 'com.storenova.merchant-mcp' })
    expect(request?.account).toMatch(/^[a-f0-9]{64}$/u)
    expect(request?.data).toContain('access-secret')
    expect(JSON.stringify({ operation: request?.operation, target: request?.target, account: request?.account })).not.toContain('secret')
  })

  it('reads only a credential bound to the requested origin and workspace', () => {
    expect(readWindowsCredential(target, { runHelper: () => JSON.stringify(bundle) })).toEqual(bundle)
    expect(() => readWindowsCredential(target, { runHelper: () => JSON.stringify({ ...bundle, workspace_id: 'ws_other' }) })).toThrow('INVALID')
  })

  it('persists installation identity only through the DPAPI credential helper contract', () => {
    let stored = ''
    const store = createWindowsInstallationIdentityStore({ runHelper: (request: { operation: string; target: string; data?: string }) => {
      expect(request.target).toBe('com.storenova.installation-identity')
      if (request.operation === 'write') stored = request.data ?? ''
      return stored
    } })
    expect(store.load()).toBeUndefined()
    store.save({ installation_id: 'test' })
    expect(store.load()).toEqual({ installation_id: 'test' })
  })
})
