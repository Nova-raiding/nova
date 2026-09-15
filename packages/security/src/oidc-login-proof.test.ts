import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { bindOidcDisplayLoginProof, encodeOidcDisplayLogin } from './oidc-login-proof.js'

const legacy = ['POST', '/mcp?a=1&b=2', 'ws', 'workspace', 'https://issuer.test', 'subject', 'sid', 'operator', 'mfa', '1', '2', '3', 'digest', 'nonce'].join('\n')

describe('signed OIDC display metadata', () => {
  it('leaves an extension-free legacy proof byte-for-byte unchanged', () => {
    expect(bindOidcDisplayLoginProof(legacy, undefined, undefined)).toEqual({ canonical: legacy })
  })
  it.each(['ops@example.com', '运营账号@example.com', 'Jose\u0301', 'José', '用户🙂', 'a'.repeat(256), '界'.repeat(170)])('preserves valid provider text without Unicode normalization (%s)', login => {
    const encoded = encodeOidcDisplayLogin(login)
    expect(bindOidcDisplayLoginProof(legacy, '2', encoded)).toEqual({ canonical: ['oidc-v2', legacy, encoded].join('\n'), displayAccountLogin: login })
  })
  it.each(['', ' ', ' ops', 'ops ', '\tops', 'ops\nname', 'ops\u0000name', 'ops\u007fname', 'ops\u0085name', 'ops\u202ename', 'ops\u200bname', 'ops\u2028name', 'ops\u2029name', 'a'.repeat(257), '界'.repeat(171)])('rejects ambiguous or oversized display text (%j)', login => {
    expect(() => encodeOidcDisplayLogin(login)).toThrow('OIDC_DISPLAY_LOGIN_INVALID')
    expect(() => bindOidcDisplayLoginProof(legacy, '2', Buffer.from(login).toString('base64url'))).toThrow('OIDC_DISPLAY_LOGIN_INVALID')
  })
  it('rejects unpaired surrogates before a lossy UTF-8 encoding can replace them', () => {
    expect(() => encodeOidcDisplayLogin('\ud800')).toThrow('OIDC_DISPLAY_LOGIN_INVALID')
  })
  it.each([
    [undefined, 'b3Bz'], ['2', undefined], ['1', 'b3Bz'], ['3', 'b3Bz'], ['', 'b3Bz'], [' 2', 'b3Bz'],
    [null, null], [['2', '2'], 'b3Bz'], ['2', ['b3Bz']], ['2', ''], ['2', 'b3Bz='], ['2', ' b3Bz'],
    ['2', 'YQ=='], ['2', 'YR'], ['2', 'a'], ['2', '////'], ['2', '_w'], ['2', 'wK8'], ['2', '7aCA'],
    ['2', 'b3Bz,b3Bz'], ['2', 'Y'.repeat(684)],
  ])('rejects malformed or partial extension version=%j login=%j', (version, encoded) => {
    expect(() => bindOidcDisplayLoginProof(legacy, version, encoded)).toThrow('OIDC_DISPLAY_LOGIN_INVALID')
  })
  it('signs the display login and prevents a stripped-header downgrade', () => {
    const mac = (canonical: string) => createHmac('sha256', 'unit-test-only-key').update(canonical).digest('hex')
    const first = bindOidcDisplayLoginProof(legacy, '2', encodeOidcDisplayLogin('ops-a'))
    const second = bindOidcDisplayLoginProof(legacy, '2', encodeOidcDisplayLogin('ops-b'))
    expect(mac(first.canonical)).not.toBe(mac(second.canonical))
    expect(mac(first.canonical)).not.toBe(mac(legacy))
  })
})
