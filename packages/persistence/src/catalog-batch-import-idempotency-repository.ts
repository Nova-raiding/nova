import { createHash, randomUUID } from 'node:crypto'
import { requireWorkspaceScope, type SqlPool, withWorkspaceTransaction } from './repository.js'

export type CatalogBatchImportClaimInput = { workspaceId: string; actorId: string; key: string; requestHash: string }
export type CatalogBatchImportClaim = { kind: 'claimed'; token: string } | { kind: 'completed'; result: Record<string, unknown> } | { kind: 'in_progress' } | { kind: 'needs_reconciliation' }
export interface CatalogBatchImportIdempotencyRepository {
  claim(input: CatalogBatchImportClaimInput): Promise<CatalogBatchImportClaim>
  start(input: CatalogBatchImportClaimInput & { token: string }): Promise<void>
  releaseBeforeSideEffects(input: CatalogBatchImportClaimInput & { token: string }): Promise<void>
  complete(input: CatalogBatchImportClaimInput & { token: string; result: Record<string, unknown> }): Promise<void>
  markNeedsReconciliation(input: CatalogBatchImportClaimInput & { token: string }): Promise<void>
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  // Idempotency hashes must be identical across hosts regardless of their
  // default ICU locale. Object-key order is a byte-level wire convention here,
  // so use code-point ordering instead of localeCompare.
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => [key, canonicalize(item)]))
}
export function hashCatalogBatchImportRequest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}
export function hashCatalogBatchImportIntent(input: { items: unknown; draftOnly?: boolean; sourceAssetId?: string | null; manualSource?: { reference: string; sha256: string } | null }): string {
  return hashCatalogBatchImportRequest({ operation: 'catalog.import.batch.v1', draftOnly: input.draftOnly ?? false, items: input.items, sourceAssetId: input.sourceAssetId ?? null, manualSource: input.manualSource ?? null })
}

export class CatalogBatchImportIdempotencyError extends Error {
  constructor(readonly code: 'PRODUCT_IMPORT_IDEMPOTENCY_CONFLICT' | 'PRODUCT_IMPORT_IDEMPOTENCY_CLAIM_LOST', message: string) { super(message); this.name = 'CatalogBatchImportIdempotencyError' }
}

