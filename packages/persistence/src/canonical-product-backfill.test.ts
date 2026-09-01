import { describe, expect, it } from 'vitest'
import { canonicalProductIdFor, planCanonicalProductBackfill, runCanonicalProductBackfill } from './canonical-product-backfill.js'
import type { SqlClient, SqlPool } from './repository.js'

describe('canonical product backfill memory contract', () => {
  it('is deterministic, inserts only missing mappings, and is repeatable', () => {
    const input = {
      workspaceId: 'ws_a',
      products: [{ id: 'p_1', workspaceId: 'ws_a', brandId: 'brand_a', title: '商品一' }],
      canonicalProducts: [],
    }
    const first = planCanonicalProductBackfill(input)
    const second = planCanonicalProductBackfill({ ...input, canonicalProducts: first.creates })
    expect(first.creates[0]).toMatchObject({ id: canonicalProductIdFor('ws_a', 'p_1', 'brand_a'), legacyProductId: 'p_1' })
    expect(second.creates).toEqual([])
    expect(second.unchanged).toEqual(['p_1'])
  })

  it('reports missing, ambiguous, cross-brand, and id-collision cases without overwrite', () => {
    const report = planCanonicalProductBackfill({
      workspaceId: 'ws_a',
      products: [
        { id: 'missing_brand', workspaceId: 'ws_a', title: '缺品牌' },
        { id: 'ambiguous', workspaceId: 'ws_a', brandId: 'brand_a', title: '多映射' },
        { id: 'wrong_brand', workspaceId: 'ws_a', brandId: 'brand_a', title: '错品牌' },
        { id: 'collision', workspaceId: 'ws_a', brandId: 'brand_a', title: 'ID冲突' },
      ],
      canonicalProducts: [
        { id: 'c_1', workspaceId: 'ws_a', brandId: 'brand_a', title: 'A', legacyProductId: 'ambiguous' },
        { id: 'c_2', workspaceId: 'ws_a', brandId: 'brand_a', title: 'B', legacyProductId: 'ambiguous' },
        { id: 'c_3', workspaceId: 'ws_a', brandId: 'brand_b', title: 'C', legacyProductId: 'wrong_brand' },
        { id: canonicalProductIdFor('ws_a', 'collision', 'brand_a'), workspaceId: 'ws_a', brandId: 'brand_b', title: 'D', legacyProductId: 'other' },
      ],
    })
    expect(report.creates).toEqual([])
    expect(report.conflicts.map(item => item.code).sort()).toEqual(['CANONICAL_MAPPING_AMBIGUOUS', 'CANONICAL_ID_COLLISION', 'CANONICAL_LEGACY_PRODUCT_MISSING', 'MISSING_BRAND', 'CANONICAL_BRAND_MISMATCH'].sort())
    expect(report.conflicts.find(item => item.code === 'CANONICAL_LEGACY_PRODUCT_MISSING')).toMatchObject({ legacyProductId: 'other', canonicalIds: [canonicalProductIdFor('ws_a', 'collision', 'brand_a')] })
  })

  it('blocks duplicate legacy identities with conflicting brand claims', () => {
    const report = planCanonicalProductBackfill({
      workspaceId: 'ws_a',
      products: [
        { id: 'p_ambiguous', workspaceId: 'ws_a', brandId: 'brand_a', title: '同一商品' },
        { id: 'p_ambiguous', workspaceId: 'ws_a', brandId: 'brand_b', title: '同一商品' },
        { id: 'p_other_workspace', workspaceId: 'ws_b', brandId: 'brand_b', title: '不应读取' },
      ],
      canonicalProducts: [],
    })
    expect(report.creates).toEqual([])
    expect(report.conflicts).toEqual([{ legacyProductId: 'p_ambiguous', code: 'CANONICAL_MAPPING_AMBIGUOUS', canonicalIds: [] }])
  })

  it('blocks duplicate identity observations with conflicting titles', () => {
    const report = planCanonicalProductBackfill({
      workspaceId: 'ws_a',
      products: [
        { id: 'p_same_brand', workspaceId: 'ws_a', brandId: 'brand_a', title: '标准标题' },
        { id: 'p_same_brand', workspaceId: 'ws_a', brandId: 'brand_a', title: '另一个标题' },
        // A different workspace must not make an otherwise safe mapping ambiguous.
        { id: 'p_other_workspace', workspaceId: 'ws_b', brandId: 'brand_b', title: '不应读取' },
      ],
      canonicalProducts: [],
    })
    expect(report.creates).toEqual([])
    expect(report.conflicts).toEqual([{ legacyProductId: 'p_same_brand', code: 'CANONICAL_MAPPING_AMBIGUOUS', canonicalIds: [] }])
  })

  it('inventories a dangling canonical legacy reference before constraint validation', () => {
    const report = planCanonicalProductBackfill({
      workspaceId: 'ws_a',
      products: [{ id: 'p_1', workspaceId: 'ws_a', brandId: 'brand_a', title: '商品一' }],
      canonicalProducts: [{ id: 'c_dangling', workspaceId: 'ws_a', brandId: 'brand_a', title: '孤儿', legacyProductId: 'missing_legacy' }],
    })
    expect(report.creates).toEqual([{ id: canonicalProductIdFor('ws_a', 'p_1', 'brand_a'), workspaceId: 'ws_a', brandId: 'brand_a', title: '商品一', legacyProductId: 'p_1' }])
    expect(report.conflicts).toEqual([{ legacyProductId: 'missing_legacy', code: 'CANONICAL_LEGACY_PRODUCT_MISSING', canonicalIds: ['c_dangling'] }])
  })
})

