import { describe, expect, it, vi } from 'vitest'
import { handleCommercialReceiptMethod } from './mcp-commercial-receipts.js'

function fixture() {
  const receipts = {
    findReceiptByExternalIdentity: vi.fn(async (_scope: string | null, _actor: string, _identity: unknown): Promise<unknown> => null),
    getReturnByRequestId: vi.fn(async (_scope: string | null, _actor: string, _id: string): Promise<unknown> => null),
    getAllocationByIdempotencyKey: vi.fn(async (_scope: string, _key: string): Promise<unknown> => null),
    proposeUnmatchedReturn: vi.fn(async (input: unknown) => input),
  }
  const deps = {
    receipts, contracts: {}, actorId: 'verified-operator',
    required: (params: Record<string, unknown>, key: string) => {
      if (typeof params[key] !== 'string' || !params[key]) throw new Error(`missing ${key}`)
      return params[key]
    },
    object: (params: Record<string, unknown>, key: string) => params[key], fulfill: vi.fn(),
  } as unknown as Parameters<typeof handleCommercialReceiptMethod>[2]
  return { receipts, deps }
}

describe('original cash intent recovery', () => {
  it('uses authenticated actor and bank identity; missing facts remain null', async () => {
    const f = fixture()
    const identity = { source: 'bank_transfer', receiving_account_ref: 'approved-account', external_trade_id: 'bank-trade' }
    expect(await handleCommercialReceiptMethod('ops.commercial.receipt.request.get', identity, f.deps)).toBeNull()
    expect(f.receipts.findReceiptByExternalIdentity).toHaveBeenCalledWith(null, 'verified-operator', {
      source: 'bank_transfer', receivingAccountRef: 'approved-account', externalTradeId: 'bank-trade',
    })
    await handleCommercialReceiptMethod('ops.commercial.receipt.request.get', { ...identity, target_workspace_id: 'ws-one' }, f.deps)
    expect(f.receipts.findReceiptByExternalIdentity).toHaveBeenLastCalledWith('ws-one', 'verified-operator', expect.any(Object))
  })
  it('does not expose an allocation recorded by another actor', async () => {
    const f = fixture()
    f.receipts.getAllocationByIdempotencyKey.mockResolvedValueOnce({ actorId: 'other-operator', result: { orderId: 'private-order' } })
    expect(await handleCommercialReceiptMethod('ops.commercial.receipt.allocation.request.get', { target_workspace_id: 'ws-one', idempotency_key: 'original-key' }, f.deps)).toBeNull()
    f.receipts.getAllocationByIdempotencyKey.mockResolvedValueOnce({ actorId: 'verified-operator', result: { orderId: 'original-order' } })
    expect(await handleCommercialReceiptMethod('ops.commercial.receipt.allocation.request.get', { target_workspace_id: 'ws-one', idempotency_key: 'original-key' }, f.deps)).toMatchObject({ allocation: { orderId: 'original-order' }, replayed: true })
  })
  it('queries unmatched return intent without creating a workspace or sending money', async () => {
    const f = fixture()
    expect(await handleCommercialReceiptMethod('ops.commercial.receipt.return.request.get', { return_id: 'return-original' }, f.deps)).toBeNull()
    expect(f.receipts.getReturnByRequestId).toHaveBeenCalledWith(null, 'verified-operator', 'return-original')
    expect(f.receipts.proposeUnmatchedReturn).not.toHaveBeenCalled()
  })
  it('keeps unmatched returns outside a fictitious tenant and forwards frozen source facts', async () => {
    const f = fixture()
    const input = { receipt_id: 'receipt', return_id: 'return', amount_fen: 500, payer_ref: 'payer', expected_revision: 1, reason: '真实未匹配款返还', evidence_json: {} }
    await expect(handleCommercialReceiptMethod('ops.commercial.receipt.unmatched.return.propose', { ...input, target_workspace_id: 'fake' }, f.deps)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(f.receipts.proposeUnmatchedReturn).not.toHaveBeenCalled()
    await handleCommercialReceiptMethod('ops.commercial.receipt.unmatched.return.propose', input, f.deps)
    expect(f.receipts.proposeUnmatchedReturn).toHaveBeenCalledWith(expect.objectContaining({ receiptId: 'receipt', amountFen: 500, actorId: 'verified-operator' }))
    expect(f.receipts.proposeUnmatchedReturn.mock.calls[0]![0]).not.toHaveProperty('workspaceId')
  })
})
