import { createHash } from 'node:crypto'
import type { Platform, Product } from '../../../packages/application/src/service.js'
import { ConnectorMappingPreflightError, type ConnectorRuntimeMappingPreflightAdapter } from '../../../packages/application/src/connector-runtime.js'
import { evaluatePlatformFieldMapping, type PlatformFieldMappingGateInput, type PlatformFieldMappingGateResult } from '../../../packages/application/src/platform-field-mapping-gate.js'
import type { MappingPreflightApprovalRepository, StoredMappingPreflightApproval } from '../../../packages/persistence/src/mapping-preflight-approval-repository.js'

export type ConnectorMappingProduct = Pick<Product, 'id' | 'workspaceId' | 'platform' | 'accountId' | 'remoteId' | 'category' | 'version'>
export type ConnectorMappingProductLookup = (input: { workspaceId: string; platform: Platform; accountId: string; remoteId?: string }) => ConnectorMappingProduct | undefined | Promise<ConnectorMappingProduct | undefined>

function connectorMappingFieldType(value: unknown): 'string' | 'number' | 'integer' | 'boolean' | 'money' | undefined {
  if (typeof value === 'string') return 'string'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number' && Number.isFinite(value)) return Number.isInteger(value) ? 'integer' : 'number'
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const money = value as Record<string, unknown>
    if (Object.keys(money).length === 2 && typeof money.amount === 'string' && /^-?\d+(?:\.\d+)?$/u.test(money.amount) && typeof money.currency === 'string' && /^[A-Z]{3}$/u.test(money.currency)) return 'money'
  }
  return undefined
}

export function buildConnectorMappingGate(input: { approval: StoredMappingPreflightApproval; product: ConnectorMappingProduct; sourceProductId: string; fields: Readonly<Record<string, unknown>>; category: string }): PlatformFieldMappingGateInput | undefined {
  const entries = Object.entries(input.fields)
  const seen = new Set<string>()
  const definitions: PlatformFieldMappingGateInput['schema']['fields'][number][] = []
  const rules: PlatformFieldMappingGateInput['mapping']['rules'][number][] = []
  for (const [field, value] of entries) {
    const canonical = field.normalize('NFKC').trim()
    const type = connectorMappingFieldType(value)
    if (!canonical || canonical !== field || seen.has(canonical) || ['__proto__', 'constructor', 'prototype'].includes(canonical) || !type) return undefined
    seen.add(canonical)
    definitions.push({ name: canonical, scope: 'product', required: true, type, ...(type === 'money' ? { money: { scale: ((value as { amount: string }).amount.split('.')[1] ?? '').length, currency: (value as { currency: string }).currency } } : {}) })
    rules.push({ scope: 'product', sourceField: canonical, targetField: canonical })
  }
  const category = input.category.normalize('NFKC').trim()
  const sourceProductId = input.sourceProductId.normalize('NFKC').trim()
  if (!category || !sourceProductId) return undefined
  const evidence = (sha256: string, kind: 'schema' | 'mapping') => ({ state: 'production_canary' as const, reference: `urn:merchant:mapping-preflight:${kind}:${sha256}`, sha256, capturedAt: input.approval.evaluatedAt })
  const gate: PlatformFieldMappingGateInput = {
    platform: input.product.platform,
    category,
    schema: { source: 'official', version: input.approval.schemaVersion, immutableEvidence: evidence(input.approval.schemaEvidenceHash, 'schema'), fields: definitions },
    mapping: { version: input.approval.mappingVersion, schemaVersion: input.approval.schemaVersion, immutableEvidence: evidence(input.approval.mappingEvidenceHash, 'mapping'), rules },
    source: { productId: sourceProductId, productFields: structuredClone(input.fields), skuPages: [{ items: [{ skuId: `product:${input.product.id}`, fields: {} }] }] },
    remoteSnapshot: { hash: input.approval.remoteSnapshotHash, schemaVersion: input.approval.schemaVersion },
  }
  let preview: PlatformFieldMappingGateResult
  try { preview = evaluatePlatformFieldMapping(gate) } catch { return undefined }
  gate.remoteSnapshot.confirmation = {
    id: `durable-mapping-preflight-r${input.approval.revision}`,
    schemaVersion: input.approval.schemaVersion,
    schemaEvidenceHash: input.approval.schemaEvidenceHash,
    mappingVersion: input.approval.mappingVersion,
    mappingEvidenceHash: input.approval.mappingEvidenceHash,
    payloadHash: preview.mappedPayloadHash,
    remoteSnapshotHash: input.approval.remoteSnapshotHash,
    confirmedBy: 'durable-mapping-preflight',
    confirmedAt: input.approval.evaluatedAt,
  }
  return gate
}

