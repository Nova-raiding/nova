import { requireWorkspaceScope, type SqlPool, withWorkspaceTransaction } from './repository.js'

export interface PaymentCallbackNonceRepository {
  consume(input: { workspaceId: string; channel: 'alipay' | 'wechat'; nonce: string; signedAt: string; payloadHash: string }): Promise<boolean>
  replayPayloadMatches?(input: { workspaceId: string; channel: 'alipay' | 'wechat'; nonce: string; payloadHash: string }): Promise<boolean>
}

export class MemoryPaymentCallbackNonceRepository implements PaymentCallbackNonceRepository {
  private readonly consumed = new Map<string, string>()
  async consume(input: { workspaceId: string; channel: 'alipay' | 'wechat'; nonce: string; signedAt: string; payloadHash: string }) {
    const key = `${requireWorkspaceScope(input.workspaceId)}:${input.channel}:${input.nonce}`
    if (this.consumed.has(key)) return false
    this.consumed.set(key, input.payloadHash)
    return true
  }
  async replayPayloadMatches(input: { workspaceId: string; channel: 'alipay' | 'wechat'; nonce: string; payloadHash: string }) {
    const key = `${requireWorkspaceScope(input.workspaceId)}:${input.channel}:${input.nonce}`
    return this.consumed.get(key) === input.payloadHash
  }
}

export class PostgresPaymentCallbackNonceRepository implements PaymentCallbackNonceRepository {
  constructor(private readonly pool: SqlPool) {}
  async consume(input: { workspaceId: string; channel: 'alipay' | 'wechat'; nonce: string; signedAt: string; payloadHash: string }) {
    return withWorkspaceTransaction(this.pool, requireWorkspaceScope(input.workspaceId), async client => {
      await client.query(`DELETE FROM payment_callback_nonces WHERE workspace_id=$1 AND received_at < now() - interval '7 days'`, [input.workspaceId])
      const result = await client.query(
        `INSERT INTO payment_callback_nonces (workspace_id,channel,nonce,signed_at,payload_hash)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (workspace_id,channel,nonce) DO NOTHING`,
        [input.workspaceId, input.channel, input.nonce, input.signedAt, input.payloadHash],
      )
      return result.rowCount === 1
    })
  }

  async replayPayloadMatches(input: { workspaceId: string; channel: 'alipay' | 'wechat'; nonce: string; payloadHash: string }) {
    return withWorkspaceTransaction(this.pool, requireWorkspaceScope(input.workspaceId), async client => {
      const existing = await client.query<{ payload_hash: string }>(
        'SELECT payload_hash FROM payment_callback_nonces WHERE workspace_id=$1 AND channel=$2 AND nonce=$3',
        [input.workspaceId, input.channel, input.nonce],
      )
      return existing.rows[0]?.payload_hash === input.payloadHash
    })
  }
}
