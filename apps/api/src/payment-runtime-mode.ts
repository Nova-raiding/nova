/** Shared runtime classification; manual receipts are never fixture payments. */
export function paymentRuntimeMode(source: NodeJS.ProcessEnv = process.env): 'provider' | 'manual_transfer' | 'fixture' {
  const value = source.PAYMENT_MODE?.trim().toLowerCase()
  if (value === 'provider') return 'provider'
  if (value === 'manual_transfer' || source.COMMERCIAL_PAYMENT_PROVIDER?.trim().toLowerCase() === 'manual_transfer') return 'manual_transfer'
  return 'fixture'
}
