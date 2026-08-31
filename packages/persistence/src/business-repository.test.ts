import { describe, expect, it } from 'vitest'
import { BusinessSnapshotNotFoundError, BusinessSnapshotVersionConflictError, PostgresBusinessRepository, type SaveBusinessSnapshotInput } from './business-repository.js'
import { PostgresOutboxRepository, withWorkspaceTransaction, type SqlClient, type SqlPool } from './repository.js'

type Row = Record<string, unknown>
class RecordingClient implements SqlClient {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = []
  private readonly responses: Array<{ rows: Row[] }> = []
  enqueue(...rows: Row[]) { this.responses.push({ rows }) }
  async query<T = Row>(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, values })
    return (this.responses.shift() ?? { rows: [] }) as { rows: T[] }
  }
  release() {}
}
class RecordingPool implements SqlPool {
  constructor(readonly client: RecordingClient) {}
  async connect() { return this.client }
}
const input: SaveBusinessSnapshotInput = {
  workspaceId: 'ws_one', entityType: 'task', entityId: 'task_1', entityVersion: 2,
  payload: { id: 'task_1', workspaceId: 'ws_one', state: 'approved', version: 2 },
}
const row = { workspace_id: 'ws_one', entity_type: 'task', entity_id: 'task_1', entity_version: 2, payload: input.payload, created_at: '2026-08-23T00:00:00.000Z', updated_at: '2026-08-23T00:00:01.000Z' }

