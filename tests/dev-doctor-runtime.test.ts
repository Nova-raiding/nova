import { describe, expect, it } from 'vitest'
import { commercialRuntimeReadiness, composeServiceHealth, parseComposeServiceStates, releaseReadiness } from '../scripts/dev-doctor-runtime.js'

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

  it('reports commercial dependencies as blocked for fixture/local readiness without exposing configuration values', () => {
    expect(commercialRuntimeReadiness({ data: {
      writesEnabled: false,
      persistence: { ready: true },
      setup: {
        mode: 'fixture', productionGate: false,
        ai: { costGate: 'ready' },
        modelReadiness: Object.fromEntries(['text', 'image', 'image_edit', 'ocr', 'video'].map(name => [name, { ready: true }])),
        payment: { mode: 'fixture', configured: false, providerApiKey: 'must-not-be-returned' },
        objectStorage: { configured: true, mode: 'local', bucket: 'must-not-be-returned' },
        alertNotifications: { ready: false },
      },
    } })).toEqual({
      mode: 'fixture', writesEnabled: false, persistenceReady: true,
      paymentReady: false, paymentMode: 'fixture', modelRelayReady: false,
      objectStorageReady: false, objectStorageMode: 'local', scannerReady: false, alertReady: false, productionGate: false,
    })
  })

  it('recognizes a complete production commercial runtime contract', () => {
    expect(commercialRuntimeReadiness({ data: {
      writesEnabled: true,
      persistence: { ready: true },
      setup: {
        mode: 'production', productionGate: true,
        ai: { costGate: 'ready' },
        modelReadiness: Object.fromEntries(['text', 'image', 'image_edit', 'ocr', 'video'].map(name => [name, { ready: true }])),
        payment: { mode: 'provider', configured: true },
        objectStorage: { configured: true, mode: 's3' },
        assetScanner: { ready: true, mode: 'clamav_worker' },
        alertNotifications: { ready: true },
      },
    } })).toMatchObject({ paymentReady: true, modelRelayReady: true, objectStorageReady: true, scannerReady: true, productionGate: true })
    expect(commercialRuntimeReadiness({ data: {} })).toBeUndefined()
  })
})