class Client implements SqlClient {
  readonly calls: string[] = []
  private responses: Array<{ rows: any[]; rowCount?: number }> = []
  enqueue(response: { rows?: any[]; rowCount?: number } = {}) { this.responses.push({ rows: response.rows ?? [], rowCount: response.rowCount }) }
  async query<T = Record<string, unknown>>(text: string) { this.calls.push(text); return (this.responses.shift() ?? { rows: [] }) as { rows: T[]; rowCount?: number } }
  release() {}
}

describe('canonical product backfill PostgreSQL contract', () => {
  it('sets tenant scope, locks per workspace, uses conflict-safe inserts, and never updates', async () => {
    const client = new Client()
    client.enqueue(); client.enqueue(); client.enqueue(); client.enqueue({ rows: [{ id: 'p_1', workspaceId: 'ws_a', brandId: 'brand_a', title: '商品一' }] }); client.enqueue({ rows: [] }); client.enqueue({ rowCount: 1 }); client.enqueue({ rows: [] })
    const result = await runCanonicalProductBackfill({ connect: async () => client } satisfies SqlPool, { workspaceId: 'ws_a' })
    expect(result.insertedIds).toHaveLength(1)
    expect(client.calls.some(call => call.includes('pg_advisory_xact_lock'))).toBe(true)
    expect(client.calls.some(call => call.includes('ON CONFLICT (workspace_id,id) DO NOTHING'))).toBe(true)
    expect(client.calls.some(call => /\bUPDATE\b|\bDELETE\b/u.test(call))).toBe(false)
    expect(client.calls.at(-1)).toBe('COMMIT')
  })

  it('supports bounded dry-runs with a stable cursor and never inserts', async () => {
    const client = new Client()
    client.enqueue(); client.enqueue(); client.enqueue();
    client.enqueue({ rows: [
      { id: 'p_1', workspaceId: 'ws_a', brandId: 'brand_a', title: '商品一' },
      { id: 'p_2', workspaceId: 'ws_a', brandId: 'brand_a', title: '商品二' },
      { id: 'p_3', workspaceId: 'ws_a', brandId: 'brand_a', title: '商品三' },
    ] });
    client.enqueue({ rows: [] });
    const result = await runCanonicalProductBackfill({ connect: async () => client } satisfies SqlPool, { workspaceId: 'ws_a', dryRun: true, afterProductId: 'p_0', limit: 2 })
    expect(result).toMatchObject({ dryRun: true, nextProductId: 'p_2', insertedIds: [], creates: [expect.objectContaining({ legacyProductId: 'p_1' }), expect.objectContaining({ legacyProductId: 'p_2' })] })
    expect(client.calls.some(call => call.includes('INSERT INTO canonical_products'))).toBe(false)
    expect(client.calls.at(-1)).toBe('COMMIT')
  })

  it('rejects unbounded or invalid batch limits before opening a transaction', async () => {
    const connect = async () => { throw new Error('must not connect') }
    await expect(runCanonicalProductBackfill({ connect } satisfies SqlPool, { workspaceId: 'ws_a', limit: 0 })).rejects.toThrow('limit must be an integer')
    await expect(runCanonicalProductBackfill({ connect } satisfies SqlPool, { workspaceId: 'ws_a', limit: 5001 })).rejects.toThrow('limit must be an integer')
  })
})
