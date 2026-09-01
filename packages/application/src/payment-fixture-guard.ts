/**
 * Payment fixture policy shared by payment adapters and their callers.
 *
 * A fixture can be useful in local development, but it is never evidence of
 * a real payment in production. Keep this decision pure so callers cannot
 * accidentally infer production success from ALLOW_LOCAL_PAYMENT_FIXTURE.
 */
export type PaymentEnvironment = 'development' | 'test' | 'production' | string | undefined

export type PaymentResultMode = 'fixture' | 'provider'

export interface PaymentFixturePolicy {
  fixtureAllowed: boolean
  productionProviderRequired: boolean
  reason: 'local_fixture_allowed' | 'production_fixture_forbidden'
}

export interface PaymentResultAuthenticityInput {
  environment: PaymentEnvironment
  mode: PaymentResultMode
}

export function paymentFixturePolicy(source: {
  NODE_ENV?: PaymentEnvironment
  ALLOW_LOCAL_PAYMENT_FIXTURE?: string
} = process.env): PaymentFixturePolicy {
  if (source.NODE_ENV === 'production') {
    return {
      fixtureAllowed: false,
      productionProviderRequired: true,
      reason: 'production_fixture_forbidden',
    }
  }

  return {
    fixtureAllowed: source.ALLOW_LOCAL_PAYMENT_FIXTURE === 'true',
    productionProviderRequired: false,
    reason: 'local_fixture_allowed',
  }
}

/** Returns whether a payment result can be treated as real payment evidence. */
export function isAuthenticPaymentResult(input: PaymentResultAuthenticityInput): boolean {
  return input.mode === 'provider' || input.environment !== 'production'
}
