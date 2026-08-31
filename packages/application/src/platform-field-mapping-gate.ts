import { createHash } from 'node:crypto'

export const FIELD_MAPPING_PLATFORMS = ['taobao', 'tmall', 'jd', 'pinduoduo', 'xiaohongshu', 'douyin'] as const
export type FieldMappingPlatform = typeof FIELD_MAPPING_PLATFORMS[number]
export type MappingFieldScope = 'product' | 'sku'
export type MappingFieldType = 'string' | 'number' | 'integer' | 'boolean' | 'money'

export interface ImmutableSchemaEvidence {
  state: 'production_canary' | 'official_document' | 'vendor_attestation' | 'unverified'
  reference?: string
  sha256: string
  capturedAt: string
}

export interface TargetFieldDefinition {
  name: string
  scope: MappingFieldScope
  required: boolean
  type: MappingFieldType
  enum?: readonly (string | number | boolean)[]
  range?: { min?: number | string; max?: number | string }
  length?: { min?: number; max?: number }
  money?: { scale: number; currency: string }
}

export interface PlatformTargetSchema {
  source: 'official' | 'vendor'
  version: string
  immutableEvidence: ImmutableSchemaEvidence
  fields: readonly TargetFieldDefinition[]
}

export type PlatformMappingRule =
  | { scope: MappingFieldScope; sourceField: string; targetField: string }
  | { scope: MappingFieldScope; sourceField: string; ignore: true; reason: string }

export interface PlatformFieldMapping {
  version: string
  schemaVersion: string
  immutableEvidence: ImmutableSchemaEvidence
  rules: readonly PlatformMappingRule[]
}

export interface SourceSkuRecord {
  skuId: string
  fields: Readonly<Record<string, unknown>>
}

export interface SourceSkuPage {
  cursor?: string
  nextCursor?: string
  items: readonly SourceSkuRecord[]
}

export interface PlatformMappingConfirmation {
  id: string
  schemaVersion: string
  schemaEvidenceHash: string
  mappingVersion: string
  mappingEvidenceHash: string
  payloadHash: string
  remoteSnapshotHash: string
  confirmedBy: string
  confirmedAt: string
}

export interface RemotePlatformSnapshot {
  hash: string
  schemaVersion: string
  confirmation?: PlatformMappingConfirmation
}

export interface PlatformFieldMappingGateInput {
  platform: string
  category: string
  placement?: string
  schema: PlatformTargetSchema
  previousSchema?: PlatformTargetSchema
  mapping: PlatformFieldMapping
  source: {
    productId: string
    productFields: Readonly<Record<string, unknown>>
    skuPages: readonly SourceSkuPage[]
  }
  remoteSnapshot: RemotePlatformSnapshot
}

export type SchemaFieldChangeKind =
  | 'type_changed'
  | 'required_changed'
  | 'enum_added'
  | 'enum_removed'
  | 'range_changed'
  | 'length_changed'
  | 'money_changed'

export interface SchemaFieldChange {
  scope: MappingFieldScope
  field: string
  kinds: SchemaFieldChangeKind[]
  before: TargetFieldDefinition
  after: TargetFieldDefinition
  enumAdded?: readonly (string | number | boolean)[]
  enumRemoved?: readonly (string | number | boolean)[]
}

export interface PlatformSchemaDiff {
  fromVersion?: string
  toVersion: string
  versionChanged: boolean
  addedFields: TargetFieldDefinition[]
  removedFields: TargetFieldDefinition[]
  changedFields: SchemaFieldChange[]
}

export type MappingGateFindingCode =
  | 'PLATFORM_UNKNOWN'
  | 'SCHEMA_EXTERNALLY_UNVERIFIED'
  | 'MAPPING_EXTERNALLY_UNVERIFIED'
  | 'IMMUTABLE_EVIDENCE_INVALID'
  | 'IMMUTABLE_EVIDENCE_CHANGED'
  | 'SCHEMA_DEFINITION_INVALID'
  | 'SCHEMA_MAPPING_VERSION_MISMATCH'
  | 'SCHEMA_REQUIRED_FIELD_ADDED'
  | 'SCHEMA_REQUIRED_FIELD_CHANGED'
  | 'SCHEMA_ENUM_CHANGED'
  | 'SCHEMA_FIELD_CHANGED'
  | 'MAPPING_RULE_INVALID'
  | 'SOURCE_PAGINATION_DIRTY'
  | 'SOURCE_SKU_INVALID'
  | 'SOURCE_SKU_DUPLICATE'
  | 'SOURCE_FIELD_DUPLICATE'
  | 'SOURCE_PRODUCT_INVALID'
  | 'SOURCE_FIELD_UNKNOWN'
  | 'TARGET_FIELD_UNMAPPED'
  | 'TARGET_REQUIRED_MISSING'
  | 'TARGET_TYPE_MISMATCH'
  | 'TARGET_ENUM_MISMATCH'
  | 'TARGET_RANGE_MISMATCH'
  | 'TARGET_LENGTH_MISMATCH'
  | 'PRICE_PRECISION_DRIFT'
  | 'REMOTE_SCHEMA_VERSION_MISMATCH'
  | 'CONFIRMATION_REQUIRED'
  | 'CONFIRMATION_STALE'

