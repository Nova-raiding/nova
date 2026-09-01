import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { ConnectorMappingPreflightError, ConnectorRuntime, type ConnectorRuntimeWriteMappingPlan } from './connector-runtime.js'
import { evaluatePlatformFieldMapping, type ImmutableSchemaEvidence, type PlatformFieldMappingGateInput } from './platform-field-mapping-gate.js'
import type { Platform, RawProduct } from '../../../packages/connectors/src/types.js'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const verifiedAt = '2026-08-29T10:00:00.000Z'
const evidence = (id: string, state: ImmutableSchemaEvidence['state'] = 'production_canary'): ImmutableSchemaEvidence => ({ state, reference: `canary://${id}`, sha256: hash(id), capturedAt: verifiedAt })

function writeGateInput(platform: Platform, fields: Readonly<Record<string, unknown>>, state: ImmutableSchemaEvidence['state'] = 'production_canary'): PlatformFieldMappingGateInput {
  const schemaVersion = `${platform}-write-schema-v1`
  const gateInput: PlatformFieldMappingGateInput = {
    platform,
    category: 'runtime-write',
    placement: 'product-upsert',
    schema: {
      source: 'official',
      version: schemaVersion,
      immutableEvidence: evidence(`${platform}:write-schema`, state),
      fields: [
        { name: 'title', scope: 'product', required: true, type: 'string' },
        { name: 'category', scope: 'product', required: true, type: 'string' },
        { name: 'price', scope: 'product', required: true, type: 'number', range: { min: 0, max: 1_000_000 } },
        { name: 'stock', scope: 'product', required: true, type: 'integer', range: { min: 0, max: 1_000_000 } },
      ],
    },
    mapping: {
      version: `${platform}-write-mapping-v1`,
      schemaVersion,
      immutableEvidence: evidence(`${platform}:write-mapping`, state),
      rules: [
        { scope: 'product', sourceField: 'sourceTitle', targetField: 'title' },
        { scope: 'product', sourceField: 'sourceCategory', targetField: 'category' },
        { scope: 'product', sourceField: 'sourcePrice', targetField: 'price' },
        { scope: 'product', sourceField: 'sourceStock', targetField: 'stock' },
      ],
    },
    source: { productId: 'runtime-product-1', productFields: fields, skuPages: [{ items: [{ skuId: 'runtime-sku-sentinel', fields: {} }] }] },
    remoteSnapshot: { hash: hash(`${platform}:remote-write`), schemaVersion },
  }
  const evaluated = evaluatePlatformFieldMapping(gateInput)
  gateInput.remoteSnapshot.confirmation = {
    id: `${platform}-write-confirmation`,
    schemaVersion,
    schemaEvidenceHash: gateInput.schema.immutableEvidence.sha256,
    mappingVersion: gateInput.mapping.version,
    mappingEvidenceHash: gateInput.mapping.immutableEvidence.sha256,
    payloadHash: evaluated.mappedPayloadHash,
    remoteSnapshotHash: gateInput.remoteSnapshot.hash,
    confirmedBy: 'runtime-integration-reviewer',
    confirmedAt: verifiedAt,
  }
  return gateInput
}

function writePlan(platform: Platform, fields: Readonly<Record<string, unknown>>, state: ImmutableSchemaEvidence['state'] = 'production_canary'): ConnectorRuntimeWriteMappingPlan {
  return { gateInput: writeGateInput(platform, fields, state) }
}

function syncGateInput(platform: Platform, rawProduct: RawProduct, state: ImmutableSchemaEvidence['state'] = 'production_canary'): PlatformFieldMappingGateInput {
  const schemaVersion = `${platform}-sync-schema-v1`
  return {
    platform,
    category: rawProduct.category,
    placement: 'catalog-sync',
    schema: {
      source: 'official',
      version: schemaVersion,
      immutableEvidence: evidence(`${platform}:sync-schema`, state),
      fields: [
        { name: 'title', scope: 'product', required: true, type: 'string' },
        { name: 'price', scope: 'product', required: true, type: 'number' },
        { name: 'stock', scope: 'product', required: true, type: 'integer' },
        { name: 'name', scope: 'sku', required: true, type: 'string' },
        { name: 'price', scope: 'sku', required: true, type: 'number' },
        { name: 'stock', scope: 'sku', required: true, type: 'integer' },
      ],
    },
    mapping: {
      version: `${platform}-sync-mapping-v1`,
      schemaVersion,
      immutableEvidence: evidence(`${platform}:sync-mapping`, state),
      rules: [
        { scope: 'product', sourceField: 'rawTitle', targetField: 'title' },
        { scope: 'product', sourceField: 'rawPrice', targetField: 'price' },
        { scope: 'product', sourceField: 'rawStock', targetField: 'stock' },
        { scope: 'sku', sourceField: 'rawName', targetField: 'name' },
        { scope: 'sku', sourceField: 'rawPrice', targetField: 'price' },
        { scope: 'sku', sourceField: 'rawStock', targetField: 'stock' },
      ],
    },
    source: {
      productId: rawProduct.remoteId,
      productFields: { rawTitle: rawProduct.title, rawPrice: rawProduct.price, rawStock: rawProduct.stock },
      skuPages: [{ items: rawProduct.sku.map(sku => ({ skuId: sku.id, fields: { rawName: sku.name, rawPrice: sku.price, rawStock: sku.stock } })) }],
    },
    remoteSnapshot: { hash: hash(`${platform}:${rawProduct.remoteId}:sync`), schemaVersion },
  }
}

