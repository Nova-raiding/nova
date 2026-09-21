import { describe, expect, it } from 'vitest'
// @ts-ignore JavaScript runtime module
import { KEYCHAIN_SERVICE, readKeychainCredential, writeKeychainCredential } from './keychain-credential.mjs'

const bound = { apiOrigin: 'https://merchant.example.test', workspaceId: 'ws_test' }

describe('macOS keychain credential', () => {
  it('writes one atomic JSON item without placing secrets in argv', async () => {
    let call: Record<string, string> | undefined
    writeKeychainCredential(bound, { schema_version: '1', api_origin: bound.apiOrigin, workspace_id: bound.workspaceId, access_token: 'access-secret', refresh_token: 'refresh-secret', expires_at: '2030-01-01T00:00:00Z' }, {
      runHelper: (request: Record<string, string>) => { call = request; return '' },
    })
    expect(call).toMatchObject({ operation: 'write', service: KEYCHAIN_SERVICE, account: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    if (!call?.data) throw new Error('helper write request did not include credential data')
    expect(JSON.parse(call.data)).toEqual({ schema_version: '1', api_origin: bound.apiOrigin, workspace_id: bound.workspaceId, access_token: 'access-secret', refresh_token: 'refresh-secret', expires_at: '2030-01-01T00:00:00Z' })
  })

  it('reads only the exact origin/workspace-bound record', async () => {
    const record = { schema_version: '1', api_origin: bound.apiOrigin, workspace_id: bound.workspaceId, access_token: 'a', refresh_token: 'r', expires_at: '2030-01-01T00:00:00Z' }
    const read = readKeychainCredential(bound, { runHelper: () => JSON.stringify(record) })
    expect(read).toEqual(record)
    expect(() => readKeychainCredential(bound, { runHelper: () => JSON.stringify({ ...record, workspace_id: 'ws_other' }) })).toThrow('MCP_KEYCHAIN_CREDENTIAL_INVALID')
    expect(() => readKeychainCredential(bound, { runHelper: () => '{bad' })).toThrow('MCP_KEYCHAIN_CREDENTIAL_INVALID')
  })

  it('derives a stable account from origin and workspace and changes it across either boundary', async () => {
    const accounts: string[] = []
    const capture = (request: Record<string, string>) => {
      if (!request.account) throw new Error('helper request did not include an account')
      accounts.push(request.account)
      return ''
    }
    for (const value of [bound, { ...bound, workspaceId: 'ws_other' }, { ...bound, apiOrigin: 'https://other.example.test' }]) {
      writeKeychainCredential(value, { schema_version: '1', api_origin: value.apiOrigin, workspace_id: value.workspaceId, access_token: 'a', refresh_token: 'r', expires_at: '2030-01-01T00:00:00Z' }, { runHelper: capture })
    }
    expect(new Set(accounts).size).toBe(3)
  })
})
