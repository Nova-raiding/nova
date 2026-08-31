import { AsyncLocalStorage } from 'node:async_hooks'
import type { Pool } from 'pg'
import { hashPlatformMappedPayload, type PlatformFieldMappingGateInput, type TargetFieldDefinition } from '../../../packages/application/src/platform-field-mapping-gate.js'
import type { ConnectorRuntimeMappingPreflightAdapter } from '../../../packages/application/src/connector-runtime.js'
import type { Platform } from '../../../packages/connectors/src/types.js'
import type { MappingPreflightApprovalRepository, StoredMappingPreflightApproval } from '../../../packages/persistence/src/mapping-preflight-approval-repository.js'
import type { DurableOutboxEvent } from '../../../packages/workers/src/durable.js'

export interface WorkerMappingScope {
  workspaceId: string
  taskId: string
  productId: string
  productVersion: number
  platform: Platform
  accountId: string
  category: string
}

export interface WorkerMappingScopeLoader {
  load(input: { workspaceId: string; taskId: string }): Promise<WorkerMappingScope | undefined>
}

export class WorkerMappingPreflightError extends Error {
  readonly normalized: { code: string; message: string; retryable: boolean; unknown: false }

  constructor(code: string, message: string, retryable = false) {
    super(message)
    this.name = 'WorkerMappingPreflightError'
    this.normalized = { code, message, retryable, unknown: false }
  }
}

export class WorkerMappingExecutionContext {
  private readonly storage = new AsyncLocalStorage<DurableOutboxEvent>()

  run<T>(event: DurableOutboxEvent, work: () => Promise<T>): Promise<T> {
    return this.storage.run(event, work)
  }

  current(): DurableOutboxEvent | undefined {
    return this.storage.getStore()
  }
}

export function createPostgresWorkerMappingScopeLoader(pool: Pool): WorkerMappingScopeLoader {
  return {
    async load(input) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query("SELECT set_config('app.workspace_id', $1, true)", [input.workspaceId])
        const row = (await client.query<{
          workspaceId: string
          taskId: string
          productId: string
          productVersion: number
          platform: Platform
          accountId: string | null
          category: string | null
        }>(`SELECT task.workspace_id AS "workspaceId", task.id AS "taskId", task.product_id AS "productId",
              product.version AS "productVersion", task.platform,
              task.platform_account_id AS "accountId", product.category
            FROM tasks task
            INNER JOIN products product
              ON product.workspace_id=task.workspace_id AND product.id=task.product_id
            WHERE task.workspace_id=$1 AND task.id=$2`, [input.workspaceId, input.taskId])).rows[0]
        await client.query('COMMIT')
        if (!row?.category?.trim() || !row.accountId?.trim()) return undefined
        return { ...row, accountId: row.accountId.trim(), category: row.category.trim() }
      } catch (error) {
        try { await client.query('ROLLBACK') } catch { /* preserve the connection failure */ }
        throw error
      } finally {
        client.release()
      }
    },
  }
}

