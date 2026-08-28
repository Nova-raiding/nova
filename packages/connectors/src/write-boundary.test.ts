import { describe, expect, it } from 'vitest'
import { platformWriteAllowed } from './write-boundary.js'

const base = { connectorConfigured: true, pluginWriteEnabled: true, canaryReady: true }

describe('platform write boundary', () => {
  it('rejects fixture writes in production even when the plugin flag is enabled', () => {
    expect(platformWriteAllowed({ ...base, production: true, fixtureMode: true })).toBe(false)
  })

  it('allows an explicitly enabled fixture write only outside production', () => {
    expect(platformWriteAllowed({ ...base, production: false, fixtureMode: true })).toBe(true)
    expect(platformWriteAllowed({ ...base, production: false, fixtureMode: true, pluginWriteEnabled: false })).toBe(false)
  })

  it('requires a production canary and a configured connector', () => {
    expect(platformWriteAllowed({ ...base, production: true, fixtureMode: false, canaryReady: false })).toBe(false)
    expect(platformWriteAllowed({ ...base, production: true, fixtureMode: false, connectorConfigured: false })).toBe(false)
    expect(platformWriteAllowed({ ...base, production: true, fixtureMode: false })).toBe(true)
  })
})