export type PlatformFieldMappingInputErrorCode = 'MAPPING_INPUT_TOO_LARGE' | 'MAPPING_INPUT_CYCLIC' | 'MAPPING_INPUT_UNSUPPORTED'

export class PlatformFieldMappingInputError extends Error {
  constructor(readonly code: PlatformFieldMappingInputErrorCode, message: string, readonly path: string) {
    super(message)
    this.name = 'PlatformFieldMappingInputError'
  }
}

export interface MappingGateFinding {
  code: MappingGateFindingCode
  severity: 'block' | 'warn'
  path: string
  message: string
}

export interface MappingProvenance {
  scope: MappingFieldScope
  sourceField: string
  targetField: string
  skuId?: string
  rawValue: unknown
  mappingVersion: string
  mappingEvidenceHash: string
  schemaVersion: string
  schemaEvidenceHash: string
}

export interface UnknownSourceField {
  scope: MappingFieldScope
  sourceField: string
  skuId?: string
  rawValue: unknown
}

export interface MappedPlatformPayload {
  productId: string
  category: string
  product: Record<string, unknown>
  skus: Array<{ sourceSkuId: string; fields: Record<string, unknown> }>
}

export type MappingGateNextAction =
  | 'verify_platform_schema'
  | 'verify_mapping_evidence'
  | 'repair_schema_evidence'
  | 'update_mapping_version'
  | 'map_new_required_fields'
  | 'review_enum_change'
  | 'review_schema_change'
  | 'clean_source_pagination'
  | 'resolve_unknown_fields'
  | 'repair_sku_mapping'
  | 'repair_field_value'
  | 'refresh_remote_snapshot'
  | 'confirm_current_mapping'

export interface PlatformFieldMappingGateResult {
  platform: string
  category: string
  placement?: string
  externallyUnverified: boolean
  mappingSafe: boolean
  publishable: boolean
  confirmationValid: boolean
  mappedPayload: MappedPlatformPayload
  mappedPayloadHash: string
  rawSource: PlatformFieldMappingGateInput['source']
  provenance: MappingProvenance[]
  unknownFields: UnknownSourceField[]
  schemaDiff: PlatformSchemaDiff
  findings: MappingGateFinding[]
  blocks: MappingGateFinding[]
  warnings: MappingGateFinding[]
  nextActions: MappingGateNextAction[]
}

const sha256Pattern = /^[a-f0-9]{64}$/u
const clean = (value: string | undefined) => value?.normalize('NFKC').trim() ?? ''
const unsafeTargetFields = new Set(['__proto__', 'constructor', 'prototype'])
const clone = <T>(value: T): T => structuredClone(value)
const safeRecord = (): Record<string, unknown> => Object.create(null) as Record<string, unknown>

const rawLimits = { maxDepth: 20, maxNodes: 20_000, maxStringBytes: 1_000_000, maxArrayLength: 5_000, maxObjectKeys: 2_000 }

