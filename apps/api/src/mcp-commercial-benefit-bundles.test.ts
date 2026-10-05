import { describe, expect, it, vi } from 'vitest'
import type { PostgresCommercialBenefitBundleRepository } from '../../../packages/persistence/src/commercial-benefit-bundle-repository.js'
import { CommercialCatalogConflictError } from '../../../packages/persistence/src/commercial-catalog-repository.js'
import { handleCommercialBenefitBundleMethod } from './mcp-commercial-benefit-bundles.js'

function dependencies(capabilities: string[], mutate = vi.fn().mockResolvedValue({ code: 'creative', version: 2 })) {
  const repository = {
    definitions: vi.fn().mockReturnValue([{ code: 'creative_points' }]),
    listPage: vi.fn().mockResolvedValue({ items: [], total: 0, nextAfterId: null }),
    referencesPage: vi.fn().mockResolvedValue({ items: [], total: 0, nextAfterId: null }),
    mutate,
  } as unknown as PostgresCommercialBenefitBundleRepository
  return {
    repository,
    deps: {
      repository,
      actorId: 'ops-actor',
      capabilities,
      required: (input: Record<string, unknown>, key: string) => {
        const value = input[key]
        if (typeof value !== 'string' || !value.trim()) throw new Error(`missing ${key}`)
        return value
      },
      object: (input: Record<string, unknown>, key: string) => JSON.parse(input[key] as string) as Record<string, unknown>,
      array: (input: Record<string, unknown>, key: string) => JSON.parse(input[key] as string) as unknown[],
    },
  }
}

const mutation = {
  action: 'create', code: 'creative', expected_revision: '1', idempotency_key: 'bundle-create-1',
  name: '创意点权益包', usage: 'standalone', reason: '新增可售权益包', evidence_json: '{}',
  payload_json: '{"source":"ops"}', benefits_json: '[{"code":"creative_points","quantity":500,"normalizedValue":500,"policyRef":"monthly-creative-points"}]',
}

describe('commercial benefit bundle API authorization and mutation contract', () => {
  it.each([
    ['create', 'commercial.catalog.draft'],
    ['submit', 'commercial.catalog.draft'],
    ['approve', 'commercial.catalog.approve'],
    ['reject', 'commercial.catalog.approve'],
    ['retire', 'commercial.catalog.publish'],
    ['archive', 'commercial.catalog.publish'],
    ['delete_draft', 'commercial.catalog.draft'],
  ])('routes %s when its dedicated capability is present', async (action, capability) => {
    const { deps } = dependencies([capability])
    await expect(handleCommercialBenefitBundleMethod('ops.commercial.benefit-bundles.mutate', { ...mutation, action }, deps))
      .resolves.toMatchObject({ schema_version: 'commercial.benefit-bundle.v1' })
    expect(deps.repository.mutate).toHaveBeenCalledWith(expect.objectContaining({ action }))
  })

  it.each([
    ['create', 'commercial.catalog.draft', 'commercial.catalog.approve'],
    ['submit', 'commercial.catalog.draft', 'commercial.catalog.publish'],
    ['approve', 'commercial.catalog.approve', 'commercial.catalog.publish'],
    ['reject', 'commercial.catalog.approve', 'commercial.catalog.draft'],
    ['retire', 'commercial.catalog.publish', 'commercial.catalog.draft'],
    ['archive', 'commercial.catalog.publish', 'commercial.catalog.draft'],
    ['delete_draft', 'commercial.catalog.draft', 'commercial.catalog.publish'],
  ])('requires the dedicated capability for %s', async (action, requiredCapability, unrelatedCapability) => {
    const { deps } = dependencies([unrelatedCapability])
    await expect(handleCommercialBenefitBundleMethod('ops.commercial.benefit-bundles.mutate', { ...mutation, action }, deps))
      .rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
    expect(deps.repository.mutate).not.toHaveBeenCalled()
    expect(['commercial.catalog.draft', 'commercial.catalog.approve', 'commercial.catalog.publish']).toContain(requiredCapability)
  })

  it('passes the reviewed version, parsed benefits and idempotency identity to persistence', async () => {
    const { deps } = dependencies(['commercial.catalog.draft'])
    await expect(handleCommercialBenefitBundleMethod('ops.commercial.benefit-bundles.mutate', mutation, deps))
      .resolves.toMatchObject({ schema_version: 'commercial.benefit-bundle.v1', item: { code: 'creative', version: 2 } })
    expect(deps.repository.mutate).toHaveBeenCalledWith(expect.objectContaining({
      action: 'create', code: 'creative', expectedRevision: 1, idempotencyKey: 'bundle-create-1',
      actorId: 'ops-actor', usage: 'standalone', payload: { source: 'ops' },
      benefits: [{ code: 'creative_points', quantity: 500, rawValue: null, rawUnit: null, normalizedValue: 500, policyRef: 'monthly-creative-points', metadata: {} }],
    }))
  })

  it('rejects an invalid revision before calling persistence', async () => {
    const { deps } = dependencies(['commercial.catalog.draft'])
    await expect(handleCommercialBenefitBundleMethod('ops.commercial.benefit-bundles.mutate', { ...mutation, expected_revision: '1.5' }, deps))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })
    expect(deps.repository.mutate).not.toHaveBeenCalled()
  })

  it.each([
    ['null entry', '[null]'],
    ['non-string code', '[{"code":1}]'],
    ['blank code', '[{"code":"  "}]'],
    ['non-string policy reference', '[{"code":"creative_points","policyRef":42}]'],
    ['array metadata', '[{"code":"creative_points","metadata":[]}]'],
  ])('rejects malformed benefit entries (%s) before calling persistence', async (_label, benefits_json) => {
    const { deps } = dependencies(['commercial.catalog.draft'])
    await expect(handleCommercialBenefitBundleMethod('ops.commercial.benefit-bundles.mutate', { ...mutation, benefits_json }, deps))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })
    expect(deps.repository.mutate).not.toHaveBeenCalled()
  })

  it('maps stale bundle writes to a retryable read path without hiding the conflict', async () => {
    const { deps } = dependencies(['commercial.catalog.draft'], vi.fn().mockRejectedValue(new CommercialCatalogConflictError('bundle revision changed')))
    await expect(handleCommercialBenefitBundleMethod('ops.commercial.benefit-bundles.mutate', mutation, deps))
      .rejects.toMatchObject({ code: 'COMMERCIAL_CATALOG_CONFLICT', status: 409, details: { retryable: false, next_actions: ['ops.commercial.benefit-bundles.list'] } })
  })
})

