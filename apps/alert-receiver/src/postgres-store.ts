import type { Pool } from 'pg'
import type { AlertReceiptStore } from './receiver.js'

export class PostgresAlertReceiptStore implements AlertReceiptStore {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}
  async health() {
    const result = await this.pool.query<{ ready: boolean }>(
      'SELECT public.alert_webhook_receipts_ready() AS ready',
    )
    if (result.rows.length !== 1 || result.rows[0]?.ready !== true) {
      throw new Error('alert receipt database role is not ready')
    }
  }

  async append(input: Parameters<AlertReceiptStore['append']>[0]) {
    const result = await this.pool.query<{ accepted: boolean }>(
      `SELECT public.append_alert_webhook_receipt(
         $1::text,
         $2::text,
         $3::timestamptz,
         $4::timestamptz,
         $5::text,
         $6::jsonb
       ) AS accepted`,
      [input.alertId, input.requestId, input.receivedAt, input.sentAt, input.bodySha256, JSON.stringify(input.body)],
    )
    if (result.rows.length !== 1 || typeof result.rows[0]?.accepted !== 'boolean') {
      throw new Error('alert receipt database returned an invalid append result')
    }
    return result.rows[0].accepted ? 'accepted' as const : 'replay' as const
  }
}
