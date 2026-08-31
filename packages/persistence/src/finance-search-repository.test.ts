import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { SqlClient, SqlQueryResult } from './repository.js'
import { FinanceSearchAccessError, PostgresFinanceSearchRepository } from './finance-search-repository.js'

type Call = { text: string; values: readonly unknown[] }

class RecordingPool {
  readonly calls: Call[] = []
  constructor(private readonly responder: (text: string, values: readonly unknown[]) => unknown[] = () => []) {}
  async connect(): Promise<SqlClient> {
    return {
      query: async <Row>(text: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Row>> => {
        this.calls.push({ text, values })
        return { rows: this.responder(text, values) as Row[] }
      },
      release: () => undefined,
    }
  }
}

const summary = (overrides: Record<string, string> = {}) => ({
  total_records: '1', recharge_order_cny: '10', subscription_order_cny: '0', wallet_credit_cny: '0', wallet_debit_cny: '0',
  provider_cost_cny: '0', customer_charge_cny: '0', usage_units: '0', recharge_order_count: '1', wallet_transaction_count: '0',
  subscription_order_count: '0', usage_entry_count: '0', model_usage_count: '0', ...overrides,
})

const order = (workspaceId: string, id: string, occurredAt: string) => ({
  record_id: id, kind: 'recharge_order', sort_rank: 50, workspace_id: workspaceId, status: 'paid', label: '充值订单', reference: 'alipay',
  amount_cny: '10', direction: null, provider_cost_cny: null, customer_charge_cny: null, units: null,
  occurred_at: occurredAt, updated_at: occurredAt, attribute_name: '支付渠道', attribute_value: 'alipay',
})

describe('PostgresFinanceSearchRepository', () => {
  it('enforces finance authorized-workspace policy before issuing SQL', async () => {
    const pool = new RecordingPool()
    const repository = new PostgresFinanceSearchRepository(pool)
    await expect(repository.search({ role: 'finance', authorizedWorkspaceIds: ['ws_allowed'] }, { workspaceIds: ['ws_denied'], limit: 20 })).rejects.toBeInstanceOf(FinanceSearchAccessError)
    expect(pool.calls).toHaveLength(0)
  })

  it('uses platform scope only to enumerate workspaces and tenant-local RLS for every ledger read', async () => {
    const pool = new RecordingPool((text, values) => {
      if (text.includes('FROM workspaces')) return [{ id: 'ws_a' }, { id: 'ws_b' }]
      if (text.includes('SELECT record_id')) return [order(String(values[0]), `order_${values[0]}`, values[0] === 'ws_a' ? '2026-08-28T10:00:00.000Z' : '2026-08-28T09:00:00.000Z')]
      if (text.includes('SELECT count(*)')) return [summary()]
      return []
    })
    const repository = new PostgresFinanceSearchRepository(pool, () => new Date('2026-08-29T00:00:00.000Z'))
    const result = await repository.search({ role: 'platform_ops' }, { limit: 20 })
    expect(result.records.map(record => record.workspaceId)).toEqual(['ws_a', 'ws_b'])
    expect(result.scope).toEqual({ role: 'platform_ops', workspaceCount: 2 })
    expect(result.summary).toMatchObject({ totalRecords: 2, rechargeOrderCny: 20 })
    expect(pool.calls.filter(call => call.text.includes("set_config('app.platform_scope'"))).toHaveLength(1)
    expect(pool.calls.filter(call => call.text.includes("set_config('app.workspace_id'" )).map(call => call.values[0])).toEqual(['ws_a', 'ws_b'])
  })

  it('returns a filter-bound keyset cursor and never selects secret payment or relay fields', async () => {
    const pool = new RecordingPool((text, values) => {
      if (text.includes('SELECT record_id')) return [
        order('ws_a', 'order_2', '2026-08-28T10:00:00.000Z'),
        order('ws_a', 'order_1', '2026-08-28T09:00:00.000Z'),
      ]
      if (text.includes('SELECT count(*)')) return [summary({ total_records: '2', recharge_order_count: '2' })]
      return []
    })
    const repository = new PostgresFinanceSearchRepository(pool, () => new Date('2026-08-29T00:00:00.000Z'))
    const page = await repository.search({ role: 'finance', authorizedWorkspaceIds: ['ws_a'] }, { kinds: ['recharge_order'], text: 'order', limit: 1 })
    expect(page.records[0]).toMatchObject({ id: 'order_2', redacted: true })
    expect(page.nextCursor).toBeTruthy()
    const ledgerSql = pool.calls.find(call => call.text.includes('SELECT record_id'))?.text ?? ''
    expect(ledgerSql).not.toMatch(/payment_url|provider_trade_id|receipt_hash|metadata|last_error|idempotency_key/)

    await expect(repository.search({ role: 'finance', authorizedWorkspaceIds: ['ws_a'] }, { kinds: ['model_usage'], text: 'order', cursor: page.nextCursor, limit: 1 })).rejects.toMatchObject({ code: 'FINANCE_SEARCH_CURSOR_INVALID' })
  })

  it('validates an optimistic version without exposing mutable raw columns', async () => {
    const pool = new RecordingPool((text, values) => text.includes('SELECT record_id') ? [order(String(values[0]), 'order_1', '2026-08-28T09:00:00.000Z')] : [])
    const repository = new PostgresFinanceSearchRepository(pool, () => new Date('2026-08-29T00:00:00.000Z'))
    const detail = await repository.detail({ role: 'finance', authorizedWorkspaceIds: ['ws_a'] }, { workspaceId: 'ws_a', kind: 'recharge_order', id: 'order_1' })
    expect(detail?.attributes).toEqual({ 支付渠道: 'alipay' })
    const detailSql = pool.calls.find(call => call.text.includes('WHERE kind=$3'))?.text ?? ''
    expect(detailSql).not.toContain('updated_at <= $2')
    await expect(repository.detail({ role: 'finance', authorizedWorkspaceIds: ['ws_a'] }, { workspaceId: 'ws_a', kind: 'recharge_order', id: 'order_1', expectedVersion: 'stale' })).rejects.toMatchObject({ code: 'FINANCE_RECORD_VERSION_CONFLICT' })
  })

  it('bounds concurrent workspace transactions', async () => {
    let active = 0
    let maxActive = 0
    const calls: Call[] = []
    const pool = {
      calls,
      async connect(): Promise<SqlClient> {
        active += 1; maxActive = Math.max(maxActive, active)
        return {
          query: async <Row>(text: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Row>> => {
            calls.push({ text, values })
            if (text.includes('SELECT record_id')) await new Promise(resolve => setTimeout(resolve, 2))
            return { rows: [] }
          },
          release: () => { active -= 1 },
        }
      },
    }
    const repository = new PostgresFinanceSearchRepository(pool)
    await repository.search({ role: 'finance', authorizedWorkspaceIds: Array.from({ length: 24 }, (_, index) => `ws_${index}`) }, { limit: 20 })
    expect(maxActive).toBeLessThanOrEqual(8)
  })

  it('adds covering indexes only and does not duplicate financial facts', async () => {
    const sql = await readFile(new URL('./migrations/058_finance_search_indexes.sql', import.meta.url), 'utf8')
    expect(sql.match(/CREATE INDEX IF NOT EXISTS/g)).toHaveLength(5)
    expect(sql).not.toMatch(/CREATE TABLE|INSERT INTO|UPDATE |DELETE FROM|CREATE POLICY/i)
  })
})
