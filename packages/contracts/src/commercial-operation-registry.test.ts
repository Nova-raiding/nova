import { describe, expect, it } from 'vitest'
import {
  CAPABILITIES,
  COMMERCIAL_OPERATION_REGISTRY,
  COMMERCIAL_OPERATION_REGISTRY_CHECKSUM,
  COMMERCIAL_OPERATION_REGISTRY_COVERAGE,
  COMMERCIAL_OPERATION_RUNTIME_MANIFEST,
  HTTP_OPERATION_POLICIES,
  MCP_METHOD_SCHEMAS,
  MCP_LEGACY_OPS_COMMERCIAL_DISABLED_METHODS,
  MCP_METHODS,
  MCP_OPS_CONTROL_METHODS,
  MCP_POINT_CHARGED_DISABLED_METHODS,
  MCP_POINT_CHARGED_ENABLED_METHODS,
  MCP_RECOVERY_DISABLED_METHODS,
  MCP_RECOVERY_ENABLED_METHODS,
  ROLE_CAPABILITIES,
  assertCommercialOperationRegistryTotality,
  getMcpMethodPolicy,
  resolveCommercialOperation,
} from './index.js'

const resolveMcp = (operation: string) => resolveCommercialOperation(COMMERCIAL_OPERATION_REGISTRY, { surface: 'MCP', operation })
const resolveHttp = (operation: string) => resolveCommercialOperation(COMMERCIAL_OPERATION_REGISTRY, { surface: 'HTTP', operation })

