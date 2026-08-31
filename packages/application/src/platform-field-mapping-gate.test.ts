import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  FIELD_MAPPING_PLATFORMS,
  PlatformFieldMappingInputError,
  evaluatePlatformFieldMapping,
  type PlatformFieldMappingGateInput,
  type PlatformMappingConfirmation,
  type PlatformTargetSchema,
} from './platform-field-mapping-gate.js'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const capturedAt = '2026-08-29T09:00:00.000Z'

function evidence(id: string, state: 'production_canary' | 'official_document' = 'production_canary') {
  return { state, reference: `evidence://${id}`, sha256: hash(id), capturedAt }
}

function schema(version = 'schema-v1'): PlatformTargetSchema {
  return {
    source: 'official',
    version,
    immutableEvidence: evidence(`schema:${version}`),
    fields: [
      { name: 'title', scope: 'product', required: true, type: 'string', length: { min: 1, max: 60 } },
      { name: 'status', scope: 'product', required: true, type: 'string', enum: ['active', 'inactive'] },
      { name: 'sale_price', scope: 'sku', required: true, type: 'money', money: { scale: 2, currency: 'CNY' }, range: { min: '0.01', max: '999999.99' } },
      { name: 'stock', scope: 'sku', required: true, type: 'integer', range: { min: 0, max: 999999 } },
    ],
  }
}

function input(): PlatformFieldMappingGateInput {
  const currentSchema = schema()
  return {
    platform: 'taobao',
    category: 'apparel/jackets',
    schema: currentSchema,
    mapping: {
      version: 'mapping-v1',
      schemaVersion: currentSchema.version,
      immutableEvidence: evidence('mapping:v1'),
      rules: [
        { scope: 'product', sourceField: 'name', targetField: 'title' },
        { scope: 'product', sourceField: 'listingState', targetField: 'status' },
        { scope: 'sku', sourceField: 'price', targetField: 'sale_price' },
        { scope: 'sku', sourceField: 'inventory', targetField: 'stock' },
      ],
    },
    source: {
      productId: 'product-1',
      productFields: { name: '轻量冲锋衣', listingState: 'active' },
      skuPages: [
        { nextCursor: 'page-2', items: [{ skuId: 'sku-red-s', fields: { price: { amount: '199.00', currency: 'CNY' }, inventory: 12 } }] },
        { cursor: 'page-2', items: [{ skuId: 'sku-blue-m', fields: { price: { amount: '219.90', currency: 'CNY' }, inventory: 8 } }] },
      ],
    },
    remoteSnapshot: { hash: hash('remote:v1'), schemaVersion: currentSchema.version },
  }
}

function confirmationFor(source: PlatformFieldMappingGateInput): PlatformMappingConfirmation {
  const evaluated = evaluatePlatformFieldMapping(source)
  return {
    id: 'confirmation-v1',
    schemaVersion: source.schema.version,
    schemaEvidenceHash: source.schema.immutableEvidence.sha256,
    mappingVersion: source.mapping.version,
    mappingEvidenceHash: source.mapping.immutableEvidence.sha256,
    payloadHash: evaluated.mappedPayloadHash,
    remoteSnapshotHash: source.remoteSnapshot.hash,
    confirmedBy: 'publisher-1',
    confirmedAt: capturedAt,
  }
}

function confirmedInput() {
  const value = input()
  value.remoteSnapshot.confirmation = confirmationFor(value)
  return value
}

