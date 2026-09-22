import { describe, expect, it } from 'vitest'
// @ts-expect-error Native Node helper module intentionally has no build step.
import { parseConnectUrl } from './connect-local-macos.mjs'

describe('Store Nova custom protocol helper', () => {
  const valid = 'storenova://connect?api_origin=https%3A%2F%2Fyxsona.com&workspace=ws_guirenniaoniao&request_id=req_1234567890abcdef'

  it('accepts only the non-secret one-time connection metadata', () => {
    expect(parseConnectUrl(valid)).toEqual({ baseUrl: 'https://yxsona.com', workspaceId: 'ws_guirenniaoniao', requestId: 'req_1234567890abcdef' })
  })

  it.each([
    `${valid}&token=secret`, `${valid}&password=secret`, `${valid}&code=secret`,
    valid.replace('storenova://connect', 'https://connect'),
    valid.replace('request_id=req_1234567890abcdef', 'request_id=short'),
    valid.replace('https%3A%2F%2Fyxsona.com', 'not-a-url'),
    `${valid}&workspace=ws_other`,
    valid.replace('https%3A%2F%2Fyxsona.com', 'https%3A%2F%2Fu%3Ap%40yxsona.com'),
  ])('fails closed for unsafe or ambiguous URL %s', value => {
    expect(() => parseConnectUrl(value)).toThrow(/^LOCAL_PLUGIN_CONNECT_/u)
  })
})