export class MemoryCatalogBatchImportIdempotencyRepository implements CatalogBatchImportIdempotencyRepository {
  private readonly records = new Map<string, { actorId: string; hash: string; token: string; status: 'claimed' | 'in_progress' | 'retryable_failed' | 'needs_reconciliation' | 'completed'; claimExpiresAt?: number; startedAt?: number; result?: Record<string, unknown> }>()
  private identity(input: CatalogBatchImportClaimInput) { return `${input.workspaceId}\u0000catalog.import.batch.v1\u0000${input.actorId}\u0000${input.key}` }
  async claim(input: CatalogBatchImportClaimInput): Promise<CatalogBatchImportClaim> {
    const id = this.identity(input); const current = this.records.get(id)
    if (current) {
      if (current.hash !== input.requestHash || current.actorId !== input.actorId) throw new CatalogBatchImportIdempotencyError('PRODUCT_IMPORT_IDEMPOTENCY_CONFLICT', '幂等键已用于不同的批量导入请求')
      if (current.status === 'completed') return { kind: 'completed', result: structuredClone(current.result!) }
      if (current.status === 'needs_reconciliation') return { kind: 'needs_reconciliation' }
      if (current.status === 'in_progress') {
        if (current.startedAt && current.startedAt < Date.now() - 30 * 60_000) { current.status = 'needs_reconciliation'; return { kind: 'needs_reconciliation' } }
        return { kind: 'in_progress' }
      }
      if (current.status === 'claimed' && (current.claimExpiresAt ?? 0) > Date.now()) return { kind: 'in_progress' }
      const token = randomUUID(); current.token = token; current.status = 'claimed'; current.claimExpiresAt = Date.now() + 5 * 60_000
      return { kind: 'claimed', token }
    }
    const token = randomUUID(); this.records.set(id, { actorId: input.actorId, hash: input.requestHash, token, status: 'claimed', claimExpiresAt: Date.now() + 5 * 60_000 }); return { kind: 'claimed', token }
  }
  async start(input: CatalogBatchImportClaimInput & { token: string }) { const row = this.records.get(this.identity(input)); if (!row || row.token !== input.token || row.status !== 'claimed' || (row.claimExpiresAt ?? 0) <= Date.now()) throw new CatalogBatchImportIdempotencyError('PRODUCT_IMPORT_IDEMPOTENCY_CLAIM_LOST', '批量导入幂等认领已失效'); row.status = 'in_progress'; row.startedAt = Date.now(); delete row.claimExpiresAt }
  async releaseBeforeSideEffects(input: CatalogBatchImportClaimInput & { token: string }) { const row = this.records.get(this.identity(input)); if (!row || row.token !== input.token || row.status !== 'claimed') return; row.status = 'retryable_failed'; delete row.claimExpiresAt }
  async complete(input: CatalogBatchImportClaimInput & { token: string; result: Record<string, unknown> }) {
    const row = this.records.get(this.identity(input)); if (!row || row.token !== input.token || !['in_progress', 'needs_reconciliation'].includes(row.status)) throw new CatalogBatchImportIdempotencyError('PRODUCT_IMPORT_IDEMPOTENCY_CLAIM_LOST', '批量导入幂等认领已失效')
    row.status = 'completed'; row.result = structuredClone(input.result)
  }
  async markNeedsReconciliation(input: CatalogBatchImportClaimInput & { token: string }) {
    const row = this.records.get(this.identity(input)); if (!row || row.token !== input.token || row.status !== 'in_progress') return
    row.status = 'needs_reconciliation'
  }
}