describe('platform field mapping and schema drift gate', () => {
  it('maps a verified product safely while preserving raw values, SKU identity and provenance', () => {
    const source = confirmedInput()
    const result = evaluatePlatformFieldMapping(source)

    expect(result).toMatchObject({ externallyUnverified: false, mappingSafe: true, publishable: true, confirmationValid: true, blocks: [], unknownFields: [] })
    expect(result.mappedPayload).toEqual({
      productId: 'product-1',
      category: 'apparel/jackets',
      product: { title: '轻量冲锋衣', status: 'active' },
      skus: [
        { sourceSkuId: 'sku-red-s', fields: { sale_price: { amount: '199.00', currency: 'CNY' }, stock: 12 } },
        { sourceSkuId: 'sku-blue-m', fields: { sale_price: { amount: '219.90', currency: 'CNY' }, stock: 8 } },
      ],
    })
    expect(result.rawSource).toEqual(source.source)
    expect(result.rawSource).not.toBe(source.source)
    expect(result.provenance).toHaveLength(6)
    expect(result.provenance.find(item => item.skuId === 'sku-red-s' && item.targetField === 'sale_price')).toMatchObject({ rawValue: { amount: '199.00', currency: 'CNY' }, schemaVersion: 'schema-v1', mappingVersion: 'mapping-v1' })
  })

  it('blocks dirty pagination, cursor loops and duplicate SKU records instead of merging them', () => {
    const source = input()
    source.source.skuPages = [
      { nextCursor: 'page-2', items: [{ skuId: 'sku-1', fields: { price: { amount: '10.00', currency: 'CNY' }, inventory: 1 } }] },
      { cursor: 'wrong-page', nextCursor: 'wrong-page', items: [{ skuId: 'sku-1', fields: { price: { amount: '10.00', currency: 'CNY' }, inventory: 2 } }] },
    ]
    const result = evaluatePlatformFieldMapping(source)

    expect(result.blocks.map(item => item.code)).toEqual(expect.arrayContaining(['SOURCE_PAGINATION_DIRTY', 'SOURCE_SKU_DUPLICATE']))
    expect(result.nextActions).toContain('clean_source_pagination')
    expect(result.mappedPayload.skus.map(item => item.sourceSkuId)).toEqual(['sku-1', 'sku-1'])
    expect(result.publishable).toBe(false)
  })

  it('blocks an independently unmappable SKU without borrowing fields from another SKU', () => {
    const source = input()
    source.source.skuPages[1]!.items[0]!.fields = { inventory: 8 }
    const result = evaluatePlatformFieldMapping(source)

    expect(result.blocks).toContainEqual(expect.objectContaining({ code: 'TARGET_REQUIRED_MISSING', path: 'mappedPayload.skus[1].fields.sale_price' }))
    expect(result.mappedPayload.skus[0]!.fields).toHaveProperty('sale_price')
    expect(result.mappedPayload.skus[1]!.fields).not.toHaveProperty('sale_price')
    expect(result.nextActions).toContain('repair_sku_mapping')
  })

  it('fails closed when SKU pagination is empty', () => {
    const source = input()
    source.source.skuPages = []
    const result = evaluatePlatformFieldMapping(source)

    expect(result.blocks).toContainEqual(expect.objectContaining({ code: 'SOURCE_SKU_INVALID', path: 'source.skuPages' }))
    expect(result.mappedPayload.skus).toEqual([])
    expect(result.nextActions).toContain('repair_sku_mapping')
    expect(result.publishable).toBe(false)
  })

  it('rejects price precision drift and type coercion instead of rounding or guessing', () => {
    const excessivePrecision = input()
    excessivePrecision.source.skuPages[0]!.items[0]!.fields = { ...excessivePrecision.source.skuPages[0]!.items[0]!.fields, price: { amount: '199.999', currency: 'CNY' } }
    const precisionResult = evaluatePlatformFieldMapping(excessivePrecision)
    expect(precisionResult.blocks).toContainEqual(expect.objectContaining({ code: 'PRICE_PRECISION_DRIFT' }))
    expect(precisionResult.mappedPayload.skus[0]!.fields.sale_price).toBeUndefined()

    const coercion = input()
    coercion.source.skuPages[0]!.items[0]!.fields = { ...coercion.source.skuPages[0]!.items[0]!.fields, price: '199.00' }
    const coercionResult = evaluatePlatformFieldMapping(coercion)
    expect(coercionResult.blocks).toContainEqual(expect.objectContaining({ code: 'TARGET_TYPE_MISMATCH' }))
    expect(coercionResult.provenance.some(item => item.skuId === 'sku-red-s' && item.targetField === 'sale_price')).toBe(false)
  })

  it('rejects wrong price currency, out-of-range prices and non-integer SKU stock', () => {
    const wrongCurrency = input()
    wrongCurrency.source.skuPages[0]!.items[0]!.fields = { price: { amount: '199.00', currency: 'USD' }, inventory: 12 }
    expect(evaluatePlatformFieldMapping(wrongCurrency).blocks).toContainEqual(expect.objectContaining({ code: 'PRICE_PRECISION_DRIFT' }))

    const outOfRange = input()
    outOfRange.source.skuPages[0]!.items[0]!.fields = { price: { amount: '1000000.00', currency: 'CNY' }, inventory: 12 }
    expect(evaluatePlatformFieldMapping(outOfRange).blocks).toContainEqual(expect.objectContaining({ code: 'TARGET_RANGE_MISMATCH' }))

    const stringStock = input()
    stringStock.source.skuPages[0]!.items[0]!.fields = { price: { amount: '199.00', currency: 'CNY' }, inventory: '12' }
    const stockResult = evaluatePlatformFieldMapping(stringStock)
    expect(stockResult.blocks).toContainEqual(expect.objectContaining({ code: 'TARGET_TYPE_MISMATCH', path: 'source.skus.sku-red-s.fields.inventory' }))
    expect(stockResult.mappedPayload.skus[0]!.fields.stock).toBeUndefined()
  })

  it('rejects source enum values outside the current exact enum without coercion', () => {
    const source = input()
    source.source.productFields = { ...source.source.productFields, listingState: 'ACTIVE' }
    const result = evaluatePlatformFieldMapping(source)

    expect(result.blocks).toContainEqual(expect.objectContaining({ code: 'TARGET_ENUM_MISMATCH', path: 'source.productFields.listingState' }))
    expect(result.mappedPayload.product.status).toBeUndefined()
    expect(result.provenance.some(item => item.targetField === 'status')).toBe(false)
  })

  it('reports enum additions as a reviewable schema diff and supplies a next action', () => {
    const source = input()
    source.previousSchema = schema('schema-v0')
    source.previousSchema.fields[1]!.enum = ['active']
    const result = evaluatePlatformFieldMapping(source)

    expect(result.schemaDiff).toMatchObject({ fromVersion: 'schema-v0', toVersion: 'schema-v1', versionChanged: true })
    expect(result.schemaDiff.changedFields).toContainEqual(expect.objectContaining({ field: 'status', kinds: ['enum_added'], enumAdded: ['inactive'] }))
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'SCHEMA_ENUM_CHANGED' }))
    expect(result.nextActions).toContain('review_enum_change')
    expect(result.mappingSafe).toBe(true)
  })

  it('hard-blocks enum contraction and records removed enum values precisely', () => {
    const source = input()
    const old = schema('schema-v0')
    source.previousSchema = old
    source.schema = {
      ...source.schema,
      fields: source.schema.fields.map(field => field.name === 'status' ? { ...field, enum: ['active'] } : field),
    }
    const result = evaluatePlatformFieldMapping(source)

    expect(result.schemaDiff.changedFields).toContainEqual(expect.objectContaining({ field: 'status', kinds: ['enum_removed'], enumRemoved: ['inactive'] }))
    expect(result.blocks).toContainEqual(expect.objectContaining({ code: 'SCHEMA_ENUM_CHANGED' }))
    expect(result.nextActions).toContain('review_enum_change')
    expect(result.mappingSafe).toBe(false)
  })

  it('diffs removed fields and type/range/length/money constraint drift', () => {
    const source = input()
    const old = schema('schema-v0')
    source.previousSchema = {
      ...old,
      fields: [
        ...old.fields,
        { name: 'subtitle', scope: 'product', required: false, type: 'string', length: { max: 120 } },
      ],
    }
    source.schema = {
      ...source.schema,
      fields: source.schema.fields.map(field => {
        if (field.name === 'title') return { ...field, type: 'string' as const, length: { min: 2, max: 40 } }
        if (field.name === 'stock') return { ...field, range: { min: 1, max: 10000 } }
        if (field.name === 'sale_price') return { ...field, money: { scale: 3, currency: 'CNY' }, range: { min: '0.001', max: '999999.999' } }
        return field
      }),
    }
    const result = evaluatePlatformFieldMapping(source)

    expect(result.schemaDiff.removedFields).toContainEqual(expect.objectContaining({ name: 'subtitle', scope: 'product' }))
    expect(result.schemaDiff.changedFields).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'title', kinds: ['length_changed'] }),
      expect.objectContaining({ field: 'sale_price', kinds: ['range_changed', 'money_changed'] }),
      expect.objectContaining({ field: 'stock', kinds: ['range_changed'] }),
    ]))
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'SCHEMA_FIELD_CHANGED', path: 'schema.product:subtitle' }))
    expect(result.nextActions).toContain('review_schema_change')
  })

  it('hard-blocks a field becoming required until the mapping and every payload are updated', () => {
    const source = input()
    const old = schema('schema-v0')
    source.previousSchema = { ...old, fields: [...old.fields, { name: 'material', scope: 'product', required: false, type: 'string' }] }
    source.schema = { ...source.schema, fields: [...source.schema.fields, { name: 'material', scope: 'product', required: true, type: 'string' }] }
    const result = evaluatePlatformFieldMapping(source)

    expect(result.schemaDiff.changedFields).toContainEqual(expect.objectContaining({ field: 'material', kinds: ['required_changed'] }))
    expect(result.blocks.map(item => item.code)).toEqual(expect.arrayContaining(['SCHEMA_REQUIRED_FIELD_CHANGED', 'TARGET_FIELD_UNMAPPED', 'TARGET_REQUIRED_MISSING']))
    expect(result.nextActions).toContain('map_new_required_fields')
    expect(result.mappingSafe).toBe(false)
  })

  it('invalidates an old confirmation after schema, evidence, mapping or remote snapshot drift', () => {
    const old = confirmedInput()
    const changed = structuredClone(old)
    changed.previousSchema = structuredClone(old.schema)
    changed.schema.version = 'schema-v2'
    changed.schema.immutableEvidence = evidence('schema:v2')
    changed.mapping.version = 'mapping-v2'
    changed.mapping.schemaVersion = 'schema-v2'
    changed.mapping.immutableEvidence = evidence('mapping:v2')
    changed.remoteSnapshot.schemaVersion = 'schema-v2'
    changed.remoteSnapshot.hash = hash('remote:v2')

    const result = evaluatePlatformFieldMapping(changed)
    expect(result.confirmationValid).toBe(false)
    expect(result.blocks).toContainEqual(expect.objectContaining({ code: 'CONFIRMATION_STALE' }))
    expect(result.nextActions).toContain('confirm_current_mapping')
    expect(result.publishable).toBe(false)
  })

  it('surfaces every undeclared source field and allows only explicit, justified ignores', () => {
    const source = input()
    source.source.productFields = { ...source.source.productFields, legacyFlag: 'do-not-drop-silently' }
    let result = evaluatePlatformFieldMapping(source)
    expect(result.unknownFields).toEqual([{ scope: 'product', sourceField: 'legacyFlag', rawValue: 'do-not-drop-silently' }])
    expect(result.blocks).toContainEqual(expect.objectContaining({ code: 'SOURCE_FIELD_UNKNOWN' }))

    source.mapping.rules = [...source.mapping.rules, { scope: 'product', sourceField: 'legacyFlag', ignore: true, reason: 'retired vendor-only read field' }]
    source.remoteSnapshot.confirmation = confirmationFor(source)
    result = evaluatePlatformFieldMapping(source)
    expect(result.unknownFields).toEqual([])
    expect(result.publishable).toBe(true)
  })

  it('preserves a deep raw snapshot on blocked and ignored-field paths without mutating input', () => {
    const source = input()
    source.source.productFields = { ...source.source.productFields, vendorBlob: { nested: ['raw', 7, { keep: true }] } }
    source.source.skuPages[0]!.items[0]!.fields = { ...source.source.skuPages[0]!.items[0]!.fields, price: { amount: '199.999', currency: 'CNY' }, vendorSkuField: { code: 'X' } }
    const before = structuredClone(source.source)
    const blocked = evaluatePlatformFieldMapping(source)

    expect(source.source).toEqual(before)
    expect(blocked.rawSource).toEqual(before)
    expect(blocked.rawSource).not.toBe(source.source)
    expect(blocked.rawSource.productFields.vendorBlob).not.toBe(source.source.productFields.vendorBlob)
    expect(blocked.unknownFields).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'product', sourceField: 'vendorBlob', rawValue: { nested: ['raw', 7, { keep: true }] } }),
      expect.objectContaining({ scope: 'sku', skuId: 'sku-red-s', sourceField: 'vendorSkuField', rawValue: { code: 'X' } }),
    ]))
    expect(blocked.rawSource.skuPages[0]!.items[0]!.fields.price).toEqual({ amount: '199.999', currency: 'CNY' })

    const ignored = structuredClone(source)
    ignored.mapping.rules = [
      ...ignored.mapping.rules,
      { scope: 'product', sourceField: 'vendorBlob', ignore: true, reason: 'vendor read-only diagnostics' },
      { scope: 'sku', sourceField: 'vendorSkuField', ignore: true, reason: 'vendor read-only diagnostics' },
    ]
    const ignoredResult = evaluatePlatformFieldMapping(ignored)
    expect(ignoredResult.unknownFields).toEqual([])
    expect(ignoredResult.rawSource).toEqual(before)
    expect(ignoredResult.blocks).toContainEqual(expect.objectContaining({ code: 'PRICE_PRECISION_DRIFT' }))
  })

  it('fails closed for invalid, changed and externally unverified schema or mapping evidence', () => {
    const invalid = input()
    invalid.schema.immutableEvidence = { ...invalid.schema.immutableEvidence, reference: '', sha256: 'not-a-hash', capturedAt: 'not-a-date' }
    const invalidResult = evaluatePlatformFieldMapping(invalid)
    expect(invalidResult.blocks.map(item => item.code)).toEqual(expect.arrayContaining(['IMMUTABLE_EVIDENCE_INVALID', 'SCHEMA_EXTERNALLY_UNVERIFIED']))
    expect(invalidResult.externallyUnverified).toBe(true)

    const changed = input()
    changed.previousSchema = { ...schema(), immutableEvidence: evidence('schema:old-bytes') }
    const changedResult = evaluatePlatformFieldMapping(changed)
    expect(changedResult.blocks).toContainEqual(expect.objectContaining({ code: 'IMMUTABLE_EVIDENCE_CHANGED' }))
    expect(changedResult.nextActions).toContain('repair_schema_evidence')

    const unverifiedMapping = input()
    unverifiedMapping.mapping.immutableEvidence = evidence('mapping:document-only', 'official_document')
    const mappingResult = evaluatePlatformFieldMapping(unverifiedMapping)
    expect(mappingResult.blocks).toContainEqual(expect.objectContaining({ code: 'MAPPING_EXTERNALLY_UNVERIFIED' }))
    expect(mappingResult.nextActions).toContain('verify_mapping_evidence')
    expect(mappingResult.externallyUnverified).toBe(true)
  })

  it.each(FIELD_MAPPING_PLATFORMS)('marks %s externallyUnverified without production canary evidence', platform => {
    const source = input()
    source.platform = platform
    source.schema.immutableEvidence = evidence(`schema:${platform}`, 'official_document')
    const result = evaluatePlatformFieldMapping(source)
    expect(result.externallyUnverified).toBe(true)
    expect(result.blocks).toContainEqual(expect.objectContaining({ code: 'SCHEMA_EXTERNALLY_UNVERIFIED' }))
    expect(result.publishable).toBe(false)
  })

  it('canonicalizes placement and blocks NFKC-equivalent schema, source-field and SKU identities', () => {
    const source = input()
    source.placement = '  商品详情页  '
    source.schema = { ...source.schema, fields: [...source.schema.fields, { name: 'ｔｉｔｌｅ', scope: 'product', required: false, type: 'string' }, { name: 'placement', scope: 'product', required: false, type: 'string' }] }
    source.mapping.rules = [...source.mapping.rules, { scope: 'product', sourceField: 'placement', targetField: 'placement' }]
    source.source.productFields = { ...source.source.productFields, ｎａｍｅ: 'duplicate title', placement: 'hero', ｐｌａｃｅｍｅｎｔ: 'duplicate hero' }
    source.source.skuPages = [{ items: [
      { skuId: 'sku-1', fields: { price: { amount: '10.00', currency: 'CNY' }, inventory: 1 } },
      { skuId: 'ｓｋｕ－１', fields: { price: { amount: '11.00', currency: 'CNY' }, inventory: 2 } },
    ] }]
    const result = evaluatePlatformFieldMapping(source)

    expect(result.placement).toBe('商品详情页')
    expect(result.blocks.map(item => item.code)).toEqual(expect.arrayContaining(['SCHEMA_DEFINITION_INVALID', 'SOURCE_FIELD_DUPLICATE', 'SOURCE_SKU_DUPLICATE']))
    expect(result.mappedPayload.skus.map(item => item.sourceSkuId)).toEqual(['sku-1', 'sku-1'])
    expect(result.publishable).toBe(false)
  })

  it.each(['__proto__', 'constructor', 'prototype'])('blocks prototype-sensitive target field %s and writes only null-prototype records', targetField => {
    const source = input()
    source.schema = { ...source.schema, fields: [...source.schema.fields, { name: targetField, scope: 'product', required: false, type: 'string' }] }
    source.mapping.rules = [...source.mapping.rules, { scope: 'product', sourceField: 'vendorTarget', targetField }]
    source.source.productFields = { ...source.source.productFields, vendorTarget: 'pollution-attempt' }
    const result = evaluatePlatformFieldMapping(source)

    expect(result.blocks.map(item => item.code)).toEqual(expect.arrayContaining(['SCHEMA_DEFINITION_INVALID', 'MAPPING_RULE_INVALID']))
    expect(Object.getPrototypeOf(result.mappedPayload.product)).toBeNull()
    expect(Object.hasOwn(result.mappedPayload.product, targetField)).toBe(false)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('blocks empty product IDs and invalid finite/range/money schema constraints', () => {
    const source = input()
    source.source.productId = '　 '
    source.schema = {
      ...source.schema,
      fields: source.schema.fields.map(field => field.name === 'stock'
        ? { ...field, range: { min: Number.NaN, max: Number.POSITIVE_INFINITY } }
        : field.name === 'sale_price'
          ? { ...field, range: { min: 'NaN', max: 'Infinity' } }
          : field),
    }
    const result = evaluatePlatformFieldMapping(source)

    expect(result.blocks).toContainEqual(expect.objectContaining({ code: 'SOURCE_PRODUCT_INVALID' }))
    expect(result.blocks.filter(item => item.code === 'SCHEMA_DEFINITION_INVALID').length).toBeGreaterThanOrEqual(2)
    expect(result.mappedPayload.productId).toBe('')

    const reversed = input()
    reversed.schema = { ...reversed.schema, fields: reversed.schema.fields.map(field => field.name === 'sale_price' ? { ...field, range: { min: '100.00', max: '10.00' } } : field) }
    expect(evaluatePlatformFieldMapping(reversed).blocks).toContainEqual(expect.objectContaining({ code: 'SCHEMA_DEFINITION_INVALID', path: 'schema.fields[2].range' }))
  })

  it('rejects cyclic, over-deep and oversized raw sources before cloning or hashing', () => {
    const cyclic = input()
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    cyclic.source.productFields = { ...cyclic.source.productFields, cycle }
    expect(() => evaluatePlatformFieldMapping(cyclic)).toThrowError(expect.objectContaining<Partial<PlatformFieldMappingInputError>>({ code: 'MAPPING_INPUT_CYCLIC' }))

    const oversized = input()
    oversized.source.productFields = { ...oversized.source.productFields, blob: 'x'.repeat(1_000_001) }
    expect(() => evaluatePlatformFieldMapping(oversized)).toThrowError(expect.objectContaining<Partial<PlatformFieldMappingInputError>>({ code: 'MAPPING_INPUT_TOO_LARGE' }))

    const overDeep = input()
    let cursor: Record<string, unknown> = {}
    const root = cursor
    for (let index = 0; index < 22; index += 1) {
      const next: Record<string, unknown> = {}
      cursor.next = next
      cursor = next
    }
    overDeep.source.productFields = { ...overDeep.source.productFields, root }
    expect(() => evaluatePlatformFieldMapping(overDeep)).toThrowError(expect.objectContaining<Partial<PlatformFieldMappingInputError>>({ code: 'MAPPING_INPUT_TOO_LARGE' }))
  })
})
