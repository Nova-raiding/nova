import { describe, expect, it } from 'vitest'
// @ts-ignore JavaScript runtime module
import { KEYCHAIN_SERVICE, installationIdentityStore, keychainHelperFailureReason, readKeychainCredential, writeKeychainCredential } from './keychain-credential.mjs'

const bound = { apiOrigin: 'https://merchant.example.test', workspaceId: 'ws_test' }

describe('macOS keychain credential', () => {
  it('keeps only the OSStatus and operation from helper failures', () => {
    const result = { status: 1, stderr: 'keychain_osstatus=-25308 operation=read\naccess_token=never-print\n' }
    expect(keychainHelperFailureReason(result, 'read')).toBe('helper_exit=1')
    expect(keychainHelperFailureReason({ status: 1, stderr: 'keychain_osstatus=-25308 operation=read\n' }, 'read')).toBe('keychain_osstatus=-25308 operation=read')
    expect(keychainHelperFailureReason({ status: 1, stderr: 'keychain_osstatus=-25308 operation=write\n' }, 'read')).toBe('helper_exit=1')
    expect(keychainHelperFailureReason({ status: null, error: { code: 'ETIMEDOUT' }, stderr: '' }, 'read')).toBe('helper_timeout operation=read')
  })
  it('bounds a GUI Keychain prompt and fails closed when the helper times out', () => {
    let timeout: number | undefined
    let argv: string[] | undefined
    const spawnHelper = (_path: string, args: string[], options: { timeout: number }) => {
      timeout = options.timeout
      argv = args
      return { status: null, error: { code: 'ETIMEDOUT' }, stderr: '', stdout: '' }
    }
    expect(() => readKeychainCredential(bound, { spawnHelper })).toThrow('MCP_KEYCHAIN_HELPER_INVALID: helper_timeout operation=read')
    expect(timeout).toBe(8_000)
    expect(argv).toEqual([])
  })
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

  it('keeps the installation identity separate and refuses a broken optional read', () => {
    const calls: Array<Record<string, string>> = []
    const owner = { accountId: 'account_123', workspaceId: bound.workspaceId }
    const store = installationIdentityStore(bound.apiOrigin, owner, { runHelper: (request: Record<string, string>) => {
      calls.push(request)
      return request.operation === 'read_optional' ? 'null' : ''
    } })
    expect(store.load()).toBeUndefined()
    store.save({ installation_id: '11111111-1111-4111-8111-111111111111' })
    expect(calls.map(call => call.operation)).toEqual(['read_optional', 'write'])
    expect(calls[0]!.account).toBe(calls[1]!.account)
    expect(() => installationIdentityStore(bound.apiOrigin, owner, { runHelper: () => { throw new Error('Keychain denied') } }).load()).toThrow('Keychain denied')
    expect(() => installationIdentityStore(bound.apiOrigin, owner, { runHelper: () => '{broken' }).load()).toThrow()
    const other = installationIdentityStore(bound.apiOrigin, { accountId: 'account_other', workspaceId: bound.workspaceId },
      { runHelper: (request: Record<string, string>) => { calls.push(request); return 'null' } })
    other.load()
    expect(calls.at(-1)!.account).not.toBe(calls[0]!.account)
  })
})
