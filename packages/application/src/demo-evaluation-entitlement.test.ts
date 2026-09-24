import { describe, expect, it, vi } from 'vitest'
import { ContinuousFeatureEntitlementService } from './continuous-feature-entitlement.js'

const now = '2026-09-25T12:00:00.000Z'
const grant = {
  id: 'demo-evaluation-1', workspaceId: 'ws_guirenniaoniao',
  startsAt: '2026-09-25T00:00:00.000Z', expiresAt: '2026-10-02T00:00:00.000Z',
  createdAt: '2026-09-25T00:00:00.000Z', checksum: 'a'.repeat(64), status: 'active' as const,
}

function service(items = [grant]) {
  const listDemoEvaluationEntitlements = vi.fn(async () => items)
  return {
    listDemoEvaluationEntitlements,
    service: new ContinuousFeatureEntitlementService({
      projection: { listV2EntitlementSnapshots: async () => [] }, now: () => new Date(now),
      demoEvaluation: { workspaceId: 'ws_guirenniaoniao', projection: { listDemoEvaluationEntitlements } },
    }),
  }
}

describe('explicit demo evaluation entitlement', () => {
  it('admits one durable, current evaluation grant for only its configured workspace', async () => {
    const subject = service()
    await expect(subject.service.decide({ workspace_id: 'ws_guirenniaoniao' })).resolves.toMatchObject({
      allowed: true, snapshot_id: grant.id, checksum: grant.checksum,
    })
    await expect(subject.service.decide({ workspace_id: 'ws_other' })).resolves.toMatchObject({ allowed: false, code: 'COMMERCIAL_ENTITLEMENT_REQUIRED' })
    expect(subject.listDemoEvaluationEntitlements).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['expired', [{ ...grant, expiresAt: now }]],
    ['wrong workspace', [{ ...grant, workspaceId: 'ws_other' }]],
    ['bad checksum', [{ ...grant, checksum: 'invalid' }]],
    ['missing', []],
  ])('denies %s grants', async (_case, rows) => {
    await expect(service(rows).service.decide({ workspace_id: 'ws_guirenniaoniao' }))
      .resolves.toMatchObject({ allowed: false, code: 'COMMERCIAL_ENTITLEMENT_REQUIRED' })
  })

  it('denies duplicate and unavailable grant evidence', async () => {
    await expect(service([grant, { ...grant, id: 'demo-evaluation-2' }]).service.decide({ workspace_id: 'ws_guirenniaoniao' }))
      .resolves.toMatchObject({ allowed: false, code: 'COMMERCIAL_ENTITLEMENT_AMBIGUOUS' })
    const unavailable = service()
    unavailable.listDemoEvaluationEntitlements.mockRejectedValueOnce(new Error('database unavailable'))
    await expect(unavailable.service.decide({ workspace_id: 'ws_guirenniaoniao' }))
      .resolves.toMatchObject({ allowed: false, code: 'COMMERCIAL_ENTITLEMENT_UNAVAILABLE' })
  })
})
