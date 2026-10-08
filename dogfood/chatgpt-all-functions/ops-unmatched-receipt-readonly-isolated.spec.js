import { expect, test } from '@playwright/test'
import { join } from 'node:path'

const baseUrl = process.env.OPS_BASE_URL
const token = process.env.OPS_E2E_UNMATCHED_READONLY_TOKEN
const tradeId = process.env.OPS_E2E_UNMATCHED_TRADE_ID
const outputDir = process.env.OPS_E2E_OUTPUT_DIR
if (!baseUrl || !token || !tradeId || !outputDir) throw new Error('Run only through the isolated unmatched-receipt Ops runner')
const origin = new URL(baseUrl)
if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || !origin.port || origin.pathname !== '/') throw new Error('OPS_BASE_URL must be an explicit loopback origin')

test.describe.configure({ mode: 'serial', retries: 0 })
test.use({ channel: 'chrome', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 900 }, trace: 'off', video: 'off', screenshot: 'off' })

async function rpc(page, method, params = {}) {
  return page.evaluate(async ({ rpcMethod, rpcParams, bearer }) => {
    const response = await fetch('/api/mcp', {
      method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'x-ops-workbench': 'platform', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: `unmatched-readonly-${rpcMethod}`, method: rpcMethod, params: rpcParams }),
    })
    return { status: response.status, body: await response.json() }
  }, { rpcMethod: method, rpcParams: params, bearer: token })
}

function resultOf(body) { return body?.result ?? body?.data?.result }

test('platform order reader sees real unmatched cash but cannot record or match it', async ({ page }) => {
  await page.addInitScript(({ bearer }) => {
    localStorage.setItem('ops_connection_config_v1', JSON.stringify({ apiBase: '/api', workspaceId: '', actorId: '', token: bearer, workbench: 'platform' }))
  }, { bearer: token })

  await page.goto(`${baseUrl}/ops/finance?workbench=platform`)
  const sessionResponse = await rpc(page, 'ops.session')
  expect(sessionResponse.status).toBe(200)
  const sessionBody = sessionResponse.body
  const session = resultOf(sessionBody)
  expect(session?.workbench).toBe('platform')
  expect(session?.capabilities).toContain('commercial.order.read')
  expect(session?.capabilities).not.toContain('commercial.receipt.record')
  expect(session?.denied_capabilities).toContain('commercial.receipt.record')

  const queue = page.getByRole('region', { name: '全局待匹配真实收款' })
  await expect(queue.getByRole('heading', { name: '全局待匹配银行收款' })).toBeVisible()
  await expect(page.getByText('部分运营数据未刷新', { exact: true })).toHaveCount(0)
  const refresh = queue.getByRole('button', { name: '从首页读取待匹配收款' })
  await refresh.click()
  await expect(queue.getByText(tradeId, { exact: true })).toBeVisible()
  await expect(queue.getByRole('button', { name: '预览待匹配到账事实' })).toBeDisabled()
  await expect(queue.getByRole('button', { name: '预览匹配并核对归属' })).toBeDisabled()
  await expect(queue.getByRole('button', { name: '查询核对真实客户' })).toBeDisabled()
  await page.screenshot({ path: join(outputDir, 'unmatched-receipt-readonly.png'), fullPage: true })

  const recordResponse = await rpc(page, 'ops.commercial.receipt.unmatched.record', {
    source: 'bank_transfer', receiving_account_ref: 'denied-fixture-receiver', external_trade_id: `denied-${tradeId}`,
    payer_ref: 'denied-fixture-payer', amount_fen: '1', currency: 'CNY',
    received_at: new Date(Date.now() - 60_000).toISOString(), evidence_json: JSON.stringify({ fixtureOnly: true }), reason: 'authorization boundary regression',
  })
  const recordBody = recordResponse.body
  expect(recordResponse.status, JSON.stringify(recordBody)).toBe(403)
  expect(recordBody?.error?.code).toBe('FORBIDDEN')

  const matchResponse = await rpc(page, 'ops.commercial.receipt.unmatched.match', {
    receipt_id: `not-used-${tradeId}`, target_workspace_id: 'not-used-workspace', reason: 'authorization boundary regression',
    evidence_json: JSON.stringify({ fixtureOnly: true }),
  })
  expect(matchResponse.status).toBe(403)
  expect(matchResponse.body?.error?.code).toBe('FORBIDDEN')

  const listResponse = await rpc(page, 'ops.commercial.receipt.unmatched.list')
  expect(listResponse.status).toBe(200)
  const rows = resultOf(listResponse.body)?.items
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ externalTradeId: tradeId, workspaceId: null, amountFen: 12345, allocatedFen: 0, returnedFen: 0, frozenReturnFen: 0 })
})
