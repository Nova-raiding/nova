import { describe, expect, it } from 'vitest'
// @ts-expect-error Native helper module intentionally has no TS build step.
import { createWindowsInstallationIdentityStore, readWindowsCredential, writeWindowsCredential } from './windows-credential.mjs'

const target = { apiOrigin: 'https://yxsona.com', workspaceId: 'ws_test' }
const bundle = { schema_version: '1', api_origin: target.apiOrigin, workspace_id: target.workspaceId,
  access_token: 'access-secret', refresh_token: 'refresh-secret', expires_at: '2027-01-01T00:00:00.000Z' }

describe('Windows Credential Manager bridge', () => {
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
