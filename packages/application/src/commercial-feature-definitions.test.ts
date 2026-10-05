import { describe, expect, it } from 'vitest'
import { COMMERCIAL_OPERATION_REGISTRY, type CommercialOperationPolicy } from '@merchant-marketing/contracts'
import { COMMERCIAL_FEATURE_DEFINITIONS, requiredCommercialFeatures } from './commercial-feature-definitions.js'
import { ContinuousFeatureEntitlementService, type ContinuousFeatureEntitlementSnapshotV2 } from './continuous-feature-entitlement.js'
const policy = (surface: 'MCP' | 'HTTP' | 'WORKER', operation: string): CommercialOperationPolicy => {
  const found = COMMERCIAL_OPERATION_REGISTRY.find(item => item.surface === surface && item.operation === operation)
  if (!found) throw new Error(`missing runtime registry operation ${surface}:${operation}`)
  return found
}
const snapshot: ContinuousFeatureEntitlementSnapshotV2 = {
  id: 'snapshot-1', workspaceId: 'workspace-1', subscriptionPeriodId: 'period-1', periodStart: '2026-09-01T00:00:00.000Z', periodEnd: '2026-10-01T00:00:00.000Z', periodStatus: 'active',
  catalogVersionId: 'version-1', skuCode: 'basic', resolvedBenefits: [{ code: 'max_brands', quantity: 1 }, { code: 'max_stores', quantity: 5 }],
  unresolvedBlockers: [], executable: true, checksum: 'a'.repeat(64), createdAt: '2026-09-01T00:00:00.000Z',
}
function service(benefits = snapshot.resolvedBenefits) {
  return new ContinuousFeatureEntitlementService({ projection: { listV2EntitlementSnapshots: async () => [{ ...snapshot, resolvedBenefits: benefits }] }, now: () => new Date('2026-09-15T00:00:00.000Z') })
}

describe('registered commercial feature consumers', () => {
  it('every published feature maps only existing enabled merchant operations', () => {
    for (const definition of COMMERCIAL_FEATURE_DEFINITIONS) {
      for (const method of definition.methods) {
        const current = policy('MCP', method)
        expect(current.domain).toBe('COMMERCIAL')
        expect(current.enabled).toBe(true)
        expect(requiredCommercialFeatures(current)).toContain(definition.code)
      }
    }
  })
  it('HTTP exact authz mapping and Worker recheck share the same capability', () => {
    expect(requiredCommercialFeatures(policy('MCP', 'content.generate'))).toEqual(['feature.content_generation'])
    expect(requiredCommercialFeatures(policy('HTTP', 'http:POST:/v1/tasks/{taskId}/content'))).toEqual(['feature.content_generation'])
    expect(requiredCommercialFeatures(policy('WORKER', 'image_generation.execute'))).toEqual(['feature.image_generation'])
    expect(requiredCommercialFeatures(policy('WORKER', 'publish.execute'))).toEqual(['feature.publish'])
  })
  it('shared multimodal generators require classification and do not guess text', () => {
    expect(requiredCommercialFeatures(policy('MCP', 'multimodal.generate'))).toEqual(['feature.content_generation', 'feature.image_generation', 'feature.video_generation'])
    expect(requiredCommercialFeatures(policy('MCP', 'multimodal.generate'), 'video')).toEqual(['feature.video_generation'])
    expect(requiredCommercialFeatures(policy('WORKER', 'generation.execute'), 'image')).toEqual(['feature.image_generation'])
  })
  it('does not grant Ops authority or apply paid feature gating to exact recovery', () => {
    expect(requiredCommercialFeatures(policy('MCP', 'ops.commercial.catalog-v2.mutate'))).toEqual([])
    expect(requiredCommercialFeatures(policy('MCP', 'commercial.order.create'))).toEqual([])
    expect(requiredCommercialFeatures(policy('WORKER', 'publish.reconcile'))).toEqual([])
  })
  it('current subscription and point balance do not imply a feature grant', async () => {
    expect(await service().decide({ workspace_id: 'workspace-1', required_feature_codes: ['feature.image_generation'] })).toMatchObject({ allowed: false, code: 'COMMERCIAL_ENTITLEMENT_REQUIRED' })
    expect(await service([...snapshot.resolvedBenefits, { code: 'feature.image_generation', quantity: 1 }]).decide({ workspace_id: 'workspace-1', required_feature_codes: ['feature.image_generation'] })).toMatchObject({ allowed: true })
    expect(await service([...snapshot.resolvedBenefits, { code: 'feature.image_generation', quantity: 0 }]).decide({ workspace_id: 'workspace-1', required_feature_codes: ['feature.image_generation'] })).toMatchObject({ allowed: false })
    expect(await service([...snapshot.resolvedBenefits, { code: 'feature.image_generation', quantity: 'true' }]).decide({ workspace_id: 'workspace-1', required_feature_codes: ['feature.image_generation'] })).toMatchObject({ allowed: false })
  })
  it('rejects a fabricated feature code rather than registering arbitrary strings', async () => {
    await expect(service().decide({ workspace_id: 'workspace-1', required_feature_codes: ['feature.ops.admin' as never] })).rejects.toThrow('unregistered')
  })
})
