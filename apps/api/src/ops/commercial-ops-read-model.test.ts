import { describe, expect, it } from 'vitest'
import type { CapabilityId } from '../../../../packages/contracts/src/authz.js'
import {
  CommercialOpsReadModelError,
  authorizeCommercialCatalogRead,
  commercialOpsPageLimit,
  decodeCreativePointStatementCursor,
  paginateCommercialRows,
  projectCommercialAccessSummary,
  projectCommercialAccessBlocks,
  projectCommercialCatalogItem,
  projectCommercialEntitlement,
  projectCommercialOpsCapabilities,
  projectCommercialOrder,
  projectCreativePointRate,
  projectServiceFulfillment,
} from './commercial-ops-read-model.js'

describe('commercial Ops read model', () => {
  it('projects only effective fine-grained commercial read capabilities', () => {
    const projection = projectCommercialOpsCapabilities([
      'commercial.catalog.read',
      'commercial.private_sku.read',
      'billing.platform.read',
    ] satisfies CapabilityId[])
    expect(projection).toEqual({ capabilities: ['commercial.catalog.read', 'commercial.private_sku.read'], canReadPrivateSku: true })
  })

  it('never requests private SKU rows without the separate read capability', () => {
    const projection = projectCommercialOpsCapabilities(['commercial.catalog.read'])
    expect(authorizeCommercialCatalogRead('true', projection)).toEqual({
      privateEntriesRequested: true,
      privateEntriesIncluded: false,
      repositoryOptions: { includePrivate: false, capabilities: [] },
    })
  })

  it('passes only the minimum private-SKU capability into the repository', () => {
    const projection = projectCommercialOpsCapabilities(['commercial.catalog.read', 'commercial.private_sku.read', 'commercial.order.read'])
    expect(authorizeCommercialCatalogRead(true, projection)).toEqual({
      privateEntriesRequested: true,
      privateEntriesIncluded: true,
      repositoryOptions: { includePrivate: true, capabilities: ['commercial.private_sku.read'] },
    })
  })

  it('validates bounded page limits and dataset-bound cursors', () => {
    expect(commercialOpsPageLimit(undefined)).toBe(50)
    expect(commercialOpsPageLimit('100')).toBe(100)
    expect(() => commercialOpsPageLimit('101')).toThrowError(CommercialOpsReadModelError)
    const first = paginateCommercialRows([{ id: 'b' }, { id: 'a' }, { id: 'c' }], { kind: 'catalog', limit: '2' })
    expect(first).toMatchObject({ items: [{ id: 'a' }, { id: 'b' }], total: 3 })
    expect(first.nextCursor).toEqual(expect.any(String))
    expect(paginateCommercialRows([{ id: 'b' }, { id: 'a' }, { id: 'c' }], { kind: 'catalog', cursor: first.nextCursor, limit: 2 })).toEqual({ items: [{ id: 'c' }], total: 3, nextCursor: null })
    expect(() => paginateCommercialRows([{ id: 'a' }], { kind: 'rate', cursor: first.nextCursor })).toThrowError('分页游标与数据集不匹配')
  })

  it('decodes creative-point cursors without accepting malformed or cross-shaped values', () => {
    const cursor = Buffer.from(JSON.stringify({ createdAt: '2026-09-02T00:00:00.000Z', id: 'ledger_1' })).toString('base64url')
    expect(decodeCreativePointStatementCursor(cursor)).toEqual({ createdAt: '2026-09-02T00:00:00.000Z', id: 'ledger_1' })
    expect(() => decodeCreativePointStatementCursor(Buffer.from(JSON.stringify({ id: 'ledger_1' })).toString('base64url'))).toThrowError('创意点流水游标无效')
    expect(() => decodeCreativePointStatementCursor('not-json')).toThrowError('游标无效或已损坏')
  })

  it('keeps unknown balance fields null and never projects them as zero', () => {
    expect(projectCommercialAccessSummary({
      workspaceId: 'ws_unknown',
      decision: null,
      balance: { workspaceId: 'ws_unknown', availablePoints: null, reservedPoints: null, settledPoints: null, revision: 0 },
      decisionOutcome: 'DENY_UNCLASSIFIED',
      verifiedAt: '2026-09-02T00:00:00.000Z',
      unavailableDecisionId: 'commercial_unavailable_test',
    })).toMatchObject({
      balance_state: 'unknown', available_points: null, reserved_points: null, settled_points: null,
      access_revision: null, allowed: false,
    })
  })

  it('rejects malformed DECISION outcome without a concrete access decision', () => {
    expect(() => projectCommercialAccessSummary({
      workspaceId: 'ws_malformed',
      decision: null,
      balance: { workspaceId: 'ws_malformed', availablePoints: 12, reservedPoints: 0, settledPoints: 0, revision: 3 },
      decisionOutcome: 'DECISION',
      verifiedAt: '2026-09-02T00:00:00.000Z',
      unavailableDecisionId: 'commercial_unavailable_malformed',
    })).toThrow('DECISION outcome must provide a complete commercial access decision')
  })

  it('supports non-commercial access denial outcome in summary', () => {
    expect(projectCommercialAccessSummary({
      workspaceId: 'ws_non_commercial',
      decision: null,
      balance: { workspaceId: 'ws_non_commercial', availablePoints: 12, reservedPoints: 0, settledPoints: 0, revision: 1 },
      decisionOutcome: 'DENY_NON_COMMERCIAL',
      verifiedAt: '2026-09-02T00:00:00.000Z',
      unavailableDecisionId: 'commercial_unavailable_non_commercial',
    })).toMatchObject({
      workspace_id: 'ws_non_commercial',
      decision_outcome: 'DENY_NON_COMMERCIAL',
      available_points: 12,
      reserved_points: 0,
      settled_points: 0,
      access_revision: '1',
      allowed: false,
      error_code: null,
    })
  })

  it('projects catalog and rate repository facts into the strict desktop DTO shape', () => {
    const catalog = projectCommercialCatalogItem({
      id: 'sku_1', code: 'basic_monthly', kind: 'monthly', visibility: 'public', requiredCapability: null,
      versionId: 'sku_version_1', version: 2, lifecycle: 'approved', executable: true, priceFen: 200_000,
      currency: 'CNY', priceMode: 'fixed', durationDays: 30, payload: { name: '基础版', blockers: [] }, checksum: 'catalog_checksum', effectiveAt: '2026-09-02T00:00:00.000Z',
      benefits: [{ code: 'creative_points', quantity: 5_000, rawValue: null, rawUnit: '点/月', normalizedValue: null, policyRef: null, metadata: {} }],
    })
    expect(catalog).toMatchObject({ id: 'sku_version_1', sku_code: 'basic_monthly', name: '基础版', type: 'monthly', price_label: '¥2000.00', benefits_summary: 'creative_points:5000 点/月', approval_state: 'approved' })

    const rate = projectCreativePointRate({
      id: 'rate_1', rateCardId: 'card_1', version: 3, actionCode: 'image.generate.standard', unit: 'image', integerPoints: 1,
      pricingMode: 'fixed', lifecycle: 'approved', approvalStatus: 'approved', executable: true, ruleExecutable: true,
      checksum: 'rate_checksum', effectiveAt: '2026-09-02T00:00:00.000Z', blockers: [],
    })
    expect(rate).toMatchObject({ id: 'rate_1', action_code: 'image.generate.standard', unit_label: 'image', points_rule: '1 点/image', approval_state: 'approved', blocking_reason: null })
  })

  it('projects persisted access decisions and marks a block resolved only after a later allow', () => {
    const decisions = [
      { id: 'allow_2', workspaceId: 'ws_1', requestId: 'req_2', operationKey: 'payment.grant.commit', accessClass: 'RECOVERY_CONTROL' as const, balanceState: 'known' as const, availablePoints: 500, reservedPoints: 0, quotedPoints: null, accessRevision: 2, rateCardVersion: null, allowed: true, code: 'OK' as const, nextActions: [], decidedAt: '2026-09-02T01:00:00.000Z' },
      { id: 'block_1', workspaceId: 'ws_1', requestId: 'req_1', operationKey: 'content.generate', accessClass: 'POINT_CHARGED' as const, balanceState: 'known' as const, availablePoints: 0, reservedPoints: 0, quotedPoints: 1, accessRevision: 1, rateCardVersion: 'rate:v1', allowed: false, code: 'CREATIVE_POINTS_EXHAUSTED' as const, nextActions: ['creative-points.balance.get'], decidedAt: '2026-09-02T00:00:00.000Z' },
    ]
    expect(projectCommercialAccessBlocks(decisions, 'open')).toEqual([])
    expect(projectCommercialAccessBlocks(decisions, 'resolved')).toEqual([expect.objectContaining({ id: 'block_1', state: 'resolved', error_code: 'CREATIVE_POINTS_EXHAUSTED', available_points: 0 })])
  })

  it('projects V2 entitlement, order and service facts without legacy wallet/task fallbacks', () => {
    expect(projectCommercialEntitlement({
      id: 'ent_1', workspaceId: 'ws_1', subscriptionPeriodId: 'period_1', periodStart: '2026-09-01T00:00:00.000Z', periodEnd: '2026-10-01T00:00:00.000Z', periodStatus: 'active', catalogVersionId: 'sku_v1', skuCode: 'monthly_basic',
      resolvedBenefits: [{ code: 'max_brands', quantity: 1, rawValue: null, rawUnit: 'brand' }, { code: 'cloud_storage', quantity: 50, rawValue: '50g', rawUnit: 'g' }], unresolvedBlockers: ['STORAGE_UNIT_UNRESOLVED'], executable: false, checksum: 'ent_checksum', createdAt: '2026-09-01T00:00:00.000Z',
    })).toMatchObject({ id: 'ent_1', workspace_id: 'ws_1', sku_code: 'monthly_basic', status: 'blocked', brand_limit: 1, storage_label: '50g', unresolved: ['STORAGE_UNIT_UNRESOLVED'] })

    expect(projectCommercialOrder({
      id: 'order_1', workspaceId: 'ws_1', skuId: 'sku_1', skuVersionId: 'sku_v1', skuCode: 'points_500', amountFen: 30_000, currency: 'CNY', paymentProvider: 'wechat', status: 'paid', idempotencyKey: 'order-key', requestHash: 'hash', createdByActorId: 'actor_1', providerOrderId: 'provider_1', createdAt: '2026-09-01T00:00:00.000Z', paidAt: '2026-09-01T00:01:00.000Z',
    })).toMatchObject({ id: 'order_1', sku_code: 'points_500', amount_label: '¥300.00 CNY', payment_state: 'paid', grant_state: 'granted' })

    expect(projectServiceFulfillment({
      id: 'svc_1', workspaceId: 'ws_1', orderSnapshotId: 'order_snapshot_1', entitlementSnapshotId: 'ent_1', serviceType: 'one_to_one', unit: 'minute', allocatedQuantity: 300, contractLabel: null, periodStart: '2026-09-01T00:00:00.000Z', periodEnd: '2026-10-01T00:00:00.000Z', sourceChecksum: 'source_checksum', createdByActorId: 'actor_1', creationReason: '合同履约', creationEvidence: { source: 'contract' }, revision: 2, status: 'in_progress', usedQuantity: 60, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z',
    })).toMatchObject({ id: 'svc_1', allocation_label: '300 minute', used_label: '60 / 300 minute', status: 'in_progress', revision: 2 })
  })
})