describe('commercial benefit bundle reference paging contract', () => {
  const method = 'ops.commercial.benefit-bundles.references.list'
  const cursorFor = (afterId: string) => Buffer.from(JSON.stringify({ kind: 'bundle_references', afterId })).toString('base64url')

  it('forwards the pinned version and maps the next cursor returned by persistence', async () => {
    const { deps, repository } = dependencies([])
    repository.referencesPage = vi.fn().mockResolvedValue({ items: [{ sku_code: 'basic' }], total: 2, nextAfterId: 'ref-2' })
    const result = await handleCommercialBenefitBundleMethod(method, { code: 'creative', version_id: 'bundle-v3', limit: 1 }, deps)
    expect(repository.referencesPage).toHaveBeenCalledWith({ code: 'creative', versionId: 'bundle-v3', limit: 1, afterId: undefined })
    expect(result).toMatchObject({ schema_version: 'commercial.benefit-bundle.references.v1', total: 2, items: [{ sku_code: 'basic' }], next_cursor: cursorFor('ref-2') })
  })

  it('decodes a valid page cursor for the pinned reference query', async () => {
    const { deps, repository } = dependencies([])
    repository.referencesPage = vi.fn().mockResolvedValue({ items: [], total: 1, nextAfterId: null })
    await handleCommercialBenefitBundleMethod(method, { code: 'creative', version_id: 'bundle-v3', cursor: cursorFor('ref-2') }, deps)
    expect(repository.referencesPage).toHaveBeenCalledWith({ code: 'creative', versionId: 'bundle-v3', limit: 50, afterId: 'ref-2' })
  })

  it('rejects a cursor from another paging domain before persistence', async () => {
    const { deps, repository } = dependencies([])
    const foreignCursor = Buffer.from(JSON.stringify({ kind: 'catalog', afterId: 'catalog-2' })).toString('base64url')
    await expect(handleCommercialBenefitBundleMethod(method, { code: 'creative', cursor: foreignCursor }, deps))
      .rejects.toMatchObject({ code: 'COMMERCIAL_OPS_CURSOR_INVALID', status: 400 })
    expect(repository.referencesPage).not.toHaveBeenCalled()
  })
})
