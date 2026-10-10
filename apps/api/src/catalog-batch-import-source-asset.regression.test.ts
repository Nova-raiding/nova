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
    const scanImportedProductRules = vi.fn(async () => undefined)
    const persistSnapshotsAndEvent = vi.fn(async () => undefined)
    const recordOperationAudit = vi.fn(async () => undefined)
    const rollbackBatchProducts = vi.fn()
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
      scanImportedProductRules,
      persistSnapshotsAndEvent,
      recordOperationAudit,
      rollbackBatchProducts,
      actor: () => 'fixture-merchant',
    } as unknown as CatalogBatchImportDependencies

    await expect(handleCatalogBatchImport('ws_import_boundary', { source_asset_id: 'asset_other_workspace' }, dependencies))
      .rejects.toMatchObject({ code: 'ASSET_ACCESS_DENIED' })

    expect(enforceAssetAccess).toHaveBeenCalledWith('ws_import_boundary', 'asset_other_workspace', 'editor')
    // Authorization must fail before loading the asset, which is the only path to spreadsheet parsing.
    expect(assetForWorkspace).not.toHaveBeenCalled()
    expect(importProduct).not.toHaveBeenCalled()
    expect(scanImportedProductRules).not.toHaveBeenCalled()
    expect(persistSnapshotsAndEvent).not.toHaveBeenCalled()
    expect(recordOperationAudit).not.toHaveBeenCalled()
    expect(rollbackBatchProducts).not.toHaveBeenCalled()
    expect(products.size).toBe(0)
  })

  it('rejects an unauthorized source_asset_id even when products_json takes the import branch', async () => {
    const products = new Map()
    const importProduct = vi.fn(input => ({ id: 'p_1', workspaceId: 'ws_import_boundary', version: 1, title: input.title, platform: input.platform }))
    const enforceAssetAccess = vi.fn(async () => { throw new DomainError('ASSET_ACCESS_DENIED', 'asset access denied', 404) })
    const persistSnapshotsAndEvent = vi.fn(async () => undefined)
    const dependencies = {
      service: { products, importProduct, getActionablePlatformAccount: vi.fn() },
      supportedPlatforms: ['jd'],
      isProduction: () => false,
      knowledgeRepository: new MemoryKnowledgeRepository(),
      required: (params: Record<string, unknown>, key: string) => String(params[key]),
      enforceAssetAccess,
      assetForWorkspace: vi.fn(),
      scanImportedProductRules: vi.fn(async () => undefined),
      persistSnapshotsAndEvent,
      recordOperationAudit: vi.fn(async () => undefined),
      rollbackBatchProducts: vi.fn(),
      actor: () => 'fixture-merchant',
    } as unknown as CatalogBatchImportDependencies

    await expect(handleCatalogBatchImport('ws_import_boundary', {
      products_json: JSON.stringify([{ platform: 'jd', title: '商品' }]),
      source_asset_id: 'asset_other_workspace',
    }, dependencies)).rejects.toMatchObject({ code: 'ASSET_ACCESS_DENIED' })

    expect(enforceAssetAccess).toHaveBeenCalledWith('ws_import_boundary', 'asset_other_workspace', 'editor')
    expect(importProduct).not.toHaveBeenCalled()
    expect(persistSnapshotsAndEvent).not.toHaveBeenCalled()
    expect(products.size).toBe(0)
  })

  it('checks target-workspace ownership before projecting a source_asset_id alongside products_json', async () => {
    const products = new Map()
    const importProduct = vi.fn(input => ({ id: 'p_1', workspaceId: 'ws_import_boundary', version: 1, title: input.title, platform: input.platform }))
    const enforceAssetAccess = vi.fn(async () => undefined)
    const assetForWorkspace = vi.fn((_workspaceId: string, _assetId: string) => {
      throw new DomainError('ASSET_NOT_FOUND', 'asset not found in target workspace', 404)
    })
    const dependencies = {
      service: { products, importProduct, getActionablePlatformAccount: vi.fn() },
      supportedPlatforms: ['jd'], isProduction: () => false,
      knowledgeRepository: new MemoryKnowledgeRepository(),
      required: (params: Record<string, unknown>, key: string) => String(params[key]),
      enforceAssetAccess, assetForWorkspace,
      scanImportedProductRules: vi.fn(async () => undefined),
      persistSnapshotsAndEvent: vi.fn(async () => undefined),
      recordOperationAudit: vi.fn(async () => undefined), rollbackBatchProducts: vi.fn(),
      actor: () => 'fixture-merchant',
    } as unknown as CatalogBatchImportDependencies

    await expect(handleCatalogBatchImport('ws_import_boundary', {
      products_json: JSON.stringify([{ platform: 'jd', title: '商品' }]), source_asset_id: 'asset_other_workspace',
    }, dependencies)).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' })

    expect(enforceAssetAccess).toHaveBeenCalledWith('ws_import_boundary', 'asset_other_workspace', 'editor')
    expect(assetForWorkspace).toHaveBeenCalledWith('ws_import_boundary', 'asset_other_workspace')
    expect(importProduct).not.toHaveBeenCalled()
    expect(products.size).toBe(0)
  })
})
