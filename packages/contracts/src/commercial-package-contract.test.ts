import { describe, expect, it } from 'vitest'
import { validateMcpRequest } from './mcp.js'
import { getMcpMethodPolicy } from './authz.js'
import { MCP_RECOVERY_ENABLED_METHODS } from './commercial-operation-registry.js'

const request = (method: string, params: Record<string, string>) => ({ jsonrpc: '2.0', id: 'contract-check', method, params })

describe('versioned package contracts', () => {
  it('rejects legacy full-price upgrade intent and client price injection', () => {
    const base = { purchase_kind: 'upgrade', sku_code: 'plan_growth', idempotency_key: 'upgrade-1', reason: '商家升级套餐' }
    expect(validateMcpRequest(request('commercial.order.create', base)).valid).toBe(false)
    expect(validateMcpRequest(request('commercial.order.create', { ...base, upgrade_quote_id: 'quote-1' })).valid).toBe(true)
    expect(validateMcpRequest(request('commercial.order.create', { ...base, upgrade_quote_id: 'quote-1', amount_fen: '1' })).valid).toBe(false)
  })

  it('requires a revision for every catalog lifecycle mutation and accepts the creation revision zero', () => {
    const base = { action: 'create', code: 'basic', idempotency_key: 'catalog-1', reason: '运营创建套餐', evidence_json: '{}' }
    expect(validateMcpRequest(request('ops.commercial.catalog-v2.mutate', base)).valid).toBe(false)
    expect(validateMcpRequest(request('ops.commercial.catalog-v2.mutate', { ...base, expected_revision: '0' })).valid).toBe(true)
    expect(validateMcpRequest(request('ops.commercial.catalog-v2.mutate', { ...base, expected_revision: '-1' })).valid).toBe(false)
  })

  it('authorizes approval without requiring draft capability and separates publishing', () => {
    for (const method of ['ops.commercial.catalog-v2.mutate', 'ops.commercial.benefit-bundles.mutate']) {
      const approve = getMcpMethodPolicy(method, { action: 'approve' })!
      expect(approve.capability).toBe('commercial.catalog.approve')
      expect(getMcpMethodPolicy(method, { action: 'reject' })?.capability).toBe('commercial.catalog.approve')
      expect(getMcpMethodPolicy(method, { action: 'delete_draft' })?.capability).toBe('commercial.catalog.draft')
      expect(getMcpMethodPolicy(method, { action: 'unknown' })?.capability).toBe('commercial.catalog.draft')
    }
    expect(getMcpMethodPolicy('ops.commercial.catalog-v2.mutate', { action: 'publish' })?.capability).toBe('commercial.catalog.publish')
  })

  it('keeps benefit bundle activation tied to SKU sale instead of advertising an unsupported publish action', () => {
    const bundle = { action: 'publish', code: 'starter-benefits', expected_revision: '1', idempotency_key: 'bundle-publish-1', reason: '发布权益包', evidence_json: '{}' }
    const sku = { ...bundle, code: 'starter', price_fen: '200000' }
    expect(validateMcpRequest(request('ops.commercial.benefit-bundles.mutate', bundle)).valid).toBe(false)
    expect(validateMcpRequest(request('ops.commercial.catalog-v2.mutate', sku)).valid).toBe(true)
  })

  it('scopes notification backlog reads and audited redrive to explicit operations workspaces', () => {
    const target = { target_workspace_id: 'ws-1' }
    expect(validateMcpRequest(request('ops.commercial.notifications.purchase-results.list', target)).valid).toBe(true)
    expect(validateMcpRequest(request('ops.commercial.notifications.purchase-results.list', {})).valid).toBe(false)
    const redrive = { ...target, event_id: '00000000-0000-0000-0000-000000000001', idempotency_key: 'redrive-command-1', reason: '恢复通知投递' }
    expect(validateMcpRequest(request('ops.commercial.notifications.purchase-results.redrive', redrive)).valid).toBe(true)
    expect(validateMcpRequest(request('ops.commercial.notifications.purchase-results.redrive', { event_id: redrive.event_id, idempotency_key: redrive.idempotency_key, reason: redrive.reason })).valid).toBe(false)
    expect(getMcpMethodPolicy('ops.commercial.notifications.purchase-results.list')?.capability).toBe('commercial.order.read')
    expect(getMcpMethodPolicy('ops.commercial.notifications.purchase-results.redrive')?.capability).toBe('commercial.payment.reconcile')
  })

  it('validates atomic checkout intent without client amounts and actor-scoped recovery keys', () => {
    const checkout = { onboarding_sku_code: 'onboarding', subscription_sku_code: 'basic', idempotency_key: 'checkout-001', reason: '首次购买套餐' }
    expect(validateMcpRequest(request('commercial.checkout.create', checkout)).valid).toBe(true)
    expect(validateMcpRequest(request('commercial.checkout.create', { ...checkout, amount_fen: '1' })).valid).toBe(false)
    for (const method of ['commercial.order.request.get', 'commercial.upgrade.quote.request.get']) {
      expect(validateMcpRequest(request(method, { idempotency_key: 'request-001' })).valid).toBe(true)
      expect(validateMcpRequest(request(method, { actor_id: 'foreign', idempotency_key: 'request-001' })).valid).toBe(false)
      expect(getMcpMethodPolicy(method)?.effect).toBe('read')
    }
  })

  it('rejects empty, oversized or client-injected batch cash allocations', () => {
    const item = { receipt_id: 'receipt-1', order_id: 'order-1', amount_fen: 100, expected_revision: 0 }
    const preview = (items: unknown) => request('ops.commercial.receipt.allocations.preview', { target_workspace_id: 'ws-1', allocations_json: JSON.stringify(items) })
    expect(validateMcpRequest(preview([item])).valid).toBe(true)
    expect(validateMcpRequest(preview([])).valid).toBe(false)
    expect(validateMcpRequest(preview(Array.from({ length: 101 }, () => item))).valid).toBe(false)
    for (const invalid of [{ ...item, workspace_id: 'foreign' }, { ...item, amount_fen: -1 }, { ...item, amount_fen: 1.5 }, { ...item, expected_revision: -1 }]) expect(validateMcpRequest(preview([invalid])).valid).toBe(false)
    expect(validateMcpRequest(request('ops.commercial.receipt.allocations.confirm', { target_workspace_id: 'ws-1', allocations_json: JSON.stringify([item]), idempotency_key: 'allocation-001' })).valid).toBe(false)
    expect(validateMcpRequest(request('ops.commercial.receipt.allocations.confirm', { target_workspace_id: 'ws-1', allocations_json: JSON.stringify([item]), idempotency_key: 'allocation-001', preview_hash: 'server-preview-1' })).valid).toBe(true)
    expect(getMcpMethodPolicy('ops.commercial.receipt.allocations.confirm')?.capability).toBe('commercial.receipt.allocate')
  })

  it('recovers factual cash requests without accepting caller identity or a fake unmatched workspace', () => {
    const receipt = { source: 'bank', receiving_account_ref: 'receiver-1', external_trade_id: 'bank-transfer-1' }
    expect(validateMcpRequest(request('ops.commercial.receipt.request.get', receipt)).valid).toBe(true)
    expect(validateMcpRequest(request('ops.commercial.receipt.request.get', { ...receipt, actor_id: 'other' })).valid).toBe(false)
    const propose = { receipt_id: 'receipt-1', return_id: 'return-1', amount_fen: '100', payer_ref: 'payer-1', expected_revision: '0', reason: '返还未匹配款', evidence_json: '{}' }
    expect(validateMcpRequest(request('ops.commercial.receipt.unmatched.return.propose', propose)).valid).toBe(true)
    expect(validateMcpRequest(request('ops.commercial.receipt.unmatched.return.propose', { ...propose, target_workspace_id: 'pretend-workspace' })).valid).toBe(false)
    expect(getMcpMethodPolicy('ops.commercial.receipt.unmatched.return.propose')?.capability).toBe('commercial.receipt.return.propose')
    expect(getMcpMethodPolicy('ops.commercial.receipt.unmatched.return.decide')?.capability).toBe('commercial.receipt.return.approve')
    expect(getMcpMethodPolicy('ops.commercial.receipt.unmatched.return.complete')?.capability).toBe('commercial.receipt.return.complete')
    expect(validateMcpRequest(request('ops.commercial.receipt.unmatched.return.complete', { return_id: 'return-1', outcome: 'completed', evidence_json: '{}' })).valid).toBe(false)
  })

  it('bounds reads and registers exact safe recovery methods instead of a prefix', () => {
    for (const method of ['commercial.notifications.list', 'ops.commercial.benefit-bundles.list', 'ops.commercial.benefit-definitions.list']) {
      expect(validateMcpRequest(request(method, { limit: '100' })).valid).toBe(true)
      expect(validateMcpRequest(request(method, { limit: '101' })).valid).toBe(false)
    }
    expect(MCP_RECOVERY_ENABLED_METHODS).toEqual(expect.arrayContaining(['commercial.upgrade.quote.create', 'commercial.upgrade.quote.get', 'commercial.subscription.get', 'commercial.notifications.list']))
    expect(MCP_RECOVERY_ENABLED_METHODS).not.toContain('commercial.*')
  })
})