function assertBoundedRawSource(value: unknown) {
  const seen = new WeakSet<object>()
  let nodes = 0
  let stringBytes = 0
  const visit = (current: unknown, path: string, depth: number): void => {
    nodes += 1
    if (nodes > rawLimits.maxNodes || depth > rawLimits.maxDepth) throw new PlatformFieldMappingInputError('MAPPING_INPUT_TOO_LARGE', 'raw source 超出节点或嵌套深度限制', path)
    if (typeof current === 'string') {
      stringBytes += Buffer.byteLength(current, 'utf8')
      if (stringBytes > rawLimits.maxStringBytes) throw new PlatformFieldMappingInputError('MAPPING_INPUT_TOO_LARGE', 'raw source 字符串总量超过 1MB', path)
      return
    }
    if (current === null || current === undefined || typeof current === 'boolean' || typeof current === 'number') return
    if (typeof current !== 'object') throw new PlatformFieldMappingInputError('MAPPING_INPUT_UNSUPPORTED', 'raw source 只允许 JSON 兼容值', path)
    if (seen.has(current)) throw new PlatformFieldMappingInputError('MAPPING_INPUT_CYCLIC', 'raw source 包含循环或重复对象引用', path)
    seen.add(current)
    if (Array.isArray(current)) {
      if (current.length > rawLimits.maxArrayLength) throw new PlatformFieldMappingInputError('MAPPING_INPUT_TOO_LARGE', `raw source 数组超过 ${rawLimits.maxArrayLength} 项`, path)
      current.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1))
      return
    }
    const prototype = Object.getPrototypeOf(current)
    if (prototype !== Object.prototype && prototype !== null) throw new PlatformFieldMappingInputError('MAPPING_INPUT_UNSUPPORTED', 'raw source 只允许普通对象', path)
    const descriptors = Object.getOwnPropertyDescriptors(current)
    const keys = Object.keys(descriptors)
    if (keys.length > rawLimits.maxObjectKeys) throw new PlatformFieldMappingInputError('MAPPING_INPUT_TOO_LARGE', `raw source 单个对象超过 ${rawLimits.maxObjectKeys} 个字段`, path)
    for (const key of keys) {
      stringBytes += Buffer.byteLength(key, 'utf8')
      if (stringBytes > rawLimits.maxStringBytes) throw new PlatformFieldMappingInputError('MAPPING_INPUT_TOO_LARGE', 'raw source 字段名与字符串总量超过 1MB', `${path}.${key}`)
      const descriptor = descriptors[key]!
      if (!('value' in descriptor)) throw new PlatformFieldMappingInputError('MAPPING_INPUT_UNSUPPORTED', 'raw source 禁止 getter/setter', `${path}.${key}`)
      visit(descriptor.value, `${path}.${key}`, depth + 1)
    }
  }
  visit(value, 'source', 0)
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

export function hashPlatformMappedPayload(payload: MappedPlatformPayload): string {
  return createHash('sha256').update(stable(payload)).digest('hex')
}

const definitionKey = (field: Pick<TargetFieldDefinition, 'scope' | 'name'>) => `${field.scope}:${clean(field.name)}`
const valueKey = (value: unknown) => `${typeof value}:${stable(value)}`
const same = (left: unknown, right: unknown) => stable(left) === stable(right)

function schemaDiff(current: PlatformTargetSchema, previous?: PlatformTargetSchema): PlatformSchemaDiff {
  if (!previous) return { toVersion: current.version, versionChanged: false, addedFields: [], removedFields: [], changedFields: [] }
  const before = new Map(previous.fields.map(field => [definitionKey(field), field]))
  const after = new Map(current.fields.map(field => [definitionKey(field), field]))
  const addedFields = current.fields.filter(field => !before.has(definitionKey(field))).map(clone)
  const removedFields = previous.fields.filter(field => !after.has(definitionKey(field))).map(clone)
  const changedFields: SchemaFieldChange[] = []
  for (const field of current.fields) {
    const old = before.get(definitionKey(field))
    if (!old) continue
    const kinds: SchemaFieldChangeKind[] = []
    if (old.type !== field.type) kinds.push('type_changed')
    if (old.required !== field.required) kinds.push('required_changed')
    const oldEnum = new Map((old.enum ?? []).map(value => [valueKey(value), value]))
    const newEnum = new Map((field.enum ?? []).map(value => [valueKey(value), value]))
    const enumAdded = [...newEnum].filter(([key]) => !oldEnum.has(key)).map(([, value]) => value)
    const enumRemoved = [...oldEnum].filter(([key]) => !newEnum.has(key)).map(([, value]) => value)
    if (enumAdded.length) kinds.push('enum_added')
    if (enumRemoved.length) kinds.push('enum_removed')
    if (!same(old.range, field.range)) kinds.push('range_changed')
    if (!same(old.length, field.length)) kinds.push('length_changed')
    if (!same(old.money, field.money)) kinds.push('money_changed')
    if (kinds.length) changedFields.push({ scope: field.scope, field: field.name, kinds, before: clone(old), after: clone(field), ...(enumAdded.length ? { enumAdded } : {}), ...(enumRemoved.length ? { enumRemoved } : {}) })
  }
  return { fromVersion: previous.version, toVersion: current.version, versionChanged: previous.version !== current.version, addedFields, removedFields, changedFields }
}

interface DecimalValue { units: bigint; scale: number }

function decimal(value: unknown): DecimalValue | undefined {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) return undefined
  const negative = value.startsWith('-')
  const unsigned = negative ? value.slice(1) : value
  const [whole, fraction = ''] = unsigned.split('.')
  const units = BigInt(`${whole}${fraction}`) * (negative ? -1n : 1n)
  return { units, scale: fraction.length }
}

function compareDecimal(left: DecimalValue, right: DecimalValue) {
  const scale = Math.max(left.scale, right.scale)
  const normalize = (input: DecimalValue) => input.units * (10n ** BigInt(scale - input.scale))
  const a = normalize(left); const b = normalize(right)
  return a < b ? -1 : a > b ? 1 : 0
}

