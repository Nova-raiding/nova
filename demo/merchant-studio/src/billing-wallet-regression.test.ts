import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')
const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

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
    expect(app).toContain('当前剩余创意点')
    expect(app).toContain('财务与资源')
    expect(app).toContain('充值创意点')
    expect(app).toContain('支付完成后由服务端回调或查单入账，未支付不会增加创意点。')
    expect(app).toContain('充值订单：')
    expect(styles).toContain('.finance-balance-card')
  })
})