export function createPersistentWorkerMappingPreflightAdapter(input: {
  approvals: Pick<MappingPreflightApprovalRepository, 'get' | 'resolveActive'>
  scopes: WorkerMappingScopeLoader
  execution: WorkerMappingExecutionContext
}): ConnectorRuntimeMappingPreflightAdapter {
  return {
    write: async request => {
      const event = input.execution.current()
      if (!event || event.eventType !== 'publish.requested') throw blocked('MAPPING_PREFLIGHT_CONTEXT_MISSING', 'mapping preflight requires the current durable publish event')
      const taskId = string(event.payload.taskId)
      const eventPlatform = string(event.payload.platform)
      const eventWorkspace = string(event.payload.workspaceId)
      if (!taskId || event.workspaceId !== request.context.workspaceId || eventWorkspace && eventWorkspace !== event.workspaceId || eventPlatform !== request.platform) {
        throw blocked('MAPPING_PREFLIGHT_SCOPE_MISMATCH', 'mapping preflight event, tenant, task, or platform scope does not match')
      }
      if (!sameJson(event.payload.fields, request.fields)) throw blocked('MAPPING_PREFLIGHT_PAYLOAD_MISMATCH', 'mapping preflight fields do not match the durable publish event')
      const eventRemoteId = string(event.payload.remote_id)
      if (request.operation !== 'update' || !eventRemoteId || eventRemoteId !== request.remoteId) {
        throw blocked('MAPPING_PREFLIGHT_OPERATION_MISMATCH', 'mapping preflight create/update scope does not match the durable publish event')
      }
      const eventAccountId = string(event.payload.account_id)
      if (!eventAccountId || eventAccountId !== request.context.accountId) throw blocked('MAPPING_PREFLIGHT_SCOPE_MISMATCH', 'mapping preflight account scope does not match the durable publish event')

      let scope: WorkerMappingScope | undefined
      let stored: StoredMappingPreflightApproval | undefined
      let active: StoredMappingPreflightApproval | undefined
      try {
        scope = await input.scopes.load({ workspaceId: event.workspaceId, taskId })
        if (!scope || scope.workspaceId !== event.workspaceId || scope.taskId !== taskId || scope.platform !== request.platform || scope.accountId !== eventAccountId) {
          throw blocked('MAPPING_PREFLIGHT_SCOPE_MISMATCH', 'persisted task/product scope is missing or belongs to another tenant or platform')
        }
        stored = await input.approvals.get({ workspaceId: scope.workspaceId, platform: scope.platform, productId: scope.productId })
        if (!stored) throw blocked('MAPPING_PREFLIGHT_REQUIRED', 'no persisted mapping preflight approval exists for this tenant and product')
        const candidate = identityGate(scope, stored, request.fields)
        const mappedPayloadHash = candidate.remoteSnapshot.confirmation?.payloadHash
        if (!mappedPayloadHash) throw blocked('MAPPING_PREFLIGHT_PAYLOAD_MISMATCH', 'worker could not bind the durable publish payload to mapping evidence')
        if (mappedPayloadHash !== stored.mappedPayloadHash) throw blocked('MAPPING_PREFLIGHT_PAYLOAD_MISMATCH', 'persisted mapping approval does not cover the durable publish payload')
        active = await input.approvals.resolveActive({
          workspaceId: scope.workspaceId,
          platform: scope.platform,
          productId: scope.productId,
          productVersion: scope.productVersion,
          mappedPayloadHash,
          remoteSnapshotHash: stored.remoteSnapshotHash,
          schemaVersion: stored.schemaVersion,
          schemaEvidenceHash: stored.schemaEvidenceHash,
          mappingVersion: stored.mappingVersion,
          mappingEvidenceHash: stored.mappingEvidenceHash,
        })
      } catch (error) {
        if (error instanceof WorkerMappingPreflightError) throw error
        throw blocked('MAPPING_PREFLIGHT_PERSISTENCE_UNAVAILABLE', error instanceof Error ? `mapping preflight persistence unavailable: ${error.message}` : 'mapping preflight persistence unavailable', true)
      }
      if (!active || active.workspaceId !== scope.workspaceId || active.productId !== scope.productId || active.platform !== scope.platform) {
        throw blocked('MAPPING_PREFLIGHT_REQUIRED', 'persisted mapping preflight approval is expired, revoked, stale, or outside the tenant scope')
      }
      return { gateInput: identityGate(scope, active, request.fields) }
    },
  }
}

