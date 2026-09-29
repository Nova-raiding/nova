import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
// @ts-ignore JavaScript runtime module
import { KEYCHAIN_SERVICE, installationIdentitySeed, installationIdentityStore, keychainHelperFailureReason, readKeychainCredential, writeKeychainCredential } from './keychain-credential.mjs'

const bound = { apiOrigin: 'https://merchant.example.test', workspaceId: 'ws_test' }

describe('macOS keychain credential', () => {
  it('authenticates the live native caller chain before Keychain access', () => {
    const source = readFileSync(new URL('./keychain-credential-helper.swift', import.meta.url), 'utf8')
    expect(source).toContain('SecCodeCopyGuestWithAttributes')
    expect(source).toContain('SecCodeCheckValidity')
    expect(source).toContain('kSecCSStrictValidate')
    expect(source).toContain('identifier == "com.openai.codex" && team == "2DC432GLL2"')
    expect(source).toContain('identifier == "com.storenova.connect-helper" && team == ownTeam')
    expect(source.indexOf('validSignedAncestor()')).toBeLessThan(source.indexOf('SecItemCopyMatching'))
    expect(source).not.toContain('ProcessInfo.processInfo.environment')
  })
  it('keeps only the OSStatus and operation from helper failures', () => {
    const result = { status: 1, stderr: 'keychain_osstatus=-25308 operation=read\naccess_token=never-print\n' }
    expect(keychainHelperFailureReason(result, 'read')).toBe('helper_exit=1')
    expect(keychainHelperFailureReason({ status: 1, stderr: 'keychain_osstatus=-25308 operation=read\n' }, 'read')).toBe('keychain_osstatus=-25308 operation=read')
    expect(keychainHelperFailureReason({ status: 1, stderr: 'keychain_osstatus=-25308 operation=write\n' }, 'read')).toBe('helper_exit=1')
    expect(keychainHelperFailureReason({ status: null, error: { code: 'ETIMEDOUT' }, stderr: '' }, 'read')).toBe('helper_timeout operation=read')
  })
  it('fails closed when the native helper caller has no accepted signed ancestor', () => {
    const bundle = { schema_version: '1', api_origin: bound.apiOrigin, workspace_id: bound.workspaceId,
      access_token: 'access-secret', refresh_token: 'refresh-secret', expires_at: '2030-01-01T00:00:00Z' }
    if (process.platform === 'darwin' && existsSync(new URL('./keychain-credential-helper', import.meta.url))) {
      expect(() => readKeychainCredential(bound)).toThrow('MCP_KEYCHAIN_HELPER_INVALID: helper_exit=1')
      expect(() => writeKeychainCredential(bound, bundle)).toThrow('MCP_KEYCHAIN_HELPER_INVALID: helper_exit=1')
    } else {
      expect(() => readKeychainCredential(bound)).toThrow('MCP_KEYCHAIN_HELPER_INVALID')
      expect(() => writeKeychainCredential(bound, bundle)).toThrow('MCP_KEYCHAIN_HELPER_INVALID')
    }
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
  it('creates a stable QA broker seed for the installation identity without mixing workspace credentials', () => {
    const owner = { accountId: 'account_123', workspaceId: bound.workspaceId }
    const identity = { schema_version: '1', installation_id: '11111111-1111-4111-8111-111111111111', private: 'secret' }
    const first = installationIdentitySeed(bound.apiOrigin, owner, identity)
    const second = installationIdentitySeed(bound.apiOrigin, owner, identity)
    expect(first).toEqual(second)
    expect(first.account).toMatch(/^[a-f0-9]{64}$/u)
    expect(JSON.parse(first.data)).toEqual(identity)
    expect(first.account).not.toBe('ea40339f1e0c40eb0650c2fe65a43e7f151bc536fde5113da0865b988ad6a37d')
  })
})
