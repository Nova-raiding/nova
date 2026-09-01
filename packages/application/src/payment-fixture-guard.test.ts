import { describe, expect, it } from 'vitest'
import { isAuthenticPaymentResult, paymentFixturePolicy } from './payment-fixture-guard.js'

describe('payment fixture production guard', () => {
  it('allows an explicitly enabled fixture in local development', () => {
    expect(paymentFixturePolicy({ NODE_ENV: 'development', ALLOW_LOCAL_PAYMENT_FIXTURE: 'true' })).toEqual({
      fixtureAllowed: true,
      productionProviderRequired: false,
      reason: 'local_fixture_allowed',
    })
  })

  it('keeps test fixtures available without treating them as production evidence', () => {
    expect(paymentFixturePolicy({ NODE_ENV: 'test', ALLOW_LOCAL_PAYMENT_FIXTURE: 'true' }).fixtureAllowed).toBe(true)
    expect(isAuthenticPaymentResult({ environment: 'test', mode: 'fixture' })).toBe(true)
  })

  it('forbids fixtures in production even when the local opt-in is true', () => {
    expect(paymentFixturePolicy({ NODE_ENV: 'production', ALLOW_LOCAL_PAYMENT_FIXTURE: 'true' })).toEqual({
      fixtureAllowed: false,
      productionProviderRequired: true,
      reason: 'production_fixture_forbidden',
    })
    expect(isAuthenticPaymentResult({ environment: 'production', mode: 'fixture' })).toBe(false)
  })

  it('accepts only provider evidence as authentic production payment evidence', () => {
    expect(isAuthenticPaymentResult({ environment: 'production', mode: 'provider' })).toBe(true)
    expect(isAuthenticPaymentResult({ environment: 'production', mode: 'fixture' })).toBe(false)
  })

  it('does not enable a fixture implicitly in local environments', () => {
    expect(paymentFixturePolicy({ NODE_ENV: 'development' }).fixtureAllowed).toBe(false)
    expect(paymentFixturePolicy({ NODE_ENV: 'test' }).fixtureAllowed).toBe(false)
  })
})
