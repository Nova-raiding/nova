import { describe, expect, it } from 'vitest'
import { localPluginConnectUrl } from '../demo/merchant-studio/src/LocalPluginConnection.js'
// @ts-expect-error The native helper is shipped as ESM without generated declarations.
import { parseConnectUrl } from '../apps/plugin/scripts/connect-local-macos.mjs'

describe('local plugin one-click launch contract', () => {
  it('round-trips the browser launch URL through the installed helper', () => {
    const launchUrl = localPluginConnectUrl(
      'https://yxsona.com/api',
      ['ws_guirenniaoniao'],
      'req_1234567890abcdef',
    )

    expect(launchUrl).not.toBeNull()
    expect(parseConnectUrl(launchUrl!)).toEqual({
      baseUrl: 'https://yxsona.com',
      workspaceId: 'ws_guirenniaoniao',
      requestId: 'req_1234567890abcdef',
    })
    expect(launchUrl).not.toMatch(/access_token|refresh_token|password|code=|request_secret/u)
  })

  it('fails closed when a launch changes workspace or adds credential material', () => {
    const launchUrl = localPluginConnectUrl(
      'https://yxsona.com/api',
      ['ws_guirenniaoniao'],
      'req_1234567890abcdef',
    )!

    expect(() => parseConnectUrl(`${launchUrl}&workspace=ws_other`)).toThrow(/^LOCAL_PLUGIN_CONNECT_/u)
    expect(() => parseConnectUrl(`${launchUrl}&token=secret`)).toThrow(/^LOCAL_PLUGIN_CONNECT_/u)
  })
})
