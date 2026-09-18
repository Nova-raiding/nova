import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')
const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

describe('Merchant Studio paid wallet projection', () => {
  // Regression: ISSUE-001 — a valid recharge and creative-point grant were
  // hidden because the UI used the subscription-gated billing.status method.
  // Found by /qa on 2026-09-18.
  // Report: .gstack/qa-reports/qa-report-yxsona-com-2026-09-18.md
  it('reads wallet money and creative points from their canonical ledgers', () => {
    const implementation = api.slice(api.indexOf('export async function fetchBillingStatus'), api.indexOf('export const fetchCommercialCatalog'))
    expect(implementation).toContain("'creative-points.balance.get'")
    expect(implementation).toContain("'billing.transactions'")
    expect(implementation).not.toContain("'billing.status'")
  })

  it('shows both the creative-point balance and the latest verified recharge', () => {
    expect(app).toContain('可用创意点')
    expect(app).toContain('人民币钱包')
    expect(app).toContain('最近充值')
    expect(app).toContain('到账状态')
    expect(app).toContain('订单号：')
  })
})
