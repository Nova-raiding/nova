import { describe, expect, it } from 'vitest'
import { requiresCustomerDeliveryAccess as required } from './customer-delivery-access.js'
import { getMcpMethodPolicy } from './authz.js'
import { MCP_OPS_CONTROL_METHODS } from './commercial-operation-registry.js'
import { validateMcpRequest } from './mcp.js'

describe('single-account delivery operation boundary', () => {
  it.each(['catalog.search', 'task.create', 'asset.list', 'asset.upload', 'asset.scan', 'brand.get', 'rule.list', 'knowledge.search', 'platform.mapping.preflight', 'workspace.interactive.confirm', 'workspace.commercial.update', 'delivery.bundle.verify', 'support.customer.replies.list', 'unknown.method', 'ops.unknown'])('gates actual business and unknown method %s', method => {
    expect(required('MCP', method)).toBe(true)
  })
  it.each(['workspace.bootstrap', 'workspace.invitations.list', 'workspace.invitation.accept', 'workspace.health', 'onboarding.status', 'platform.model.status', 'platform.connect', 'platform.revoke', 'platform.store.list', 'commercial.access.get', 'commercial.catalog.get', 'commercial.order.create', 'commercial.order.payment.get', 'creative-points.balance.get', 'creative-points.statement.list'])('preserves exact recovery %s', method => {
    expect(required('MCP', method)).toBe(false)
  })
  it('does not classify business intent as a harmless startup read', () => {
    expect(required('MCP', 'merchant.start')).toBe(false)
    for (const key of ['requested_platform', 'requested_goal', 'attachment_count']) for (const value of ['', '0', undefined, '1']) expect(required('MCP', 'merchant.start', { [key]: value })).toBe(true)
    expect(required('MCP', 'merchant.first_value', { example: 'true' })).toBe(false)
    for (const example of [undefined, true, 'false', 'TRUE']) expect(required('MCP', 'merchant.first_value', { example })).toBe(true)
  })
  it('maps HTTP via the authoritative registry rather than a path prefix', () => {
    expect(required('MCP', 'ops.session')).toBe(false)
    expect(required('HTTP', 'http:GET:/v1/products')).toBe(true)
    expect(required('HTTP', 'http:GET:/v1/assets/{assetId}/download')).toBe(true)
    expect(required('HTTP', 'http:GET:/v1/commercial/access')).toBe(false)
    expect(required('HTTP', 'http:GET:/v1/delivery-readiness')).toBe(false)
    expect(required('HTTP', 'http:POST:/v1/internal/assets/{assetId}/scan-result')).toBe(false)
    expect(required('HTTP', 'http:GET:/v1/ops/unregistered')).toBe(true)
  })
  it.each(['ops.customer-delivery.accounts.list', 'ops.customer-delivery.account.bind'] as const)('registers %s as platform control, not merchant bypass', method => {
    expect(getMcpMethodPolicy(method)).toMatchObject({ scope: 'platform', workbench: 'platform' })
    expect(MCP_OPS_CONTROL_METHODS).toContain(method)
    expect(required('MCP', method)).toBe(false)
  })
  const validate = (method: string, params: Record<string, unknown>) => validateMcpRequest({ jsonrpc: '2.0', id: 'binding', method, params }).valid
  it('bounds account listing and rejects inferred workspace / unbounded pages', () => {
    expect(validate('ops.customer-delivery.accounts.list', { target_workspace_id: 'w', limit: '50' })).toBe(true)
    for (const limit of ['0', '51', '1.5', '100', '01']) expect(validate('ops.customer-delivery.accounts.list', { target_workspace_id: 'w', limit })).toBe(false)
    expect(validate('ops.customer-delivery.accounts.list', { workspace_id: 'w' })).toBe(false)
  })
  it('requires explicit immutable binding, current revision and audited reason', () => {
    const params = { target_workspace_id: 'w', delivery_id: 'd', target_account_id: 'a', expected_revision: '1', reason: '已核对账号' }
    expect(validate('ops.customer-delivery.account.bind', params)).toBe(true)
    for (const key of Object.keys(params)) expect(validate('ops.customer-delivery.account.bind', Object.fromEntries(Object.entries(params).filter(([field]) => field !== key)))).toBe(false)
    for (const extra of [{ target_identity_id: 'spoof' }, { enabled: 'true' }, { points: '100' }]) expect(validate('ops.customer-delivery.account.bind', { ...params, ...extra })).toBe(false)
    expect(validate('ops.customer-delivery.account.bind', { ...params, reason: 'ok' })).toBe(false)
  })
})