describe('PostgresBusinessRepository', () => {
  it('saves a versioned snapshot and rejects stale writes', async () => {
    const client = new RecordingClient()
    client.enqueue() // BEGIN
    client.enqueue() // set_config
    client.enqueue(row) // INSERT RETURNING
    client.enqueue() // COMMIT
    const repository = new PostgresBusinessRepository(new RecordingPool(client))
    expect(await repository.save(input)).toMatchObject({ entityVersion: 2, payload: input.payload })
    expect(client.calls[2]?.text).toContain('WHERE business_entity_snapshots.entity_version < EXCLUDED.entity_version')

    client.enqueue() // BEGIN
    client.enqueue() // set_config
    client.enqueue() // stale INSERT RETURNING empty
    client.enqueue(row) // canonical SELECT
    client.enqueue() // COMMIT
    expect(await repository.save({ ...input, entityVersion: 1, payload: { ...input.payload, state: 'draft' } })).toMatchObject({ entityVersion: 2 })
  })

  it('hydrates a workspace through tenant-scoped snapshot queries', async () => {
    const client = new RecordingClient()
    client.enqueue() // BEGIN
    client.enqueue() // set_config
    client.enqueue(row)
    client.enqueue() // COMMIT
    const result = await new PostgresBusinessRepository(new RecordingPool(client)).loadWorkspace('ws_one')
    expect(result).toHaveLength(1)
    expect(client.calls[2]?.values).toEqual(['ws_one', []])
    expect(client.calls[2]?.text).toContain('FROM business_entity_snapshots')
  })

  it('paginates normalized tasks inside tenant and brand scope before counting', async () => {
    const client = new RecordingClient()
    client.enqueue() // BEGIN
    client.enqueue() // set_config
    client.enqueue({ total: '2' })
    client.enqueue({ data: { id: 'task_2', brandId: 'brand_1' } }, { data: { id: 'task_3', brandId: 'brand_1' } })
    client.enqueue() // COMMIT

    const page = await new PostgresBusinessRepository(new RecordingPool(client)).listTasksPage('ws_one', {
      accessibleBrandIds: ['brand_1'], state: 'approved', limit: 20, offset: 0,
    })

    expect(page).toEqual({ items: [{ id: 'task_2', brandId: 'brand_1' }, { id: 'task_3', brandId: 'brand_1' }], total: 2, limit: 20, offset: 0 })
    expect(client.calls[2]?.text).toContain('brand_id = ANY($3::text[])')
    expect(client.calls[2]?.values).toEqual(['ws_one', 'approved', ['brand_1']])
    expect(client.calls[3]?.text).toContain('ORDER BY created_at DESC, id ASC LIMIT $4 OFFSET $5')
  })

  it('lists product asset bindings through the tenant-scoped relation', async () => {
    const client = new RecordingClient()
    client.enqueue() // BEGIN
    client.enqueue() // set_config
    client.enqueue({
      workspace_id: 'ws_one', product_id: 'product_1', asset_id: 'asset_1', asset_role: 'source', ordinal: 1, status: 'active',
      created_at: '2026-08-23T00:00:00.000Z', updated_at: '2026-08-23T00:00:01.000Z',
    })
    client.enqueue() // COMMIT

    const result = await new PostgresBusinessRepository(new RecordingPool(client)).listProductAssetBindings('ws_one', { productId: 'product_1' })

    expect(result).toEqual([{ workspaceId: 'ws_one', productId: 'product_1', assetId: 'asset_1', assetRole: 'source', ordinal: 1, status: 'active', createdAt: '2026-08-23T00:00:00.000Z', updatedAt: '2026-08-23T00:00:01.000Z' }])
    expect(client.calls[2]?.text).toContain('FROM product_asset_bindings')
    expect(client.calls[2]?.values).toEqual(['ws_one', 'product_1'])
  })

  it('binds an asset with workspace, brand, version and audit controls', async () => {
    const client = new RecordingClient()
    client.enqueue() // BEGIN
    client.enqueue() // set_config
    client.enqueue({ workspace_id: 'ws_one', entity_type: 'product', entity_id: 'product_1', entity_version: 3, payload: { id: 'product_1', workspaceId: 'ws_one', brandId: 'brand_1', sourceAssetIds: [] }, created_at: '2026-08-23T00:00:00.000Z', updated_at: '2026-08-23T00:00:00.000Z' })
    client.enqueue({ entity_id: 'asset_1', payload: { id: 'asset_1', workspaceId: 'ws_one', brandId: 'brand_1' } })
    client.enqueue({ workspace_id: 'ws_one', entity_type: 'product', entity_id: 'product_1', entity_version: 4, payload: { id: 'product_1', workspaceId: 'ws_one', brandId: 'brand_1', sourceAssetIds: ['asset_1'] }, created_at: '2026-08-23T00:00:00.000Z', updated_at: '2026-08-23T00:00:01.000Z' })
    client.enqueue() // normalized product projection trigger
    client.enqueue({ workspace_id: 'ws_one', product_id: 'product_1', asset_id: 'asset_1', asset_role: 'source', ordinal: 1, status: 'active', created_at: '2026-08-23T00:00:01.000Z', updated_at: '2026-08-23T00:00:01.000Z' })
    client.enqueue() // audit
    client.enqueue() // COMMIT
    const result = await new PostgresBusinessRepository(new RecordingPool(client), { normalizedProjection: true }).bindProductAsset({ workspaceId: 'ws_one', productId: 'product_1', assetId: 'asset_1', assetRole: 'source', brandId: 'brand_1', expectedVersion: 3, actorId: 'member_1', reason: '绑定商品主素材' })
    expect(result).toMatchObject({ workspaceId: 'ws_one', productId: 'product_1', assetId: 'asset_1', status: 'active' })
    expect(client.calls.some(call => call.text.includes('workspace_operation_audit'))).toBe(true)
    expect(client.calls.some(call => call.text.includes('FOR UPDATE'))).toBe(true)
    expect(client.calls.some(call => call.text.includes("entity_type='asset'"))).toBe(true)
  })

  it('rejects stale product versions before changing the relation', async () => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue()
    client.enqueue({ workspace_id: 'ws_one', entity_type: 'product', entity_id: 'product_1', entity_version: 4, payload: { id: 'product_1', brandId: 'brand_1' }, created_at: '2026-08-23T00:00:00.000Z', updated_at: '2026-08-23T00:00:00.000Z' })
    client.enqueue() // ROLLBACK
    await expect(new PostgresBusinessRepository(new RecordingPool(client)).bindProductAsset({ workspaceId: 'ws_one', productId: 'product_1', assetId: 'asset_1', assetRole: 'main', brandId: 'brand_1', expectedVersion: 3, actorId: 'member_1', reason: '绑定素材' })).rejects.toBeInstanceOf(BusinessSnapshotVersionConflictError)
    expect(client.calls.some(call => call.text.includes('product_asset_bindings'))).toBe(false)
  })

  it('rejects a cross-brand asset before relation or audit writes', async () => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue()
    client.enqueue({ workspace_id: 'ws_one', entity_type: 'product', entity_id: 'product_1', entity_version: 3, payload: { id: 'product_1', brandId: 'brand_1' }, created_at: '2026-08-23T00:00:00.000Z', updated_at: '2026-08-23T00:00:00.000Z' })
    client.enqueue({ entity_id: 'asset_2', payload: { id: 'asset_2', workspaceId: 'ws_one', brandId: 'brand_2' } })
    client.enqueue() // ROLLBACK
    await expect(new PostgresBusinessRepository(new RecordingPool(client)).bindProductAsset({ workspaceId: 'ws_one', productId: 'product_1', assetId: 'asset_2', assetRole: 'source', brandId: 'brand_1', expectedVersion: 3, actorId: 'member_1', reason: '绑定素材' })).rejects.toThrow('PRODUCT_ASSET_BINDING_BRAND_MISMATCH')
    expect(client.calls.some(call => call.text.includes('product_asset_bindings'))).toBe(false)
    expect(client.calls.some(call => call.text.includes('workspace_operation_audit'))).toBe(false)
  })

  it('uses a tenant scope before a missing entity is reported', async () => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue(); client.enqueue(); client.enqueue() // BEGIN, scope, SELECT, rollback
    await expect(new PostgresBusinessRepository(new RecordingPool(client)).get('ws_one', 'product', 'missing')).rejects.toBeInstanceOf(BusinessSnapshotNotFoundError)
    expect(client.calls[1]?.text).toContain('set_config')
    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
  })

  it('finds an idempotent job across API replicas', async () => {
    const client = new RecordingClient()
    client.enqueue() // BEGIN
    client.enqueue() // set_config
    client.enqueue({ ...row, entity_type: 'publish_job', entity_id: 'pub_1', payload: { id: 'pub_1', idempotencyKey: 'idem_1' } })
    client.enqueue() // COMMIT
    const snapshot = await new PostgresBusinessRepository(new RecordingPool(client)).findByIdempotencyKey('ws_one', 'publish_job', 'idem_1')
    expect(snapshot?.entityId).toBe('pub_1')
    expect(client.calls[2]?.text).toContain("payload->>'idempotencyKey'")
    expect(client.calls[2]?.values).toEqual(['ws_one', 'publish_job', 'idem_1'])
  })

  it('supports one transaction for a business snapshot and its outbox event', async () => {
    const client = new RecordingClient()
    client.enqueue() // BEGIN
    client.enqueue() // set_config
    client.enqueue(row) // business snapshot INSERT RETURNING
    client.enqueue({
      id: 'evt_1', workspace_id: 'ws_one', aggregate_id: 'task_1', event_type: 'state.snapshot', sequence: 2,
      payload: { entityType: 'task', entity: input.payload }, published_at: null, created_at: '2026-08-23T00:00:00.000Z',
    }) // outbox INSERT RETURNING
    client.enqueue() // COMMIT
    const pool = new RecordingPool(client)
    await withWorkspaceTransaction(pool, 'ws_one', async transaction => {
      await new PostgresBusinessRepository(pool).saveInTransaction(transaction, input)
      await new PostgresOutboxRepository(pool).appendInTransaction(transaction, {
        workspaceId: 'ws_one', aggregateId: 'task_1', eventType: 'state.snapshot', sequence: 2,
        payload: { entityType: 'task', entity: input.payload },
      })
    })
    expect(client.calls.map(call => call.text)).toEqual([
      'BEGIN', `SELECT set_config('app.workspace_id', $1, true)`, expect.stringContaining('INSERT INTO business_entity_snapshots'), expect.stringContaining('INSERT INTO outbox_events'), 'COMMIT',
    ])
  })

  it('rejects a divergent write that races at the same entity version', async () => {
    const client = new RecordingClient()
    client.enqueue() // BEGIN
    client.enqueue() // set_config
    client.enqueue() // same-version INSERT RETURNING empty
    client.enqueue({ ...row, payload: { ...input.payload, state: 'rejected' } }) // canonical SELECT
    client.enqueue() // ROLLBACK from the transaction wrapper
    await expect(new PostgresBusinessRepository(new RecordingPool(client)).save({ ...input, payload: { ...input.payload, state: 'approved_by_other_replica' } })).rejects.toBeInstanceOf(BusinessSnapshotVersionConflictError)
  })

  it('projects the complete Route B task scope into normalized columns', async () => {
    const client = new RecordingClient()
    const scopedInput: SaveBusinessSnapshotInput = {
      ...input,
      payload: {
        ...input.payload,
        productId: 'legacy_product_1',
        platform: 'taobao',
        accountId: 'store_1',
        brandId: 'brand_1',
        canonicalProductId: 'canonical_1',
        listingId: 'listing_1',
        campaignId: 'campaign_1',
        campaignItemId: 'item_1',
        contentVersionId: 'content_2',
      },
    }
    client.enqueue() // BEGIN
    client.enqueue() // set_config
    client.enqueue({ ...row, payload: scopedInput.payload }) // snapshot INSERT RETURNING
    client.enqueue() // normalized task projection
    client.enqueue() // COMMIT

    await new PostgresBusinessRepository(new RecordingPool(client), { normalizedProjection: true }).save(scopedInput)

    const projection = client.calls[3]
    expect(projection?.text).toContain('brand_id, canonical_product_id, listing_id, campaign_id, campaign_item_id')
    expect(projection?.text).toContain('CASE WHEN $6::text IS NOT NULL')
    expect(projection?.text).toContain('id = $6::text')
    expect(projection?.text).toContain('brand_id=EXCLUDED.brand_id')
    expect(projection?.text).toContain('campaign_item_id=EXCLUDED.campaign_item_id')
    expect(projection?.values).toEqual([
      'task_1', 'ws_one', 'legacy_product_1', 'taobao', 'store_1',
      'brand_1', 'canonical_1', 'listing_1', 'campaign_1', 'item_1',
      'approved', null, 'content_2', 2, JSON.stringify(scopedInput.payload),
    ])
  })
})
