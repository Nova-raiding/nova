import type { Pool, QueryResult } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { PostgresAlertReceiptStore } from './postgres-store.js'

const queryResult = (rows: Record<string, unknown>[]): QueryResult<Record<string, unknown>> => ({
  command: 'SELECT',
  rowCount: rows.length,
  oid: 0,
  fields: [],
  rows,
})

const input = {
  alertId: 'alert-1',
  requestId: 'request-1',
  receivedAt: '2026-09-14T08:00:00.000Z',
  sentAt: '2026-09-14T07:59:59.000Z',
  bodySha256: 'a'.repeat(64),
  body: { type: 'merchant.operation_alert', alert: { id: 'alert-1' } },
}

describe('PostgresAlertReceiptStore', () => {
  it('checks readiness only through the restricted database function', async () => {
    const query = vi.fn().mockResolvedValue(queryResult([{ ready: true }]))
    const store = new PostgresAlertReceiptStore({ query } as unknown as Pick<Pool, 'query'>)

    await expect(store.health()).resolves.toBeUndefined()
    expect(query).toHaveBeenCalledWith('SELECT public.alert_webhook_receipts_ready() AS ready')
    expect(query.mock.calls[0]?.[0]).not.toMatch(/\bFROM\s+alert_webhook_receipts\b/iu)
  })

  it.each<[string, Record<string, unknown>[]]>([
    ['no result', []],
    ['false result', [{ ready: false }]],
    ['malformed result', [{ ready: 'true' }]],
    ['multiple results', [{ ready: true }, { ready: true }]],
  ])('fails closed when readiness returns %s', async (_name, rows) => {
    const query = vi.fn().mockResolvedValue(queryResult(rows))
    const store = new PostgresAlertReceiptStore({ query } as unknown as Pick<Pool, 'query'>)

    await expect(store.health()).rejects.toThrow('alert receipt database role is not ready')
  })

  it.each([
    [true, 'accepted'],
    [false, 'replay'],
  ] as const)('maps append result %s to %s without direct table access', async (accepted, expected) => {
    const query = vi.fn().mockResolvedValue(queryResult([{ accepted }]))
    const store = new PostgresAlertReceiptStore({ query } as unknown as Pick<Pool, 'query'>)

    await expect(store.append(input)).resolves.toBe(expected)
    const [statement, values] = query.mock.calls[0] ?? []
    expect(statement).toContain('public.append_alert_webhook_receipt')
    expect(statement).not.toMatch(/\bINSERT\s+INTO\b/iu)
    expect(values).toEqual([
      input.alertId,
      input.requestId,
      input.receivedAt,
      input.sentAt,
      input.bodySha256,
      JSON.stringify(input.body),
    ])
  })

  it.each<[string, Record<string, unknown>[]]>([
    ['no result', []],
    ['null result', [{ accepted: null }]],
    ['malformed result', [{ accepted: 1 }]],
    ['multiple results', [{ accepted: true }, { accepted: false }]],
  ])('fails closed when append returns %s', async (_name, rows) => {
    const query = vi.fn().mockResolvedValue(queryResult(rows))
    const store = new PostgresAlertReceiptStore({ query } as unknown as Pick<Pool, 'query'>)

    await expect(store.append(input)).rejects.toThrow('alert receipt database returned an invalid append result')
  })
})
