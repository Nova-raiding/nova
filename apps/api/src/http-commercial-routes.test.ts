import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { handleHttpCommercialRoute, type HttpCommercialRouteDependencies } from './http-commercial-routes.js'
import { handleCommercialMcpMethod, type CommercialMcpDependencies } from './mcp-commercial-handlers.js'
import { DomainError } from '../../../packages/application/src/service.js'

function fixture(input: Record<string, unknown> = {}) {
  const req = { method: 'GET', headers: {} } as IncomingMessage
  const res = {} as ServerResponse
  const callCommercialMethod = vi.fn(async () => ({ actual: 'shared-handler-response' }))
  const send = vi.fn()
  const deps: HttpCommercialRouteDependencies = {
    commercialAccessService: { decide: vi.fn() },
    commercialPurchaseService: { create: vi.fn(), paymentStatus: vi.fn() },
    callCommercialMethod, resolveWorkspace: () => 'trusted-workspace', requestActor: () => 'trusted-actor',
    body: async () => input,
    required: (params, key) => { if (typeof params[key] !== 'string' || !params[key]) throw new DomainError('INVALID_REQUEST', 'missing', 400); return params[key] as string },
    rethrowCommercialPurchaseError: error => { throw error }, send,
  }
  const route = (method: string, path: string) => {
    req.method = method
    const url = new URL(path, 'http://localhost')
    return handleHttpCommercialRoute(req, res, url.pathname, url, deps)
  }
  return { req, res, deps, route, send, callCommercialMethod }
}