type ClaimRow = { actor_id: string; request_hash: string; status: 'claimed' | 'in_progress' | 'retryable_failed' | 'needs_reconciliation' | 'completed'; result_json: Record<string, unknown> | null; claim_token: string; claim_expires_at: string | null; started_at: string | null }
export class PostgresCatalogBatchImportIdempotencyRepository implements CatalogBatchImportIdempotencyRepository {
  constructor(private readonly pool: SqlPool) {}
  async claim(input: CatalogBatchImportClaimInput): Promise<CatalogBatchImportClaim> {
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`catalog.import.batch.v1:${input.workspaceId}:${input.actorId}:${input.key}`])
      const found = await client.query<ClaimRow>(`SELECT actor_id,request_hash,status,result_json,claim_token,claim_expires_at,started_at FROM catalog_batch_import_idempotency WHERE workspace_id=$1 AND actor_id=$2 AND operation='catalog.import.batch.v1' AND idempotency_key=$3 FOR UPDATE`, [input.workspaceId, input.actorId, input.key])
      const row = found.rows[0]
      if (row) {
        if (row.request_hash !== input.requestHash) throw new CatalogBatchImportIdempotencyError('PRODUCT_IMPORT_IDEMPOTENCY_CONFLICT', '幂等键已用于不同的批量导入请求')
        if (row.status === 'completed' && row.result_json) return { kind: 'completed', result: row.result_json }
        if (row.status === 'needs_reconciliation') return { kind: 'needs_reconciliation' }
        if (row.status === 'in_progress') {
          if (row.started_at && new Date(row.started_at).getTime() < Date.now() - 30 * 60_000) {
            await client.query(`UPDATE catalog_batch_import_idempotency SET status='needs_reconciliation' WHERE workspace_id=$1 AND actor_id=$2 AND operation='catalog.import.batch.v1' AND idempotency_key=$3 AND status='in_progress'`, [input.workspaceId, input.actorId, input.key])
            return { kind: 'needs_reconciliation' }
          }
          return { kind: 'in_progress' }
        }
        if (row.status === 'claimed' && row.claim_expires_at && new Date(row.claim_expires_at).getTime() > Date.now()) return { kind: 'in_progress' }
        const token = randomUUID()
        await client.query(`UPDATE catalog_batch_import_idempotency SET status='claimed',claim_token=$5,claim_expires_at=now()+interval '5 minutes' WHERE workspace_id=$1 AND actor_id=$2 AND operation='catalog.import.batch.v1' AND idempotency_key=$3 AND request_hash=$4`, [input.workspaceId, input.actorId, input.key, input.requestHash, token])
        return { kind: 'claimed', token }
      }
      const token = randomUUID()
      await client.query(`INSERT INTO catalog_batch_import_idempotency(workspace_id,actor_id,operation,idempotency_key,request_hash,status,claim_token,claim_expires_at) VALUES($1,$2,'catalog.import.batch.v1',$3,$4,'claimed',$5,now()+interval '5 minutes')`, [input.workspaceId, input.actorId, input.key, input.requestHash, token])
      return { kind: 'claimed', token }
    })
  }
  async start(input: CatalogBatchImportClaimInput & { token: string }) {
    requireWorkspaceScope(input.workspaceId)
    await withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const updated = await client.query(`UPDATE catalog_batch_import_idempotency SET status='in_progress',claim_expires_at=NULL,started_at=now() WHERE workspace_id=$1 AND actor_id=$2 AND operation='catalog.import.batch.v1' AND idempotency_key=$3 AND request_hash=$4 AND claim_token=$5 AND status='claimed' AND claim_expires_at>now()`, [input.workspaceId, input.actorId, input.key, input.requestHash, input.token])
      if (updated.rowCount !== 1) throw new CatalogBatchImportIdempotencyError('PRODUCT_IMPORT_IDEMPOTENCY_CLAIM_LOST', '批量导入幂等认领已失效')
    })
  }
  async releaseBeforeSideEffects(input: CatalogBatchImportClaimInput & { token: string }) {
    requireWorkspaceScope(input.workspaceId)
    await withWorkspaceTransaction(this.pool, input.workspaceId, async client => { await client.query(`UPDATE catalog_batch_import_idempotency SET status='retryable_failed',claim_expires_at=NULL WHERE workspace_id=$1 AND actor_id=$2 AND operation='catalog.import.batch.v1' AND idempotency_key=$3 AND request_hash=$4 AND claim_token=$5 AND status='claimed'`, [input.workspaceId, input.actorId, input.key, input.requestHash, input.token]) })
  }
  async complete(input: CatalogBatchImportClaimInput & { token: string; result: Record<string, unknown> }) {
    requireWorkspaceScope(input.workspaceId)
    await withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const updated = await client.query(`UPDATE catalog_batch_import_idempotency SET status='completed',result_json=$6::jsonb,completed_at=now() WHERE workspace_id=$1 AND actor_id=$2 AND operation='catalog.import.batch.v1' AND idempotency_key=$3 AND request_hash=$4 AND claim_token=$5 AND status IN ('in_progress','needs_reconciliation')`, [input.workspaceId, input.actorId, input.key, input.requestHash, input.token, JSON.stringify(input.result)])
      if (updated.rowCount !== 1) throw new CatalogBatchImportIdempotencyError('PRODUCT_IMPORT_IDEMPOTENCY_CLAIM_LOST', '批量导入幂等认领已失效')
    })
  }
  async markNeedsReconciliation(input: CatalogBatchImportClaimInput & { token: string }) {
    requireWorkspaceScope(input.workspaceId)
    await withWorkspaceTransaction(this.pool, input.workspaceId, async client => { await client.query(`UPDATE catalog_batch_import_idempotency SET status='needs_reconciliation' WHERE workspace_id=$1 AND actor_id=$2 AND operation='catalog.import.batch.v1' AND idempotency_key=$3 AND request_hash=$4 AND claim_token=$5 AND status='in_progress'`, [input.workspaceId, input.actorId, input.key, input.requestHash, input.token]) })
  }
}
