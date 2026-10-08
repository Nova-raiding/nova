import { describe, expect, it, vi } from 'vitest'
import { DomainError } from '../../../packages/application/src/service.js'
import { MemoryKnowledgeRepository } from '../../../packages/persistence/src/knowledge.js'
import { handleCatalogBatchImport, type CatalogBatchImportDependencies } from './mcp-catalog-batch-import.js'

describe('catalog spreadsheet source asset authorization', () => {
  it('rejects another workspace source file before lookup, parsing, or product writes', async () => {
    // Regression: spreadsheet source_asset_id must be workspace-authorized before use.
    // Found by /qa on 2026-10-08.
    const products = new Map()
    const importProduct = vi.fn()
    const enforceAssetAccess = vi.fn(async () => {
      throw new DomainError('ASSET_ACCESS_DENIED', 'asset access denied', 403)
    })
    const assetForWorkspace = vi.fn()
    const dependencies = {
      service: { products, importProduct, getActionablePlatformAccount: vi.fn() },
      supportedPlatforms: ['jd'],
      isProduction: () => false,
      knowledgeRepository: new MemoryKnowledgeRepository(),
      required: (params: Record<string, unknown>, key: string) => {
        const value = params[key]
        if (typeof value !== 'string' || !value.trim()) throw new DomainError('INVALID_REQUEST', `${key} required`, 400)
        return value
      },
      enforceAssetAccess,
      assetForWorkspace,
      scanImportedProductRules: vi.fn(async () => undefined),
      persistSnapshotsAndEvent: vi.fn(async () => undefined),
      recordOperationAudit: vi.fn(async () => undefined),
      rollbackBatchProducts: vi.fn(),
      actor: () => 'fixture-merchant',
    } as unknown as CatalogBatchImportDependencies

    await expect(handleCatalogBatchImport('ws_import_boundary', { source_asset_id: 'asset_other_workspace' }, dependencies))
      .rejects.toMatchObject({ code: 'ASSET_ACCESS_DENIED' })

    expect(enforceAssetAccess).toHaveBeenCalledWith('ws_import_boundary', 'asset_other_workspace', 'editor')
    expect(assetForWorkspace).not.toHaveBeenCalled()
    expect(importProduct).not.toHaveBeenCalled()
    expect(products.size).toBe(0)
  })
})
