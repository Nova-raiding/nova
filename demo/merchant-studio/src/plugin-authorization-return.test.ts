import { describe, expect, it } from 'vitest'
import { pluginAuthorizationReturnPath } from './plugin-authorization-return'

describe('local plugin post-login return', () => {
  const authorization = '/v1/auth/local-plugin/authorize?client_id=local-desktop&response_type=code&state=once'

  it('returns only the same-origin plugin consent request', () => {
    expect(pluginAuthorizationReturnPath(`?plugin_authorize=${encodeURIComponent(authorization)}`)).toBe(authorization)
  })

  it.each([
    '',
    '?plugin_authorize=https%3A%2F%2Fevil.example',
    '?plugin_authorize=%2F%2Fevil.example',
    '?plugin_authorize=%2Fv1%2Fauth%2Flogin',
    '?plugin_authorize=%2Fv1%2Fauth%2Flocal-plugin%2Fauthorize%3Fclient_id%3Devil%26response_type%3Dcode%26state%3Donce',
    `?plugin_authorize=${encodeURIComponent(authorization)}&plugin_authorize=${encodeURIComponent(authorization)}`,
  ])('rejects an unrelated or ambiguous return target', search => {
    expect(pluginAuthorizationReturnPath(search)).toBeNull()
  })
})