describe('HTTP commercial shared-handler routes', () => {
  it.each([
    ['/v1/commercial/catalog', 'commercial.catalog.get', {}],
    ['/v1/commercial/subscription', 'commercial.subscription.get', {}],
    ['/v1/commercial/notifications?limit=100', 'commercial.notifications.list', { limit: '100' }],
    ['/v1/commercial/upgrade-quotes/quote-1', 'commercial.upgrade.quote.get', { upgrade_quote_id: 'quote-1' }],
    ['/v1/commercial/order-requests/request-001', 'commercial.order.request.get', { idempotency_key: 'request-001' }],
    ['/v1/commercial/upgrade-quote-requests/request-001', 'commercial.upgrade.quote.request.get', { idempotency_key: 'request-001' }],
    ['/v1/commercial/checkout-requests/request-001', 'commercial.checkout.request.get', { idempotency_key: 'request-001' }],
    ['/v1/commercial/orders/order-1/payment', 'commercial.order.payment.get', { order_id: 'order-1' }],
  ])('maps %s to its exact authorized MCP operation', async (path, method, params) => {
    const f = fixture()
    expect(await f.route('GET', path)).toBe(true)
    expect(f.callCommercialMethod).toHaveBeenCalledWith(method, params, 'trusted-workspace', f.req)
    expect(f.send).toHaveBeenCalledWith(f.res, 200, 'trusted-workspace', { actual: 'shared-handler-response' }, null, f.req)
  })

  it.each([
    ['/v1/commercial/upgrade-quotes', 'commercial.upgrade.quote.create', { target_sku_code: 'growth', idempotency_key: 'quote-001' }],
    ['/v1/commercial/checkouts', 'commercial.checkout.create', { onboarding_sku_code: 'opening', subscription_sku_code: 'basic', idempotency_key: 'checkout-001', reason: '首购套餐' }],
    ['/v1/commercial/orders', 'commercial.order.create', { purchase_kind: 'upgrade', sku_code: 'growth', upgrade_quote_id: 'quote-1', idempotency_key: 'order-001', reason: '升级套餐' }],
  ])('uses server business logic for POST %s', async (path, method, params) => {
    const f = fixture(params)
    expect(await f.route('POST', path)).toBe(true)
    expect(f.callCommercialMethod).toHaveBeenCalledWith(method, params, 'trusted-workspace', f.req)
    expect(f.send.mock.calls[0]?.[1]).toBe(201)
    expect(f.deps.commercialPurchaseService.create).not.toHaveBeenCalled()
  })

  it('requests payment only through the explicit confirmation endpoint bound to its path order', async () => {
    const f = fixture({ idempotency_key: 'payment-001' })
    await f.route('POST', '/v1/commercial/orders/order-1/checkout')
    expect(f.callCommercialMethod).toHaveBeenCalledWith('commercial.order.payment.create', { order_id: 'order-1', idempotency_key: 'payment-001' }, 'trusted-workspace', f.req)
    const injected = fixture({ order_id: 'foreign', idempotency_key: 'payment-001' })
    await expect(injected.route('POST', '/v1/commercial/orders/order-1/checkout')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(injected.callCommercialMethod).not.toHaveBeenCalled()
  })

  it('rejects old full-price upgrades and client-owned price or scope before any write', async () => {
    const base = { purchase_kind: 'upgrade', sku_code: 'growth', idempotency_key: 'order-001', reason: '升级套餐' }
    for (const input of [base, { ...base, upgrade_quote_id: 'quote-1', amount_fen: 1 }, { ...base, upgrade_quote_id: 'quote-1', actor_id: 'foreign' }, { ...base, upgrade_quote_id: 'quote-1', workspace_id: 'foreign' }]) {
      const f = fixture(input)
      await expect(f.route('POST', '/v1/commercial/orders')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      expect(f.callCommercialMethod).not.toHaveBeenCalled()
      expect(f.deps.commercialPurchaseService.create).not.toHaveBeenCalled()
    }
  })

  it.each(['/v1/commercial/notifications?limit=101', '/v1/commercial/notifications?limit=10&limit=20', '/v1/commercial/catalog?actor_id=foreign', '/v1/commercial/upgrade-quotes/%ZZ'])('rejects invalid query or path %s', async path => {
    const f = fixture()
    await expect(f.route('GET', path)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(f.callCommercialMethod).not.toHaveBeenCalled()
  })

  it('marks only the path notification through trusted request membership', async () => {
    const f = fixture({ idempotency_key: 'read-key-001' })
    await f.route('POST', '/v1/commercial/notifications/result%3Aevent%3Amember/read')
    expect(f.callCommercialMethod).toHaveBeenCalledWith('commercial.notifications.mark-read', { notification_id: 'result:event:member', idempotency_key: 'read-key-001' }, 'trusted-workspace', f.req)
    for (const injection of [{ member_id: 'foreign' }, { workspace_id: 'foreign' }, { notification_id: 'foreign' }, { read_at: '2026-01-01T00:00:00Z' }]) {
      const bad = fixture({ idempotency_key: 'read-key-001', ...injection })
      await expect(bad.route('POST', '/v1/commercial/notifications/owned/read')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      expect(bad.callCommercialMethod).not.toHaveBeenCalled()
    }
  })
  it('preserves statement provenance through the same MCP projection', async () => {
    const f = fixture()
    f.deps.creativePoints = { listStatement: vi.fn(), getBalance: vi.fn() }
    await f.route('GET', '/v1/creative-points/statement?limit=20')
    expect(f.callCommercialMethod).toHaveBeenCalledWith('creative-points.statement.list', { limit: '20' }, 'trusted-workspace', f.req)
    expect(f.deps.creativePoints.listStatement).not.toHaveBeenCalled()
  })
  it('fails closed when the shared adapter is missing', async () => {
    const f = fixture()
    delete f.deps.callCommercialMethod
    await expect(f.route('GET', '/v1/commercial/catalog')).rejects.toMatchObject({ code: 'COMMERCIAL_HTTP_ADAPTER_UNAVAILABLE', status: 503 })
  })

  it('uses the actual shared catalog filtering and permits an empty catalog', async () => {
    const f = fixture()
    const sell = { saleState: 'on_sale', currentSaleVersionId: 'v1', versionId: 'v1', lifecycle: 'approved', executable: true }
    let rows: unknown[] = [sell, { ...sell, saleState: 'off_sale' }, { ...sell, lifecycle: 'draft' }, { ...sell, versionId: 'old' }]
    const deps = { ready: Promise.resolve(), persistence: { commercialCatalog: { list: async () => rows } } } as unknown as CommercialMcpDependencies
    f.deps.callCommercialMethod = (method, params, workspace, req) => handleCommercialMcpMethod(method, params, workspace, req, deps)
    await f.route('GET', '/v1/commercial/catalog')
    expect(f.send.mock.calls[0]?.[3]).toMatchObject({ status: 'available', catalog: [sell] })
    rows = []
    await f.route('GET', '/v1/commercial/catalog')
    expect(f.send.mock.calls[1]?.[3]).toMatchObject({ status: 'available', catalog: [] })
  })
})
