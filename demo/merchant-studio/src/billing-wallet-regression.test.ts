import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { formatAmountCny, rechargeAmountFen, resolveRechargeIdempotency } from './App'

const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')
const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

/** apps/api/src/server.ts `parseCnyToFen`: anything else is BILLING_AMOUNT_INVALID. */
const BILLING_AMOUNT = /^\d{1,8}(?:\.\d{1,2})?$/u

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

  it('shows the creative-point balance and a recharge credited in the read wallet page', () => {
    expect(app).toContain('当前剩余创意点')
    expect(app).toContain('财务与资源')
    expect(app).toContain('充值创意点')
    expect(app).toContain('支付完成后由服务端回调或查单入账，未支付不会增加权益或创意点。')
    expect(app).toContain("billing?.transactions.find((item) => item.type === 'recharge')")
    expect(app).toContain('最近已入账充值（最近读取的 20 条钱包流水）')
    expect(app).toContain('充值订单：')
    expect(styles).toContain('.finance-balance-card')
  })

  it('keeps payment and manual publishing in the merchant workspace without enabling automatic platform writes', () => {
    expect(api).toContain("requestMcp<ApiPage<ManualPublishRecord> | ManualPublishRecord[]>(baseUrl, 'publish.manual.list'")
    expect(app).toContain('fetchManualPublishRecords(baseUrl)')
    expect(app).toContain('六平台由人工执行发布')
    expect(app).toContain('不会自动提交平台')
    expect(app).toContain("manual_publish_reported: '已回填平台结果'")
  })
})

describe('Merchant Studio recharge order safety', () => {
  // Regression: the payable amount was `String(priceCny * quantity)` on a price
  // decoded from the catalogue's `price_label`. Binary residue produced values
  // such as 299.70000000000005, which the API rejects as BILLING_AMOUNT_INVALID,
  // so that quantity could not be bought at all.
  it('charges in fen so the amount never carries more than two decimals', () => {
    for (const [priceCny, quantity, expected] of [
      [99.9, 3, '299.70'],
      [19.9, 3, '59.70'],
      [299.9, 3, '899.70'],
      [123.45, 1, '123.45'],
      [1200, 1, '1200.00'],
      [2000, 99, '198000.00'],
    ] as const) {
      const formatted = formatAmountCny(rechargeAmountFen(priceCny, quantity))
      expect(formatted, `${priceCny} x ${quantity}`).toBe(expected)
      expect(BILLING_AMOUNT.test(formatted), `server rejects ${formatted}`).toBe(true)
    }
    // The float expression this replaced, kept as the failing example.
    expect(String(99.9 * 3)).toBe('299.70000000000005')
    expect(BILLING_AMOUNT.test(String(99.9 * 3))).toBe(false)
    expect(app).not.toContain('String(selectedPackage.priceCny * purchaseQuantity)')
  })

  // Regression: the idempotency key carried a `Date.now()` suffix, so every
  // attempt was a new key, the server's dedupe could never match, and a retry
  // after the client-side timeout created a second payable recharge order.
  it('keeps one idempotency key per purchase intent across retries', () => {
    const intent = 'pack_credits_5k|299.70|alipay|3'
    const first = resolveRechargeIdempotency(intent, { intent: '', key: '' })
    expect(first.key).toContain(intent)
    // The retry after a timeout must reach the order the server already made.
    expect(resolveRechargeIdempotency(intent, first)).toEqual(first)
    // A genuinely different purchase must not be collapsed into that order.
    for (const changed of ['pack_credits_5k|299.70|alipay|4', 'pack_credits_5k|59.70|alipay|3', 'pack_credits_5k|299.70|wechat|3', 'pack_credits_20k|299.70|alipay|3']) {
      const next = resolveRechargeIdempotency(changed, first)
      expect(next.key, changed).not.toBe(first.key)
      expect(next.intent).toBe(changed)
    }
    const createRecharge = api.slice(api.indexOf('export const createRechargeOrder'), api.indexOf('export const fetchRechargeOrder'))
    expect(createRecharge).toContain('idempotency_key: idempotencyKey')
    expect(createRecharge, 'a per-attempt key defeats the server dedupe').not.toContain('Date.now()')
    expect(app).toContain('createRechargeOrder(baseUrl, amount, paymentMethod, idempotencyKey)')
  })
})
