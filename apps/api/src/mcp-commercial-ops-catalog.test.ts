import { describe, expect, it, vi } from 'vitest'
import type { CapabilityId } from '../../../packages/contracts/src/index.js'
import type { ApiPersistence } from './server.js'
import { handleCommercialOpsCatalogMethod, type CommercialOpsCatalogDependencies } from './mcp-commercial-ops-catalog.js'

function dependencies(capabilities: CapabilityId[], mutate: CommercialOpsCatalogDependencies['catalog'] extends infer Catalog
  ? Catalog extends { mutate: infer Mutate } ? Mutate : never
  : never) {
  const catalog = { mutate } as unknown as NonNullable<ApiPersistence['commercialCatalog']>
  return {
    catalog,
    capabilities: () => capabilities,
    actor: () => 'actor-test',
    required: (params: Record<string, unknown>, key: string) => {
      const value = params[key]
      if (typeof value !== 'string' || !value.trim()) throw new Error(`missing ${key}`)
      return value
    },
    parseJsonObjectParameter: () => ({ source: 'test' }),
    parseJsonArrayParameter: () => [],
    commercialOpsReadInput: <T>(project: () => T) => project(),
  } satisfies CommercialOpsCatalogDependencies
}

describe('commercial Ops catalog mutation authorization', () => {
  it('rejects retire for a draft-only capability before touching the repository', async () => {
    const mutate = vi.fn()
    const input = { action: 'retire', code: 'basic', reason: 'retire obsolete SKU', evidence_json: '{}', idempotency_key: 'retire-1' }

    await expect(handleCommercialOpsCatalogMethod(
      'ops.commercial.catalog-v2.mutate',
      input,
      dependencies(['commercial.catalog.draft'], mutate),
    )).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
    expect(mutate).not.toHaveBeenCalled()
  })
})
