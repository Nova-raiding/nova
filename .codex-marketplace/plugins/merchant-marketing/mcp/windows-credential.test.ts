import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
// @ts-expect-error Native helper module intentionally has no TS build step.
import { assertWindowsCredentialHelperResult, createWindowsInstallationBindingStore, createWindowsInstallationIdentityStore, readWindowsCredential, WINDOWS_CREDENTIAL_MAX_BLOB_BYTES, WINDOWS_CREDENTIAL_TOO_LARGE_EXIT_CODE, writeWindowsCredential } from './windows-credential.mjs'
// @ts-ignore JavaScript runtime module
import { loadManagedToken, validatedRotatedCredential } from './managed-token.mjs'

const target = { apiOrigin: 'https://yxsona.com', workspaceId: 'ws_test' }
const bundle = { schema_version: '1', api_origin: target.apiOrigin, workspace_id: target.workspaceId,
  access_token: 'access-secret', refresh_token: 'refresh-secret', expires_at: '2027-01-01T00:00:00.000Z' }

describe('Windows Credential Manager bridge', () => {
  it('keeps the JavaScript UTF-8 limit aligned with the native CredentialBlob limit', () => {
    const helper = readFileSync('apps/plugin/windows/StoreNovaCredentialHelper.cs', 'utf8')
    expect(helper).toContain(`const int MAX_CREDENTIAL_BLOB_BYTES = ${WINDOWS_CREDENTIAL_MAX_BLOB_BYTES};`)
  })

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

  it('does not claim a raw record at the byte limit fits after DPAPI protection', () => {
    let request: Record<string, string> | undefined
    let failure: unknown
    const emptyTokenRecord = { ...bundle, access_token: '' }
    const accessTokenBytes = WINDOWS_CREDENTIAL_MAX_BLOB_BYTES - Buffer.byteLength(JSON.stringify(emptyTokenRecord), 'utf8')
    const boundaryBundle = { ...bundle, access_token: 'x'.repeat(accessTokenBytes) }
    try {
      writeWindowsCredential(target, boundaryBundle, { runHelper: (value: Record<string, string>) => {
        request = value
        assertWindowsCredentialHelperResult({ status: WINDOWS_CREDENTIAL_TOO_LARGE_EXIT_CODE })
        return ''
      } })
    } catch (error) { failure = error }
    expect(Buffer.byteLength(request?.data ?? '', 'utf8')).toBe(WINDOWS_CREDENTIAL_MAX_BLOB_BYTES)
    expect(failure).toMatchObject({ code: 'MCP_WINDOWS_CREDENTIAL_TOO_LARGE', message: 'MCP_WINDOWS_CREDENTIAL_TOO_LARGE' })
  })

  it('rejects a UTF-8 credential record above the helper input bound before invoking the helper', () => {
    let called = false
    let failure: unknown
    const emptyTokenRecord = { ...bundle, access_token: '' }
    const accessTokenBytes = WINDOWS_CREDENTIAL_MAX_BLOB_BYTES - Buffer.byteLength(JSON.stringify(emptyTokenRecord), 'utf8') + 1
    const oversizedBundle = { ...bundle, access_token: 'x'.repeat(accessTokenBytes) }
    try { writeWindowsCredential(target, oversizedBundle, { runHelper: () => { called = true; return '' } }) }
    catch (error) { failure = error }
    expect(failure).toMatchObject({ code: 'MCP_WINDOWS_CREDENTIAL_TOO_LARGE', message: 'MCP_WINDOWS_CREDENTIAL_TOO_LARGE' })
    expect(called).toBe(false)
  })

  it('reads only a credential bound to the requested origin and workspace', () => {
    expect(readWindowsCredential(target, { runHelper: () => JSON.stringify(bundle) })).toEqual(bundle)
    expect(() => readWindowsCredential(target, { runHelper: () => JSON.stringify({ ...bundle, workspace_id: 'ws_other' }) })).toThrow('INVALID')
  })

  it('persists installation identity only through the DPAPI credential helper contract', () => {
    let stored = 'null'
    const store = createWindowsInstallationIdentityStore({ runHelper: (request: { operation: string; target: string; data?: string }) => {
      expect(request.target).toBe('com.storenova.installation-identity')
      if (request.operation === 'write') stored = request.data ?? ''
      return stored
    } })
    expect(store.load()).toBeUndefined()
    store.save({ installation_id: 'test' })
    expect(store.load()).toEqual({ installation_id: 'test' })
  })

  it('propagates Credential Manager read failures instead of treating them as first install', () => {
    const failure = new Error('MCP_WINDOWS_CREDENTIAL_HELPER_INVALID')
    const identityStore = createWindowsInstallationIdentityStore({ runHelper: () => { throw failure } })
    expect(() => identityStore.load()).toThrow(failure)
    const receiptStore = createWindowsInstallationBindingStore({ runHelper: () => { throw failure } })
    expect(() => receiptStore.load()).toThrow(failure)
  })
})
