import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const script = 'infra/scripts/verify-ecs-oss-runtime.mjs'
const production = { error: null, data: { status: 'ok', writesEnabled: true, setup: { mode: 'production', objectStorage: { configured: true, mode: 's3_compatible' } } } }

function verify(payload: unknown) {
  return execFileSync('node', [script], { input: JSON.stringify(payload), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
}

describe('ECS OSS runtime contract', () => {
  it('accepts a real production-mode cloud storage health report', () => {
    expect(verify(production)).toContain('contract passed')
  })

  it.each([
    ['fixture mode', (value: typeof production) => { value.data.setup.mode = 'fixture' }],
    ['local storage', (value: typeof production) => { value.data.setup.objectStorage.mode = 'local' }],
    ['storage unavailable', (value: typeof production) => { value.data.setup.objectStorage.configured = false }],
    ['writes disabled', (value: typeof production) => { value.data.writesEnabled = false }],
  ])('rejects %s even when health status is ok', (_, mutate) => {
    const payload = structuredClone(production)
    mutate(payload)
    expect(() => verify(payload)).toThrow()
  })

  it('rejects a failed response envelope even if nested diagnostics claim ok', () => {
    expect(() => verify({ ...production, ok: false })).toThrow()
  })

  it.each([
    ['string false', 'false'],
    ['numeric truthy', 1],
  ])('rejects a %s success marker even if nested diagnostics claim ok', (_, ok) => {
    const payload: Record<string, unknown> = structuredClone(production)
    payload.ok = ok
    expect(() => verify(payload)).toThrow(/healthz envelope success marker is invalid/)
  })

  it('rejects an API error envelope when nested diagnostics claim success', () => {
    expect(() => verify({ ...production, error: { code: 'DATABASE_UNAVAILABLE' } })).toThrow()
  })
})
