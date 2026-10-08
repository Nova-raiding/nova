import { describe, expect, it } from 'vitest'
import { canConfirmCommercialOrder } from './CommercialPurchaseCenter'
import { normalizeCommercialPurchaseOrder } from './api'

const pendingOrder = (cycle: unknown) => normalizeCommercialPurchaseOrder({
  order_id: 'order-cycle-check',
  sku_code: 'basic',
  sku_version_id: 'version-2',
  status: 'pending',
  amount_fen: 200000,
  currency: 'CNY',
  expires_at: '2099-01-01T00:00:00.000Z',
  snapshot: { quantity: 1, cycle, benefits: [{ code: 'monthly_creative_points', quantity: 5000 }] },
})

describe('commercial purchase confirmation requires a readable frozen cycle', () => {
  // Regression: invalid frozen periods were accepted for payment confirmation even though
  // the checkout rendered them as “周期未确认”. Found by /qa on 2026-10-08.
  it.each([null, 'annual-ish', { unit: 'month', count: 0 }, { unit: 'week', count: 1 }])(
    'blocks an unrecognized frozen cycle (%s) before payment confirmation',
    cycle => {
      expect(canConfirmCommercialOrder(pendingOrder(cycle))).toBe(false)
    },
  )

  it.each([
    { unit: 'month', count: 1 },
    { unit: 'day', count: 30 },
    { unit: 'once' },
    'monthly',
    'once',
  ])('allows supported frozen cycle %s', cycle => {
    expect(canConfirmCommercialOrder(pendingOrder(cycle))).toBe(true)
  })
})