function identityGate(scope: WorkerMappingScope, approval: StoredMappingPreflightApproval, rawFields: Readonly<Record<string, unknown>>): PlatformFieldMappingGateInput {
  const fields = safeFields(rawFields)
  const definitions = Object.entries(fields).map(([name, value]) => definition(name, value))
  const evidenceReference = `mapping-preflight-approval://${encodeURIComponent(scope.workspaceId)}/${encodeURIComponent(scope.productId)}/revision/${approval.revision}`
  const schemaEvidence = { state: 'production_canary' as const, reference: `${evidenceReference}/schema`, sha256: approval.schemaEvidenceHash, capturedAt: approval.evaluatedAt }
  const mappingEvidence = { state: 'production_canary' as const, reference: `${evidenceReference}/mapping`, sha256: approval.mappingEvidenceHash, capturedAt: approval.evaluatedAt }
  const mappedPayload = candidateMappedPayload(scope, fields)
  const payloadHash = hashPlatformMappedPayload(mappedPayload)
  return {
    platform: scope.platform,
    category: scope.category,
    schema: { source: 'official', version: approval.schemaVersion, immutableEvidence: schemaEvidence, fields: definitions },
    mapping: {
      version: approval.mappingVersion,
      schemaVersion: approval.schemaVersion,
      immutableEvidence: mappingEvidence,
      rules: definitions.map(field => ({ scope: 'product' as const, sourceField: field.name, targetField: field.name })),
    },
    source: { productId: scope.productId, productFields: fields, skuPages: [{ items: [{ skuId: `product:${scope.productId}`, fields: {} }] }] },
    remoteSnapshot: {
      hash: approval.remoteSnapshotHash,
      schemaVersion: approval.schemaVersion,
      confirmation: {
        id: `worker:${approval.revision}`,
        schemaVersion: approval.schemaVersion,
        schemaEvidenceHash: approval.schemaEvidenceHash,
        mappingVersion: approval.mappingVersion,
        mappingEvidenceHash: approval.mappingEvidenceHash,
        payloadHash,
        remoteSnapshotHash: approval.remoteSnapshotHash,
        confirmedBy: approval.createdBy,
        confirmedAt: approval.evaluatedAt,
      },
    },
  }
}

function candidateMappedPayload(scope: WorkerMappingScope, fields: Readonly<Record<string, unknown>>) {
  return { productId: scope.productId, category: scope.category, product: structuredClone(fields), skus: [{ sourceSkuId: `product:${scope.productId}`, fields: {} }] }
}

function definition(name: string, value: unknown): TargetFieldDefinition {
  if (typeof value === 'string') return { name, scope: 'product', required: true, type: 'string' }
  if (typeof value === 'number' && Number.isFinite(value)) return { name, scope: 'product', required: true, type: Number.isInteger(value) ? 'integer' : 'number' }
  if (typeof value === 'boolean') return { name, scope: 'product', required: true, type: 'boolean' }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const money = value as Record<string, unknown>
    if (typeof money.amount === 'string' && /^-?\d+(?:\.\d+)?$/u.test(money.amount) && typeof money.currency === 'string' && /^[A-Z]{3}$/u.test(money.currency) && Object.keys(money).length === 2 && Object.keys(money).every(key => key === 'amount' || key === 'currency')) {
      return { name, scope: 'product', required: true, type: 'money', money: { scale: money.amount.split('.')[1]?.length ?? 0, currency: money.currency } }
    }
  }
  throw blocked('MAPPING_PREFLIGHT_PAYLOAD_UNSUPPORTED', `connector field ${name} requires an explicit persisted SKU or structured-field mapping`)
}

function safeFields(raw: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const result = Object.create(null) as Record<string, unknown>
  const seen = new Set<string>()
  for (const [name, value] of Object.entries(raw)) {
    const canonical = name.normalize('NFKC').trim()
    if (!canonical || canonical !== name || seen.has(canonical) || ['__proto__', 'constructor', 'prototype'].includes(canonical)) throw blocked('MAPPING_PREFLIGHT_PAYLOAD_UNSAFE', `connector field ${name} is empty, non-canonical, duplicated, or unsafe`)
    seen.add(canonical)
    Object.defineProperty(result, canonical, { value: structuredClone(value), enumerable: true, writable: true, configurable: true })
  }
  if (!seen.size) throw blocked('MAPPING_PREFLIGHT_PAYLOAD_UNSUPPORTED', 'connector write payload has no fields to validate')
  return result
}

function sameJson(left: unknown, right: unknown): boolean {
  try { return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)) } catch { return false }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]))
  return value
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function blocked(code: string, message: string, retryable = false): WorkerMappingPreflightError {
  return new WorkerMappingPreflightError(code, message, retryable)
}