describe('ConnectorRuntime', () => {
  it('syncs through a selected profile and keeps platform identity', async () => {
    const runtime = new ConnectorRuntime({ fixtureMode: true })
    const result = await runtime.sync('tmall', { workspaceId: 'ws_1', accountId: 'acct_1', traceId: 'trace_1' })
    expect(result.platform).toBe('tmall')
    expect(result.items[0]?.platform).toBe('tmall')
  })

  it('uses the publish worker and returns a simulated receipt in fixture mode', async () => {
    const runtime = new ConnectorRuntime({ fixtureMode: true, allowFixtureWrites: true })
    const result = await runtime.publish({ platform: 'taobao', context: { workspaceId: 'ws_1', accountId: 'acct_1', traceId: 'trace_1' }, fields: { title: '更新标题', category: '女装 > 外套', price: 169, stock: 10 }, idempotencyKey: 'runtime-idem-1' })
    expect(result.connectorStatus?.state).toBe('succeeded')
  })

  it('keeps fixture writes closed unless explicitly enabled', async () => {
    const runtime = new ConnectorRuntime({ fixtureMode: true, allowFixtureWrites: false })
    await expect(runtime.executePublish({ platform: 'jd', context: { workspaceId: 'ws-fixture-closed', accountId: 'acct-fixture-closed' }, fields: { title: '禁止写入', category: '服饰', price: 10, stock: 1 }, idempotencyKey: 'fixture-write-closed' })).rejects.toThrow('platform write is not admitted')
  })

  it('creates new products and updates existing products based on remote identity', async () => {
    const runtime = new ConnectorRuntime({ fixtureMode: true, allowFixtureWrites: true })
    const created = await runtime.executePublish({ platform: 'jd', context: { workspaceId: 'ws_1', accountId: 'acct_1', traceId: 'trace_1' }, fields: { title: '新商品', category: '服饰 > 外套', price: 169, stock: 10 }, idempotencyKey: 'runtime-create-1' })
    const updated = await runtime.executePublish({ platform: 'jd', context: { workspaceId: 'ws_1', accountId: 'acct_1', traceId: 'trace_1' }, remoteId: 'JD-FIXTURE-1001', fields: { title: '更新商品', category: '服饰 > 外套', price: 179, stock: 8 }, idempotencyKey: 'runtime-update-1' })
    expect(created.receipt.operation).toBe('create')
    expect(updated.receipt.operation).toBe('update')
  })

  it('assembles an OAuth-only HTTP connector and keeps catalog access closed without evidence or vault', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 }))
    const runtime = new ConnectorRuntime({ configSource: {
      TMALL_APP_KEY: 'tmall-app',
      TMALL_OAUTH_AUTHORIZE_URL: 'https://tmall.test/authorize',
      TMALL_OAUTH_TOKEN_URL: 'https://tmall.test/token',
      TMALL_API_BASE_URL: 'https://tmall.test/api',
    }, fetch: fetchMock })
    expect(runtime.isOAuthConfigured('tmall')).toBe(true)
    expect(runtime.isHttpConfigured('tmall')).toBe(false)
    expect(runtime.canRead('tmall')).toBe(false)
    expect(runtime.isHttpConfigured('taobao')).toBe(false)
    await expect(runtime.connector('tmall').authorize({ workspaceId: 'ws_1', actorId: 'actor', redirectUri: 'https://app.test/v1/oauth/callback/tmall', state: 'state' })).resolves.toMatchObject({ ok: true, mode: 'real' })
    await expect(runtime.sync('tmall', { workspaceId: 'ws_1', accountId: 'acct_1' })).rejects.toBeDefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('accepts typed structured config without reading secrets into connector config', () => {
    const runtime = new ConnectorRuntime({ structuredConfig: {
      taobao: {
        clientId: 'taobao-app',
        oauth: { authorizeUrl: 'https://taobao.test/authorize', tokenUrl: 'https://taobao.test/token' },
        api: { baseUrl: 'https://taobao.test/api', syncPath: '/items', createPath: '/items/create', updatePath: '/items/update', queryPath: '/items/status' },
      },
    } })
    expect(runtime.isOAuthConfigured('taobao')).toBe(true)
    expect(runtime.isHttpConfigured('taobao')).toBe(false)
    expect(runtime.canRead('taobao')).toBe(false)
    expect(runtime.isHttpConfigured('tmall')).toBe(false)
  })

  it('runs verified mapping preflight on real runtime sync before canonical mapping', async () => {
    const sync = vi.fn(({ platform, rawProduct }: { platform: Platform; rawProduct: RawProduct }) => syncGateInput(platform, rawProduct))
    const runtime = new ConnectorRuntime({ fixtureMode: true, mappingPreflight: { sync } })
    const result = await runtime.sync('tmall', { workspaceId: 'ws-sync-gate', accountId: 'acct-sync-gate' })

    expect(sync).toHaveBeenCalledTimes(1)
    expect(sync.mock.calls[0]![0].rawProduct.remoteId).toBeTruthy()
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ platform: 'tmall', mappingVersion: 'tmall.mapping.v1' })
  })

  it('blocks runtime sync before canonical mapping when schema evidence is not externally verified', async () => {
    const runtime = new ConnectorRuntime({ fixtureMode: true, mappingPreflight: { sync: ({ platform, rawProduct }) => syncGateInput(platform, rawProduct, 'official_document') } })
    await expect(runtime.sync('jd', { workspaceId: 'ws-sync-blocked', accountId: 'acct-sync-blocked' })).rejects.toMatchObject({
      name: 'SyncPaginationError',
      pages: 1,
      partialItems: [],
      message: expect.stringContaining('SCHEMA_EXTERNALLY_UNVERIFIED'),
    })
  })

  it('keeps fixture writes out of the production write boundary', async () => {
    const write = vi.fn(({ platform, fields }: { platform: Platform; fields: Readonly<Record<string, unknown>> }) => writePlan(platform, fields))
    const runtime = new ConnectorRuntime({ fixtureMode: true, allowFixtureWrites: true, environment: 'production', mappingPreflight: { write } })
    const sourceFields = { sourceTitle: '门禁映射商品', sourceCategory: '服饰 > 外套', sourcePrice: 199, sourceStock: 6 }

    await expect(runtime.executePublish({ platform: 'jd', context: { workspaceId: 'ws-write-gate', accountId: 'acct-write-gate' }, fields: sourceFields, idempotencyKey: 'runtime-gated-direct' })).rejects.toThrow('platform write is not admitted')
    await expect(runtime.publish({ platform: 'taobao', context: { workspaceId: 'ws-write-gate', accountId: 'acct-write-gate' }, fields: sourceFields, idempotencyKey: 'runtime-gated-worker' })).rejects.toThrow('platform write is not admitted')
    expect(write).toHaveBeenCalledTimes(2)
    await expect(runtime.connector('jd').queryWrite({ workspaceId: 'ws-write-gate', accountId: 'acct-write-gate' }, { idempotencyKey: 'runtime-gated-direct' })).resolves.toMatchObject({ found: false })
    await expect(runtime.connector('taobao').queryWrite({ workspaceId: 'ws-write-gate', accountId: 'acct-write-gate' }, { idempotencyKey: 'runtime-gated-worker' })).resolves.toMatchObject({ found: false })
  })

  it('fails production writes closed when no verified schema/mapping adapter is provided', async () => {
    const runtime = new ConnectorRuntime({ fixtureMode: true, allowFixtureWrites: true, environment: 'production' })
    const writeInput = { platform: 'jd' as const, context: { workspaceId: 'ws-prod-closed', accountId: 'acct-prod-closed' }, fields: { title: '不能直写', category: '服饰', price: 10, stock: 1 }, idempotencyKey: 'runtime-prod-closed' }

    await expect(runtime.executePublish(writeInput)).rejects.toBeInstanceOf(ConnectorMappingPreflightError)
    await expect(runtime.publish({ ...writeInput, idempotencyKey: 'runtime-prod-worker-closed' })).rejects.toThrow('requires a verified schema/mapping preflight adapter')
    await expect(runtime.connector('jd').queryWrite(writeInput.context, { idempotencyKey: writeInput.idempotencyKey })).resolves.toMatchObject({ found: false })
  })

  it('blocks unverified write plans before any connector mutation', async () => {
    const runtime = new ConnectorRuntime({ fixtureMode: true, allowFixtureWrites: true, mappingPreflight: { write: ({ platform, fields }) => writePlan(platform, fields, 'vendor_attestation') } })
    const idempotencyKey = 'runtime-unverified-write'
    await expect(runtime.executePublish({ platform: 'taobao', context: { workspaceId: 'ws-unverified', accountId: 'acct-unverified' }, fields: { sourceTitle: '未验证', sourceCategory: '服饰', sourcePrice: 10, sourceStock: 1 }, idempotencyKey })).rejects.toMatchObject({
      name: 'ConnectorMappingPreflightError',
      stage: 'write',
      result: { externallyUnverified: true, publishable: false },
    })
    await expect(runtime.connector('taobao').queryWrite({ workspaceId: 'ws-unverified', accountId: 'acct-unverified' }, { idempotencyKey })).resolves.toMatchObject({ found: false })
  })

  it('binds preflight plans to the selected connector and raw product scope', async () => {
    const wrongPlatform = new ConnectorRuntime({ fixtureMode: true, allowFixtureWrites: true, mappingPreflight: { write: ({ fields }) => writePlan('jd', fields) } })
    await expect(wrongPlatform.executePublish({ platform: 'taobao', context: { workspaceId: 'ws-scope', accountId: 'acct-scope' }, fields: { sourceTitle: '错平台', sourceCategory: '服饰', sourcePrice: 10, sourceStock: 1 }, idempotencyKey: 'wrong-platform' })).rejects.toThrow('scope does not match taobao')

    const wrongProduct = new ConnectorRuntime({ fixtureMode: true, mappingPreflight: { sync: ({ platform, rawProduct }) => {
      const gate = syncGateInput(platform, rawProduct)
      gate.source.productId = 'another-product'
      return gate
    } } })
    await expect(wrongProduct.sync('jd', { workspaceId: 'ws-scope', accountId: 'acct-scope' })).rejects.toMatchObject({ message: expect.stringContaining('scope does not match') })
  })

  it('rejects an approved write plan built from different source fields', async () => {
    const runtime = new ConnectorRuntime({ fixtureMode: true, allowFixtureWrites: true, environment: 'production', mappingPreflight: {
      write: ({ platform }) => writePlan(platform, { sourceTitle: '被替换的商品', sourceCategory: '其他分类', sourcePrice: 1, sourceStock: 999 }),
    } })
    const context = { workspaceId: 'ws-source-binding', accountId: 'acct-source-binding' }
    const idempotencyKey = 'runtime-source-binding'

    await expect(runtime.executePublish({
      platform: 'jd', context, idempotencyKey,
      fields: { sourceTitle: '真实商品', sourceCategory: '服饰', sourcePrice: 199, sourceStock: 3 },
    })).rejects.toThrow('source fields do not match')
    await expect(runtime.connector('jd').queryWrite(context, { idempotencyKey })).resolves.toMatchObject({ found: false })
  })

  it('refuses to flatten verified per-SKU mappings into product fields', async () => {
    const runtime = new ConnectorRuntime({ fixtureMode: true, allowFixtureWrites: true, mappingPreflight: { write: ({ platform, fields }) => {
      const plan = writePlan(platform, fields)
      plan.gateInput.schema = { ...plan.gateInput.schema, fields: [...plan.gateInput.schema.fields, { name: 'sku_price', scope: 'sku', required: true, type: 'number' }] }
      plan.gateInput.mapping.rules = [...plan.gateInput.mapping.rules, { scope: 'sku', sourceField: 'sourceSkuPrice', targetField: 'sku_price' }]
      plan.gateInput.source.skuPages = [{ items: [{ skuId: 'runtime-sku-1', fields: { sourceSkuPrice: 12 } }] }]
      delete plan.gateInput.remoteSnapshot.confirmation
      const mapped = evaluatePlatformFieldMapping(plan.gateInput)
      plan.gateInput.remoteSnapshot.confirmation = {
        id: `${platform}-sku-confirmation`, schemaVersion: plan.gateInput.schema.version, schemaEvidenceHash: plan.gateInput.schema.immutableEvidence.sha256,
        mappingVersion: plan.gateInput.mapping.version, mappingEvidenceHash: plan.gateInput.mapping.immutableEvidence.sha256, payloadHash: mapped.mappedPayloadHash,
        remoteSnapshotHash: plan.gateInput.remoteSnapshot.hash, confirmedBy: 'sku-reviewer', confirmedAt: verifiedAt,
      }
      return plan
    } } })

    await expect(runtime.executePublish({ platform: 'jd', context: { workspaceId: 'ws-sku', accountId: 'acct-sku' }, fields: { sourceTitle: 'SKU 商品', sourceCategory: '服饰', sourcePrice: 10, sourceStock: 1 }, idempotencyKey: 'sku-no-flatten' })).rejects.toThrow('does not support implicit SKU flattening')
    await expect(runtime.connector('jd').queryWrite({ workspaceId: 'ws-sku', accountId: 'acct-sku' }, { idempotencyKey: 'sku-no-flatten' })).resolves.toMatchObject({ found: false })
  })
})
