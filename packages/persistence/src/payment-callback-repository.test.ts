import { describe, expect, it } from 'vitest'
import { MemoryPaymentCallbackNonceRepository, PostgresPaymentCallbackNonceRepository } from './payment-callback-repository.js'
import type { SqlClient, SqlPool } from './repository.js'

class Client implements SqlClient {
  readonly calls: string[] = []
  constructor(private readonly insertCount: number, private readonly existingPayloadHash = proof.payloadHash) {}
  async query<Row = Record<string, unknown>>(text: string) {
    this.calls.push(text)
    if (text.includes('SELECT payload_hash FROM payment_callback_nonces')) return { rows: [{ payload_hash: this.existingPayloadHash }] as Row[], rowCount: 1 }
    return { rows: [] as Row[], rowCount: text.includes('INSERT INTO payment_callback_nonces') ? this.insertCount : 0 }
  }
  release() {}
}
class Pool implements SqlPool { constructor(readonly client: Client) {} async connect() { return this.client } }
const proof = { workspaceId: 'ws_payment', channel: 'wechat' as const, nonce: 'nonce_1234567890abcdef', signedAt: '2026-08-28T12:00:00.000Z', payloadHash: 'a'.repeat(64) }

describe('payment callback nonce repositories', () => {
  it('classifies memory nonce replays by the signed payload hash', async () => {
    const repository = new MemoryPaymentCallbackNonceRepository()
    await expect(repository.consume(proof)).resolves.toBe(true)
    await expect(repository.consume(proof)).resolves.toBe(false)
    await expect(repository.replayPayloadMatches(proof)).resolves.toBe(true)
    await expect(repository.replayPayloadMatches({ ...proof, payloadHash: 'b'.repeat(64) })).resolves.toBe(false)
  })

  it.each([[1, true], [0, false]] as const)('reports postgres insert count %i as consumed=%s', async (count, consumed) => {
    const client = new Client(count)
    await expect(new PostgresPaymentCallbackNonceRepository(new Pool(client)).consume(proof)).resolves.toBe(consumed)
    expect(client.calls.some(sql => sql.includes("interval '7 days'"))).toBe(true)
    expect(client.calls.at(-1)).toBe('COMMIT')
  })

  it('checks whether a postgres nonce replay matches the original signed payload hash', async () => {
    const matching = new Client(0)
    await expect(new PostgresPaymentCallbackNonceRepository(new Pool(matching)).replayPayloadMatches(proof)).resolves.toBe(true)
    expect(matching.calls.some(sql => sql.includes('SELECT payload_hash FROM payment_callback_nonces'))).toBe(true)
    const conflicting = new Client(0, 'b'.repeat(64))
    await expect(new PostgresPaymentCallbackNonceRepository(new Pool(conflicting)).replayPayloadMatches(proof)).resolves.toBe(false)
    expect(conflicting.calls.some(sql => sql.includes('SELECT payload_hash FROM payment_callback_nonces'))).toBe(true)
  })
})
