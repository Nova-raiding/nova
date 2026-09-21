import { describe, expect, it } from 'vitest'
// @ts-ignore JavaScript runtime module
import { validatedRotatedCredential } from './managed-token.mjs'

const context = { workspaceId: 'ws_test', apiOrigin: 'https://merchant.example.test', now: 1_800_000_000_000 }
const complete = { access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', scope: 'merchant', workspace_id: 'ws_test', expires_in: 3600 }

describe('keychain bridge rotation contract', () => {
  it('accepts the complete keychain response and derives a bound ISO expiry', () => {
    expect(validatedRotatedCredential(complete, { ...context, tokenSource: 'keychain' })).toEqual({
      accessToken: 'access', refreshToken: 'refresh', expiresAt: '2027-01-15T09:00:00.000Z',
      bundle: { schema_version: '1', api_origin: context.apiOrigin, workspace_id: context.workspaceId, access_token: 'access', refresh_token: 'refresh', expires_at: '2027-01-15T09:00:00.000Z' },
    })
  })

  it.each(['workspace_id', 'token_type', 'scope', 'expires_in'] as const)('requires %s for keychain persistence', field => {
    const response: Partial<typeof complete> = { ...complete }
    delete response[field]
    expect(validatedRotatedCredential(response, { ...context, tokenSource: 'keychain' })).toBeNull()
  })

  it('keeps legacy environment and launchd responses compatible but rejects supplied scope drift', () => {
    const legacy = { access_token: 'access', refresh_token: 'refresh' }
    expect(validatedRotatedCredential(legacy, { ...context, tokenSource: 'environment' })).toMatchObject({ accessToken: 'access', expiresAt: '' })
    expect(validatedRotatedCredential(legacy, { ...context, tokenSource: 'launchd' })).toMatchObject({ refreshToken: 'refresh', expiresAt: '' })
    expect(validatedRotatedCredential({ ...legacy, workspace_id: 'ws_other' }, { ...context, tokenSource: 'environment' })).toBeNull()
    expect(validatedRotatedCredential({ ...legacy, scope: 'operator' }, { ...context, tokenSource: 'launchd' })).toBeNull()
  })
})
