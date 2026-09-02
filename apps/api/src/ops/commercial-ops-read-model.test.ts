import { describe, expect, it } from 'vitest'
import type { CapabilityId } from '../../../../packages/contracts/src/authz.js'
import {
  CommercialOpsReadModelError,
  authorizeCommercialCatalogRead,
  commercialOpsPageLimit,
  decodeCreativePointStatementCursor,
  paginateCommercialRows,
  projectCommercialAccessSummary,
  projectCommercialCatalogItem,
  projectCommercialOpsCapabilities,
  projectCreativePointRate,
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
})