function evidenceValid(evidence: ImmutableSchemaEvidence) {
  return sha256Pattern.test(evidence.sha256) && Boolean(clean(evidence.reference)) && !Number.isNaN(Date.parse(evidence.capturedAt))
}

function exactType(value: unknown, definition: TargetFieldDefinition) {
  if (definition.type === 'string') return typeof value === 'string'
  if (definition.type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (definition.type === 'integer') return typeof value === 'number' && Number.isInteger(value)
  if (definition.type === 'boolean') return typeof value === 'boolean'
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const money = value as Record<string, unknown>
  return typeof money.amount === 'string' && typeof money.currency === 'string' && Object.keys(money).every(key => key === 'amount' || key === 'currency')
}

function validateValue(value: unknown, definition: TargetFieldDefinition, path: string, add: (finding: MappingGateFinding) => void) {
  if (!exactType(value, definition)) {
    add({ code: 'TARGET_TYPE_MISMATCH', severity: 'block', path, message: `${definition.name} 必须保持 ${definition.type} 原始类型，禁止猜测强转` })
    return false
  }
  const comparable = definition.type === 'money' ? decimal((value as { amount: string }).amount) : undefined
  if (definition.type === 'money') {
    const money = value as { amount: string; currency: string }
    if (!definition.money || money.currency !== definition.money.currency || !comparable || comparable.scale !== definition.money.scale) {
      add({ code: 'PRICE_PRECISION_DRIFT', severity: 'block', path, message: `${definition.name} 币种或小数精度与 schema 不一致，禁止舍入` })
      return false
    }
  }
  if (definition.enum && !definition.enum.some(candidate => same(candidate, value))) {
    add({ code: 'TARGET_ENUM_MISMATCH', severity: 'block', path, message: `${definition.name} 不在当前 schema 枚举中` })
    return false
  }
  if (definition.length && typeof value === 'string') {
    const length = [...value].length
    if ((definition.length.min !== undefined && length < definition.length.min) || (definition.length.max !== undefined && length > definition.length.max)) {
      add({ code: 'TARGET_LENGTH_MISMATCH', severity: 'block', path, message: `${definition.name} 长度不符合 schema` })
      return false
    }
  }
  if (definition.range) {
    let below = false; let above = false
    if (definition.type === 'money' && comparable) {
      const min = definition.range.min === undefined ? undefined : decimal(String(definition.range.min))
      const max = definition.range.max === undefined ? undefined : decimal(String(definition.range.max))
      below = Boolean(min && compareDecimal(comparable, min) < 0)
      above = Boolean(max && compareDecimal(comparable, max) > 0)
    } else if (typeof value === 'number') {
      below = typeof definition.range.min === 'number' && value < definition.range.min
      above = typeof definition.range.max === 'number' && value > definition.range.max
    }
    if (below || above) {
      add({ code: 'TARGET_RANGE_MISMATCH', severity: 'block', path, message: `${definition.name} 超出 schema 范围` })
      return false
    }
  }
  return true
}

function validateSchemaDefinitions(schema: PlatformTargetSchema, add: (finding: MappingGateFinding) => void) {
  const seen = new Set<string>()
  schema.fields.forEach((field, index) => {
    const path = `schema.fields[${index}]`
    const key = definitionKey(field)
    const canonicalName = clean(field.name)
    if (!canonicalName || seen.has(key) || (field.enum && new Set(field.enum.map(value => typeof value === 'string' ? `string:${clean(value)}` : valueKey(value))).size !== field.enum.length)) add({ code: 'SCHEMA_DEFINITION_INVALID', severity: 'block', path, message: 'schema 字段名/scope 在 NFKC 规范化后重复、为空或枚举重复' })
    if (unsafeTargetFields.has(canonicalName)) add({ code: 'SCHEMA_DEFINITION_INVALID', severity: 'block', path: `${path}.name`, message: `目标字段 ${canonicalName} 为原型敏感保留名` })
    if (field.length && (field.type !== 'string' || !Number.isInteger(field.length.min ?? 0) || !Number.isInteger(field.length.max ?? 0) || (field.length.min ?? 0) < 0 || (field.length.max !== undefined && field.length.max < (field.length.min ?? 0)))) add({ code: 'SCHEMA_DEFINITION_INVALID', severity: 'block', path, message: '字段长度约束无效或用于非 string 字段' })
    const moneyShapeValid = field.type !== 'money' || (field.money && Number.isInteger(field.money.scale) && field.money.scale >= 0 && field.money.scale <= 8 && Boolean(clean(field.money.currency)))
    if (!moneyShapeValid || (field.type !== 'money' && field.money !== undefined)) add({ code: 'SCHEMA_DEFINITION_INVALID', severity: 'block', path, message: 'money 字段必须且仅能声明 0-8 位精度和币种' })
    if (field.enum) {
      const enumValid = field.enum.every(value => {
        if (typeof value === 'number' && !Number.isFinite(value)) return false
        if (field.type === 'string') return typeof value === 'string'
        if (field.type === 'number') return typeof value === 'number'
        if (field.type === 'integer') return typeof value === 'number' && Number.isInteger(value)
        if (field.type === 'boolean') return typeof value === 'boolean'
        return false
      })
      if (!enumValid) add({ code: 'SCHEMA_DEFINITION_INVALID', severity: 'block', path: `${path}.enum`, message: '枚举值必须与字段类型精确一致且为有限值' })
    }
    if (field.range) {
      let rangeValid = true
      if (field.type === 'number' || field.type === 'integer') {
        const min = field.range.min; const max = field.range.max
        rangeValid = (min === undefined || (typeof min === 'number' && Number.isFinite(min) && (field.type !== 'integer' || Number.isInteger(min))))
          && (max === undefined || (typeof max === 'number' && Number.isFinite(max) && (field.type !== 'integer' || Number.isInteger(max))))
          && !(typeof min === 'number' && typeof max === 'number' && min > max)
      } else if (field.type === 'money' && field.money) {
        const min = field.range.min === undefined || typeof field.range.min !== 'string' ? undefined : decimal(field.range.min)
        const max = field.range.max === undefined || typeof field.range.max !== 'string' ? undefined : decimal(field.range.max)
        rangeValid = (field.range.min === undefined || Boolean(min && min.scale === field.money.scale))
          && (field.range.max === undefined || Boolean(max && max.scale === field.money.scale))
          && !(min && max && compareDecimal(min, max) > 0)
      } else rangeValid = false
      if (!rangeValid) add({ code: 'SCHEMA_DEFINITION_INVALID', severity: 'block', path: `${path}.range`, message: 'range 必须是有限、同类型且 min <= max；money range 必须使用与价格相同精度的十进制字符串' })
    }
    seen.add(key)
  })
}

function validatePages(pages: readonly SourceSkuPage[], add: (finding: MappingGateFinding) => void) {
  const skus: SourceSkuRecord[] = []
  const cursors = new Set<string>()
  if (!pages.length) add({ code: 'SOURCE_SKU_INVALID', severity: 'block', path: 'source.skuPages', message: 'SKU 分页不能为空，禁止把缺失 SKU 解释为空库存' })
  pages.forEach((page, index) => {
    const expected = index === 0 ? undefined : pages[index - 1]?.nextCursor
    if (page.cursor !== expected || (page.cursor && cursors.has(page.cursor)) || (page.nextCursor && page.nextCursor === page.cursor) || (page.nextCursor && page.items.length === 0) || (index === pages.length - 1 && page.nextCursor !== undefined)) add({ code: 'SOURCE_PAGINATION_DIRTY', severity: 'block', path: `source.skuPages[${index}]`, message: 'SKU 分页 cursor 链断裂、循环或存在空中间页' })
    if (page.cursor) cursors.add(page.cursor)
    skus.push(...page.items)
  })
  const ids = new Set<string>()
  skus.forEach((sku, index) => {
    const canonicalSkuId = clean(sku.skuId)
    if (!canonicalSkuId) add({ code: 'SOURCE_SKU_INVALID', severity: 'block', path: `source.skus[${index}].skuId`, message: 'SKU ID 不能为空，禁止合并匿名 SKU' })
    else if (ids.has(canonicalSkuId)) add({ code: 'SOURCE_SKU_DUPLICATE', severity: 'block', path: `source.skus[${index}].skuId`, message: `SKU ${sku.skuId} 在 NFKC 规范化后跨页重复，禁止合并` })
    ids.add(canonicalSkuId)
  })
  if (pages.length && !skus.length) add({ code: 'SOURCE_SKU_INVALID', severity: 'block', path: 'source.skuPages', message: 'SKU 分页没有任何记录，必须确认源数据完整性' })
  return skus
}

export function evaluatePlatformFieldMapping(input: PlatformFieldMappingGateInput): PlatformFieldMappingGateResult {
  assertBoundedRawSource(input.source)
  const findings: MappingGateFinding[] = []
  const add = (finding: MappingGateFinding) => findings.push(finding)
  const platform = clean(input.platform)
  const category = clean(input.category)
  const placement = input.placement === undefined ? undefined : clean(input.placement)
  const knownPlatform = (FIELD_MAPPING_PLATFORMS as readonly string[]).includes(platform)
  if (!knownPlatform) add({ code: 'PLATFORM_UNKNOWN', severity: 'block', path: 'platform', message: `未知平台 ${input.platform}` })
  if (!category) add({ code: 'SCHEMA_DEFINITION_INVALID', severity: 'block', path: 'category', message: 'category 不能为空' })
  if (input.placement !== undefined && (!placement || placement.length > 200)) add({ code: 'SCHEMA_DEFINITION_INVALID', severity: 'block', path: 'placement', message: 'placement 规范化后必须为 1-200 个字符' })
  const productId = clean(input.source.productId)
  if (!productId) add({ code: 'SOURCE_PRODUCT_INVALID', severity: 'block', path: 'source.productId', message: 'productId 规范化后不能为空' })

  const schemaEvidenceValid = evidenceValid(input.schema.immutableEvidence)
  const mappingEvidenceValid = evidenceValid(input.mapping.immutableEvidence)
  if (!schemaEvidenceValid || (input.previousSchema && !evidenceValid(input.previousSchema.immutableEvidence))) add({ code: 'IMMUTABLE_EVIDENCE_INVALID', severity: 'block', path: 'schema.immutableEvidence', message: 'schema immutable evidence 缺少有效引用、时间或 SHA-256' })
  if (!mappingEvidenceValid) add({ code: 'IMMUTABLE_EVIDENCE_INVALID', severity: 'block', path: 'mapping.immutableEvidence', message: 'mapping immutable evidence 缺少有效引用、时间或 SHA-256' })
  const schemaVerified = schemaEvidenceValid && input.schema.immutableEvidence.state === 'production_canary'
  const mappingVerified = mappingEvidenceValid && input.mapping.immutableEvidence.state === 'production_canary'
  if (!schemaVerified) add({ code: 'SCHEMA_EXTERNALLY_UNVERIFIED', severity: 'block', path: 'schema.immutableEvidence.state', message: '平台 schema 尚未通过真实 production canary 验证' })
  if (!mappingVerified) add({ code: 'MAPPING_EXTERNALLY_UNVERIFIED', severity: 'block', path: 'mapping.immutableEvidence.state', message: '字段 mapping 尚未通过真实 production canary 验证' })
  if (input.previousSchema?.version === input.schema.version && input.previousSchema.immutableEvidence.sha256 !== input.schema.immutableEvidence.sha256) add({ code: 'IMMUTABLE_EVIDENCE_CHANGED', severity: 'block', path: 'schema.immutableEvidence.sha256', message: '同一 schema 版本的 immutable evidence hash 发生变化' })
  if (input.mapping.schemaVersion !== input.schema.version) add({ code: 'SCHEMA_MAPPING_VERSION_MISMATCH', severity: 'block', path: 'mapping.schemaVersion', message: 'mapping version 未绑定当前 schema version' })
  validateSchemaDefinitions(input.schema, add)

  const diff = schemaDiff(input.schema, input.previousSchema)
  diff.addedFields.forEach(field => add({ code: field.required ? 'SCHEMA_REQUIRED_FIELD_ADDED' : 'SCHEMA_FIELD_CHANGED', severity: field.required ? 'block' : 'warn', path: `schema.${definitionKey(field)}`, message: `${field.required ? '新增必填' : '新增可选'}字段 ${field.name}` }))
  diff.removedFields.forEach(field => add({ code: 'SCHEMA_FIELD_CHANGED', severity: field.required ? 'block' : 'warn', path: `schema.${definitionKey(field)}`, message: `${field.required ? '原必填' : '可选'}字段 ${field.name} 已从 schema 删除，需明确处理其源字段` }))
  diff.changedFields.forEach(change => {
    if (change.kinds.includes('required_changed') && change.after.required) add({ code: 'SCHEMA_REQUIRED_FIELD_CHANGED', severity: 'block', path: `schema.${change.scope}:${change.field}`, message: `${change.field} 已变为必填字段` })
    else if (change.kinds.includes('enum_added') || change.kinds.includes('enum_removed')) add({ code: 'SCHEMA_ENUM_CHANGED', severity: change.kinds.includes('enum_removed') ? 'block' : 'warn', path: `schema.${change.scope}:${change.field}`, message: `${change.field} 枚举发生变化` })
    else add({ code: 'SCHEMA_FIELD_CHANGED', severity: 'warn', path: `schema.${change.scope}:${change.field}`, message: `${change.field} 约束发生变化，需复核 mapping` })
  })

  const targets = new Map(input.schema.fields.map(field => [definitionKey(field), field]))
  const mappedTargets = new Set<string>()
  const declaredSources = new Map<string, PlatformMappingRule>()
  input.mapping.rules.forEach((rule, index) => {
    const canonicalSourceField = clean(rule.sourceField)
    const sourceKey = `${rule.scope}:${canonicalSourceField}`
    if (!canonicalSourceField || declaredSources.has(sourceKey)) add({ code: 'MAPPING_RULE_INVALID', severity: 'block', path: `mapping.rules[${index}]`, message: 'source field mapping 在 NFKC 规范化后重复或为空' })
    declaredSources.set(sourceKey, rule)
    if ('ignore' in rule) {
      if (!clean(rule.reason)) add({ code: 'MAPPING_RULE_INVALID', severity: 'block', path: `mapping.rules[${index}].reason`, message: '显式忽略字段必须提供理由' })
      return
    }
    const canonicalTargetField = clean(rule.targetField)
    const targetKey = `${rule.scope}:${canonicalTargetField}`
    if (unsafeTargetFields.has(canonicalTargetField) || !targets.has(targetKey) || mappedTargets.has(targetKey)) add({ code: 'MAPPING_RULE_INVALID', severity: 'block', path: `mapping.rules[${index}]`, message: 'target field 不存在、为原型敏感保留名或被多个 source 合并' })
    mappedTargets.add(targetKey)
  })
  input.schema.fields.filter(field => field.required && !mappedTargets.has(definitionKey(field))).forEach(field => add({ code: 'TARGET_FIELD_UNMAPPED', severity: 'block', path: `mapping.${definitionKey(field)}`, message: `必填目标字段 ${field.name} 没有 mapping` }))

  const sourceSkus = validatePages(input.source.skuPages, add)
  const mappedPayload: MappedPlatformPayload = { productId, category, product: safeRecord(), skus: sourceSkus.map(sku => ({ sourceSkuId: clean(sku.skuId), fields: safeRecord() })) }
  const provenance: MappingProvenance[] = []
  const unknownFields: UnknownSourceField[] = []

  const mapFields = (scope: MappingFieldScope, fields: Readonly<Record<string, unknown>>, output: Record<string, unknown>, skuId?: string) => {
    const seenSourceFields = new Set<string>()
    for (const [sourceField, rawValue] of Object.entries(fields)) {
      const canonicalSourceField = clean(sourceField)
      if (!canonicalSourceField || seenSourceFields.has(canonicalSourceField)) {
        add({ code: 'SOURCE_FIELD_DUPLICATE', severity: 'block', path: scope === 'sku' ? `source.skus.${skuId}.fields.${sourceField}` : `source.productFields.${sourceField}`, message: `源字段 ${sourceField} 在 NFKC 规范化后为空或重复` })
        continue
      }
      seenSourceFields.add(canonicalSourceField)
      const rule = declaredSources.get(`${scope}:${canonicalSourceField}`)
      const sourcePath = scope === 'sku' ? `source.skus.${skuId}.fields.${sourceField}` : `source.productFields.${sourceField}`
      if (!rule) {
        unknownFields.push({ scope, sourceField, ...(skuId ? { skuId } : {}), rawValue: clone(rawValue) })
        add({ code: 'SOURCE_FIELD_UNKNOWN', severity: 'block', path: sourcePath, message: `源字段 ${sourceField} 未声明 mapping 或显式 ignore，禁止静默丢失` })
        continue
      }
      if ('ignore' in rule) continue
      const canonicalTargetField = clean(rule.targetField)
      if (unsafeTargetFields.has(canonicalTargetField)) continue
      const definition = targets.get(`${scope}:${canonicalTargetField}`)
      if (!definition) continue
      if (validateValue(rawValue, definition, sourcePath, add)) {
        Object.defineProperty(output, canonicalTargetField, { value: clone(rawValue), enumerable: true, writable: true, configurable: true })
        provenance.push({ scope, sourceField, targetField: canonicalTargetField, ...(skuId ? { skuId: clean(skuId) } : {}), rawValue: clone(rawValue), mappingVersion: input.mapping.version, mappingEvidenceHash: input.mapping.immutableEvidence.sha256, schemaVersion: input.schema.version, schemaEvidenceHash: input.schema.immutableEvidence.sha256 })
      }
    }
  }
  mapFields('product', input.source.productFields, mappedPayload.product)
  sourceSkus.forEach((sku, index) => mapFields('sku', sku.fields, mappedPayload.skus[index]!.fields, sku.skuId))

  for (const definition of input.schema.fields) {
    if (!definition.required) continue
    const canonicalName = clean(definition.name)
    if (definition.scope === 'product' && !Object.hasOwn(mappedPayload.product, canonicalName)) add({ code: 'TARGET_REQUIRED_MISSING', severity: 'block', path: `mappedPayload.product.${canonicalName}`, message: `必填商品字段 ${canonicalName} 缺失或无效` })
    if (definition.scope === 'sku') mappedPayload.skus.forEach((sku, index) => {
      if (!Object.hasOwn(sku.fields, canonicalName)) add({ code: 'TARGET_REQUIRED_MISSING', severity: 'block', path: `mappedPayload.skus[${index}].fields.${canonicalName}`, message: `SKU ${sku.sourceSkuId || '(empty)'} 必填字段 ${canonicalName} 缺失或无效，禁止 SKU 合并` })
    })
  }

  const mappedPayloadHash = hashPlatformMappedPayload(mappedPayload)
  if (input.remoteSnapshot.schemaVersion !== input.schema.version) add({ code: 'REMOTE_SCHEMA_VERSION_MISMATCH', severity: 'block', path: 'remoteSnapshot.schemaVersion', message: '远端当前 schema version 与本次 mapping 不一致' })
  if (!sha256Pattern.test(input.remoteSnapshot.hash)) add({ code: 'IMMUTABLE_EVIDENCE_INVALID', severity: 'block', path: 'remoteSnapshot.hash', message: '远端 snapshot hash 无效' })
  const confirmation = input.remoteSnapshot.confirmation
  const confirmationValid = Boolean(confirmation
    && clean(confirmation.id)
    && clean(confirmation.confirmedBy)
    && !Number.isNaN(Date.parse(confirmation.confirmedAt))
    && confirmation.schemaVersion === input.schema.version
    && confirmation.schemaEvidenceHash === input.schema.immutableEvidence.sha256
    && confirmation.mappingVersion === input.mapping.version
    && confirmation.mappingEvidenceHash === input.mapping.immutableEvidence.sha256
    && confirmation.payloadHash === mappedPayloadHash
    && confirmation.remoteSnapshotHash === input.remoteSnapshot.hash)
  if (!confirmation) add({ code: 'CONFIRMATION_REQUIRED', severity: 'block', path: 'remoteSnapshot.confirmation', message: '当前 schema/mapping/payload/remote snapshot 尚未独立确认' })
  else if (!confirmationValid) add({ code: 'CONFIRMATION_STALE', severity: 'block', path: 'remoteSnapshot.confirmation', message: '旧确认与当前 schema、mapping、payload 或远端 snapshot 不一致，必须失效' })

  const nextActions = new Set<MappingGateNextAction>()
  for (const finding of findings) {
    if (finding.code === 'PLATFORM_UNKNOWN' || finding.code === 'SCHEMA_EXTERNALLY_UNVERIFIED') nextActions.add('verify_platform_schema')
    else if (finding.code === 'MAPPING_EXTERNALLY_UNVERIFIED') nextActions.add('verify_mapping_evidence')
    else if (finding.code.startsWith('IMMUTABLE_EVIDENCE')) nextActions.add('repair_schema_evidence')
    else if (finding.code === 'SCHEMA_MAPPING_VERSION_MISMATCH') nextActions.add('update_mapping_version')
    else if (finding.code === 'SCHEMA_REQUIRED_FIELD_ADDED' || finding.code === 'SCHEMA_REQUIRED_FIELD_CHANGED' || finding.code === 'TARGET_FIELD_UNMAPPED') nextActions.add('map_new_required_fields')
    else if (finding.code === 'SCHEMA_ENUM_CHANGED') nextActions.add('review_enum_change')
    else if (finding.code === 'SCHEMA_FIELD_CHANGED') nextActions.add('review_schema_change')
    else if (finding.code === 'SOURCE_PAGINATION_DIRTY' || finding.code === 'SOURCE_SKU_DUPLICATE') nextActions.add('clean_source_pagination')
    else if (finding.code === 'SOURCE_FIELD_UNKNOWN') nextActions.add('resolve_unknown_fields')
    else if (finding.code === 'SOURCE_SKU_INVALID' || (finding.code === 'TARGET_REQUIRED_MISSING' && finding.path.includes('.skus'))) nextActions.add('repair_sku_mapping')
    else if (finding.code.startsWith('TARGET_') || finding.code === 'PRICE_PRECISION_DRIFT') nextActions.add('repair_field_value')
    else if (finding.code === 'REMOTE_SCHEMA_VERSION_MISMATCH') nextActions.add('refresh_remote_snapshot')
    else if (finding.code === 'CONFIRMATION_REQUIRED' || finding.code === 'CONFIRMATION_STALE') nextActions.add('confirm_current_mapping')
  }
  const blocks = findings.filter(finding => finding.severity === 'block')
  const warnings = findings.filter(finding => finding.severity === 'warn')
  const externallyUnverified = !knownPlatform || !schemaVerified || !mappingVerified
  const nonConfirmationBlocks = blocks.filter(finding => finding.code !== 'CONFIRMATION_REQUIRED' && finding.code !== 'CONFIRMATION_STALE')
  return { platform, category, ...(placement !== undefined ? { placement } : {}), externallyUnverified, mappingSafe: nonConfirmationBlocks.length === 0, publishable: blocks.length === 0 && confirmationValid && !externallyUnverified, confirmationValid, mappedPayload, mappedPayloadHash, rawSource: clone(input.source), provenance, unknownFields, schemaDiff: diff, findings, blocks, warnings, nextActions: [...nextActions] }
}