export function createApiConnectorMappingPreflightAdapter(input: { repository: () => MappingPreflightApprovalRepository | Promise<MappingPreflightApprovalRepository>; findProduct: ConnectorMappingProductLookup; governanceGatesRequired: () => boolean; canonicalJson: (value: unknown) => string }): ConnectorRuntimeMappingPreflightAdapter {
  const activeGate = async (scope: { workspaceId: string; platform: Platform; accountId: string; remoteId?: string }, fields: Readonly<Record<string, unknown>>, sourceProductId: 'local' | 'remote', category: string) => {
    if (!scope.workspaceId.trim() || !scope.accountId.trim()) return undefined
    const product = await input.findProduct(scope)
    if (!product || product.workspaceId !== scope.workspaceId || product.platform !== scope.platform || product.accountId !== scope.accountId || (scope.remoteId !== undefined && product.remoteId !== scope.remoteId)) return undefined
    const repository = await input.repository()
    const approval = await repository.get({ workspaceId: scope.workspaceId, platform: scope.platform, productId: product.id })
    if (!approval) return undefined
    const localGate = buildConnectorMappingGate({ approval, product, sourceProductId: product.id, fields, category })
    if (!localGate) return undefined
    const localReport = evaluatePlatformFieldMapping(localGate)
    if (!localReport.publishable || localReport.externallyUnverified) return undefined
    const active = await repository.resolveActive({
      workspaceId: scope.workspaceId,
      platform: scope.platform,
      productId: product.id,
      productVersion: product.version ?? 1,
      mappedPayloadHash: localReport.mappedPayloadHash,
      remoteSnapshotHash: approval.remoteSnapshotHash,
      schemaVersion: approval.schemaVersion,
      schemaEvidenceHash: approval.schemaEvidenceHash,
      mappingVersion: approval.mappingVersion,
      mappingEvidenceHash: approval.mappingEvidenceHash,
    })
    if (!active) return undefined
    return sourceProductId === 'local' ? localGate : buildConnectorMappingGate({ approval: active, product, sourceProductId: scope.remoteId!, fields, category })
  }
  return {
    sync: async ({ platform, context, rawProduct }) => {
      if (!input.governanceGatesRequired()) return undefined
      const fields: Record<string, unknown> = {
        title: rawProduct.title,
        description: rawProduct.description,
        price: rawProduct.price,
        stock: rawProduct.stock,
        category: rawProduct.category,
        merchantSourcePayloadSha256: createHash('sha256').update(input.canonicalJson({ remoteId: rawProduct.remoteId, title: rawProduct.title, description: rawProduct.description, price: rawProduct.price, stock: rawProduct.stock, sku: rawProduct.sku, images: rawProduct.images, category: rawProduct.category, attributes: rawProduct.attributes, platformFields: rawProduct.platformFields, listingStatus: rawProduct.listingStatus ?? null })).digest('hex'),
      }
      if (rawProduct.listingStatus !== undefined) fields.listingStatus = rawProduct.listingStatus
      for (const [field, value] of Object.entries(rawProduct.platformFields)) {
        if (Object.hasOwn(fields, field)) return undefined
        fields[field] = value
      }
      const gate = await activeGate({ workspaceId: context.workspaceId, platform, accountId: context.accountId, remoteId: rawProduct.remoteId }, fields, 'remote', rawProduct.category)
      if (!gate) throw new ConnectorMappingPreflightError('sync', `mapping preflight approval is missing, stale, expired, or outside ${platform}/${context.accountId}/${rawProduct.remoteId}`)
      return gate
    },
    write: async ({ platform, context, fields, remoteId, operation }) => {
      if (operation !== 'update' || !remoteId) return undefined
      const gateInput = await activeGate({ workspaceId: context.workspaceId, platform, accountId: context.accountId, remoteId }, fields, 'local', typeof fields.category === 'string' ? fields.category : '')
      return gateInput ? { gateInput } : undefined
    },
  }
}