describe('complete commercial operation registry E1 totality', () => {
  it('classifies every current MCP and HTTP operation exactly once', () => {
    expect(COMMERCIAL_OPERATION_REGISTRY_COVERAGE).toEqual({
      registered: MCP_METHODS.length + HTTP_OPERATION_POLICIES.length,
      manifest_operations: MCP_METHODS.length + HTTP_OPERATION_POLICIES.length,
      by_surface: { MCP: MCP_METHODS.length, HTTP: HTTP_OPERATION_POLICIES.length, WORKER: 0 },
    })
    expect(COMMERCIAL_OPERATION_REGISTRY).toHaveLength(386)
  })

  it('fails CI totality when a new runtime method has no reviewed classification', () => {
    expect(() => assertCommercialOperationRegistryTotality(
      [...COMMERCIAL_OPERATION_RUNTIME_MANIFEST, { surface: 'MCP', operation: 'new.method.requires.review' }],
      COMMERCIAL_OPERATION_REGISTRY,
    )).toThrow('missing classifications: MCP:new.method.requires.review')
  })

  it('publishes distinct workspace-scoped schemas for the four V2 recovery reads', () => {
    for (const method of ['commercial.access.get', 'commercial.catalog.get', 'creative-points.balance.get', 'creative-points.statement.list'] as const) {
      expect(MCP_METHOD_SCHEMAS[method].additionalProperties).toBe(false)
      expect(getMcpMethodPolicy(method)).toMatchObject({ effect: 'read', scope: 'workspace', capability: 'billing.workspace.read' })
      expect(resolveMcp(method)).toMatchObject({ outcome: 'REGISTERED', policy: { classification: 'RECOVERY_CONTROL' } })
    }
    expect(Object.keys(MCP_METHOD_SCHEMAS['commercial.access.get'].properties)).toEqual(['workspace_id'])
    expect(Object.keys(MCP_METHOD_SCHEMAS['commercial.catalog.get'].properties)).toEqual(['workspace_id'])
    expect(Object.keys(MCP_METHOD_SCHEMAS['creative-points.balance.get'].properties)).toEqual(['workspace_id'])
    expect(Object.keys(MCP_METHOD_SCHEMAS['creative-points.statement.list'].properties)).toEqual(['workspace_id', 'cursor', 'limit'])
  })

  it('publishes V2 purchase intent without accepting client-owned commercial facts', () => {
    expect(Object.keys(MCP_METHOD_SCHEMAS['commercial.order.create'].properties)).toEqual(['workspace_id', 'purchase_kind', 'sku_code', 'idempotency_key', 'reason'])
    expect(MCP_METHOD_SCHEMAS['commercial.order.create'].required).toEqual(['purchase_kind', 'sku_code', 'idempotency_key', 'reason'])
    expect(MCP_METHOD_SCHEMAS['commercial.order.create'].properties).not.toHaveProperty('amount_fen')
    expect(MCP_METHOD_SCHEMAS['commercial.order.create'].properties).not.toHaveProperty('currency')
    expect(MCP_METHOD_SCHEMAS['commercial.order.create'].properties).not.toHaveProperty('points')
    expect(MCP_METHOD_SCHEMAS['commercial.order.create'].properties).not.toHaveProperty('benefits')
    expect(getMcpMethodPolicy('commercial.order.create')).toMatchObject({ effect: 'write', scope: 'workspace', capability: 'billing.workspace.update' })
    expect(resolveMcp('commercial.order.create')).toMatchObject({ outcome: 'REGISTERED', policy: { enabled: true, classification: 'RECOVERY_CONTROL' } })
    expect(Object.keys(MCP_METHOD_SCHEMAS['commercial.order.payment.get'].properties)).toEqual(['workspace_id', 'order_id'])
    expect(getMcpMethodPolicy('commercial.order.payment.get')).toMatchObject({ effect: 'read', scope: 'workspace', capability: 'billing.workspace.read' })
  })

  it('keeps every MCP authorization reference attached instead of copying or weakening capabilities', () => {
    for (const method of MCP_METHODS) {
      const resolution = resolveMcp(method)
      expect(resolution.outcome).not.toBe('DENY_UNCLASSIFIED')
      if (resolution.policy) {
        expect(resolution.policy.authorization_policy_ref).toBe(method)
        expect(getMcpMethodPolicy(method), `${method} must retain its existing authz policy`).toBeDefined()
      }
    }
  })

  it('maps the eight V2 Ops reads to independent least-privilege capabilities', () => {
    const expected = {
      'ops.commercial.access.summary': 'commercial.access.read',
      'ops.commercial.access-blocks.list': 'commercial.access.read',
      'ops.commercial.entitlements.list': 'commercial.entitlement.read',
      'ops.commercial.points-ledger.list': 'commercial.point.read',
      'ops.commercial.catalog-v2.list': 'commercial.catalog.read',
      'ops.commercial.orders-v2.list': 'commercial.order.read',
      'ops.commercial.rate-cards.list': 'commercial.rate.read',
      'ops.commercial.service-fulfillment.list': 'commercial.service_fulfillment.read',
    } as const
    for (const [method, capability] of Object.entries(expected)) {
      expect(getMcpMethodPolicy(method as keyof typeof expected)).toMatchObject({ capability, scope: 'platform', workbench: 'platform', effect: 'read' })
      expect(resolveMcp(method)).toMatchObject({ outcome: 'REGISTERED', policy: { domain: 'OPS_CONTROL', enabled: true } })
    }
    expect(ROLE_CAPABILITIES.ops_admin).toEqual(expect.arrayContaining(['commercial.access.read', 'commercial.entitlement.read', 'commercial.point.read', 'commercial.catalog.read', 'commercial.private_sku.read', 'commercial.order.read', 'commercial.rate.read', 'commercial.service_fulfillment.read']))
    expect(ROLE_CAPABILITIES.finance_ops).toEqual(expect.arrayContaining(['commercial.access.read', 'commercial.entitlement.read', 'commercial.point.read', 'commercial.catalog.read', 'commercial.order.read', 'commercial.rate.read']))
    expect(ROLE_CAPABILITIES.finance_ops).not.toContain('commercial.service_fulfillment.read')
    expect(ROLE_CAPABILITIES.support_agent).toEqual(expect.arrayContaining(['commercial.access.read', 'commercial.entitlement.read', 'commercial.service_fulfillment.read']))
    expect(ROLE_CAPABILITIES.support_agent).not.toContain('commercial.point.read')
    for (const method of ['ops.commercial.service-allocation.create', 'ops.commercial.service-fulfillment.schedule', 'ops.commercial.service-fulfillment.start', 'ops.commercial.service-fulfillment.complete', 'ops.commercial.service-fulfillment.adjust'] as const) {
      expect(getMcpMethodPolicy(method)).toMatchObject({ capability: 'commercial.service_fulfillment.write', scope: 'platform', workbench: 'platform', effect: 'write' })
      expect(resolveMcp(method)).toMatchObject({ outcome: 'REGISTERED', policy: { domain: 'OPS_CONTROL', enabled: true } })
    }
    expect(ROLE_CAPABILITIES.ops_admin).toContain('commercial.service_fulfillment.write')
    expect(ROLE_CAPABILITIES.support_agent).not.toContain('commercial.service_fulfillment.write')
  })

  it('defines future write capabilities without granting or advertising fake methods', () => {
    const writes = ['commercial.access.recover', 'commercial.catalog.draft', 'commercial.catalog.approve', 'commercial.catalog.publish', 'commercial.private_sku.grant', 'commercial.payment.reconcile', 'commercial.rate.draft', 'commercial.rate.approve', 'commercial.rate.publish'] as const
    expect(CAPABILITIES).toEqual(expect.arrayContaining([...writes]))
    for (const capabilities of Object.values(ROLE_CAPABILITIES)) {
      for (const capability of writes) expect(capabilities).not.toContain(capability)
    }
    expect(ROLE_CAPABILITIES.ops_admin).toContain('commercial.point.adjust')
    expect(ROLE_CAPABILITIES.ops_admin).not.toContain('commercial.point.adjust.approve')
    expect(ROLE_CAPABILITIES.finance_ops).toContain('commercial.point.adjust.approve')
    expect(ROLE_CAPABILITIES.finance_ops).not.toContain('commercial.point.adjust')
  })

  it('keeps platform Ops outside point classes and exact recovery methods auditable', () => {
    for (const method of MCP_OPS_CONTROL_METHODS) {
      expect(resolveMcp(method)).toMatchObject({ outcome: 'REGISTERED', policy: { domain: 'OPS_CONTROL', classification: null, authorization_policy_ref: method } })
    }
    for (const method of MCP_RECOVERY_ENABLED_METHODS) {
      expect(resolveMcp(method)).toMatchObject({ outcome: 'REGISTERED', policy: { domain: 'COMMERCIAL', classification: 'RECOVERY_CONTROL' } })
    }
    for (const method of MCP_RECOVERY_DISABLED_METHODS) {
      expect(resolveMcp(method)).toMatchObject({ outcome: 'DENY_DISABLED', policy: { domain: 'COMMERCIAL', classification: 'RECOVERY_CONTROL' } })
    }
    expect(resolveMcp('workspace.bootstrap')).toMatchObject({ outcome: 'REGISTERED', policy: { domain: 'COMMERCIAL', classification: 'RECOVERY_CONTROL' } })
    for (const method of MCP_LEGACY_OPS_COMMERCIAL_DISABLED_METHODS) {
      expect(resolveMcp(method)).toMatchObject({ outcome: 'DENY_DISABLED', policy: { domain: 'COMMERCIAL', classification: 'RECOVERY_CONTROL' } })
    }
  })

  it('keeps only audited marketing controls in Ops and gates customer-business代理 operations', () => {
    for (const method of ['ops.marketing.summary', 'ops.marketing.queue', 'ops.marketing.queue.assign', 'ops.marketing.image.reconcile', 'ops.marketing.image.evidence.export', 'ops.marketing.image.archive.audit', 'ops.marketing.image.billing.audit']) {
      expect(resolveMcp(method)).toMatchObject({ outcome: 'REGISTERED', policy: { domain: 'OPS_CONTROL', classification: null } })
    }
    for (const method of ['ops.marketing.asset_scan.retry', 'ops.marketing.visual.review', 'ops.marketing.publish.acknowledge', 'ops.marketing.revision.create']) {
      expect(resolveMcp(method)).toMatchObject({ outcome: 'REGISTERED', policy: { domain: 'COMMERCIAL', classification: 'POINT_REQUIRED_NO_CHARGE' } })
    }
    expect(resolveMcp('ops.marketing.generation.retry')).toMatchObject({ outcome: 'DENY_DISABLED', policy: { domain: 'COMMERCIAL', classification: 'POINT_CHARGED' } })
  })

  it('keeps every charged method blocked until persisted rate and reservation evidence exists', () => {
    expect(MCP_POINT_CHARGED_ENABLED_METHODS).toEqual([])
    for (const method of MCP_POINT_CHARGED_ENABLED_METHODS) {
      expect(resolveMcp(method)).toMatchObject({ outcome: 'REGISTERED', policy: { classification: 'POINT_CHARGED', rate_action: method } })
    }
    for (const method of MCP_POINT_CHARGED_DISABLED_METHODS) {
      expect(resolveMcp(method)).toMatchObject({ outcome: 'DENY_DISABLED', policy: { classification: 'POINT_CHARGED' } })
    }
  })

  it('classifies exact payment callbacks as recovery and all other machine HTTP operations as infrastructure', () => {
    expect(resolveHttp('http:POST:/v1/billing/callback/{channel}')).toMatchObject({ outcome: 'REGISTERED', policy: { domain: 'COMMERCIAL', classification: 'RECOVERY_CONTROL' } })
    expect(resolveHttp('http:POST:/v1/subscriptions/callback/{channel}')).toMatchObject({ outcome: 'REGISTERED', policy: { domain: 'COMMERCIAL', classification: 'RECOVERY_CONTROL' } })
    for (const operation of ['http:POST:/mcp', 'http:GET:/healthz', 'http:GET:/v1/oauth/callback/{platform}', 'http:POST:/v1/internal/model-usage']) {
      expect(resolveHttp(operation)).toMatchObject({ outcome: 'REGISTERED', policy: { domain: 'MACHINE_INFRASTRUCTURE', classification: null } })
    }
  })

  it('keeps workspace recovery reads in exact HTTP/MCP parity', () => {
    const pairs = [
      ['http:GET:/v1/commercial/access', 'commercial.access.get'],
      ['http:GET:/v1/commercial/catalog', 'commercial.catalog.get'],
      ['http:GET:/v1/commercial/orders/{orderId}/payment', 'commercial.order.payment.get'],
      ['http:GET:/v1/creative-points/balance', 'creative-points.balance.get'],
      ['http:GET:/v1/creative-points/statement', 'creative-points.statement.list'],
    ] as const
    for (const [operation, method] of pairs) {
      expect(resolveHttp(operation)).toMatchObject({
        outcome: 'REGISTERED',
        policy: { domain: 'COMMERCIAL', enabled: true, classification: 'RECOVERY_CONTROL', authorization_policy_ref: method },
      })
      expect(getMcpMethodPolicy(method)).toMatchObject({ scope: 'workspace', workbench: 'workspace', effect: 'read' })
    }
    expect(resolveHttp('http:POST:/v1/commercial/orders')).toMatchObject({
      outcome: 'REGISTERED',
      policy: { domain: 'COMMERCIAL', enabled: true, classification: 'RECOVERY_CONTROL', authorization_policy_ref: 'commercial.order.create' },
    })
    expect(getMcpMethodPolicy('commercial.order.create')).toMatchObject({ scope: 'workspace', workbench: 'workspace', effect: 'write' })
  })

  it('publishes a deterministic reviewed-registry checksum', () => {
    expect(COMMERCIAL_OPERATION_REGISTRY_CHECKSUM).toBe('fnv1a32:4d49e319')
  })
})
