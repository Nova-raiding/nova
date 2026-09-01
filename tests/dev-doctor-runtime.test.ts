import { describe, expect, it } from 'vitest'
import { composeServiceHealth, parseComposeServiceStates, releaseReadiness } from '../scripts/dev-doctor-runtime.js'

describe('developer doctor runtime checks', () => {
  it('parses Docker Compose newline-delimited JSON', () => {
    const rows = parseComposeServiceStates([
      JSON.stringify({ Service: 'api', State: 'running', Health: 'healthy', Status: 'Up (healthy)' }),
      JSON.stringify({ Service: 'worker-generation', State: 'running', Health: 'unhealthy', Status: 'Up (unhealthy)' }),
    ].join('\n'))
    expect(composeServiceHealth(rows, 'api')).toEqual({ present: true, healthy: true, detail: 'Up (healthy)' })
    expect(composeServiceHealth(rows, 'worker-generation')).toEqual({ present: true, healthy: false, detail: 'Up (unhealthy)' })
  })

  it('accepts Compose JSON arrays and reports absent services', () => {
    const rows = parseComposeServiceStates(JSON.stringify([{ Service: 'api-replica', State: 'running', Health: 'healthy' }]))
    expect(composeServiceHealth(rows, 'api-replica')).toMatchObject({ present: true, healthy: true })
    expect(composeServiceHealth(rows, 'worker-sync')).toEqual({ present: false, healthy: false, detail: 'not running' })
  })

  it('fails closed on malformed Compose output', () => {
    expect(parseComposeServiceStates('{broken')).toEqual([])
  })

  it('reads release readiness from the API envelope', () => {
    expect(releaseReadiness({ data: { ready: false } })).toBe(false)
    expect(releaseReadiness({ ready: true })).toBe(true)
    expect(releaseReadiness({ data: {} })).toBeUndefined()
  })
})
