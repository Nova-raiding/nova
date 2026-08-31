import { requireWorkspaceScope, type SqlPool, withWorkspaceTransaction } from './repository.js'
import { mapCanonicalBackfillConflictRow, type CanonicalBackfillConflictRow, type ConflictVerificationEvidence } from './canonical-backfill-conflict-repository.js'

export class CanonicalBackfillRemediationError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'CanonicalBackfillRemediationError' }
}

type ConflictRow = {
  id: string; workspace_id: string; run_id: string; legacy_product_id: string; code: string; canonical_ids: string[]
  status: 'open' | 'claimed' | 'resolved' | 'dismissed'; assignee_id: string | null; resolution_note: string | null
  verification_evidence: ConflictVerificationEvidence | null; revision: number; created_at: string | Date; updated_at: string | Date
}

const projection = 'id,workspace_id,run_id,legacy_product_id,code,canonical_ids,status,assignee_id,resolution_note,verification_evidence,revision,created_at,updated_at'
const text = (value: string, code: string) => { if (!value.trim()) throw new CanonicalBackfillRemediationError(code); return value.trim() }

/** Atomic human-approved repair for the only currently safe conflict: a missing legacy brand. */
export class PostgresCanonicalBackfillRemediationRepository {
  constructor(private readonly pool: SqlPool) {}

  async setLegacyBrand(input: {
    workspaceId: string; conflictId: string; expectedConflictRevision: number; expectedProductVersion: number
    brandId: string; actorId: string; reason: string; resolutionNote: string; reference?: string
  }): Promise<CanonicalBackfillConflictRow> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    if (!Number.isSafeInteger(input.expectedConflictRevision) || input.expectedConflictRevision < 1) throw new CanonicalBackfillRemediationError('CANONICAL_BACKFILL_CONFLICT_REVISION_INVALID')
    if (!Number.isSafeInteger(input.expectedProductVersion) || input.expectedProductVersion < 1) throw new CanonicalBackfillRemediationError('CANONICAL_BACKFILL_SOURCE_VERSION_INVALID')
    const conflictId = text(input.conflictId, 'CANONICAL_BACKFILL_CONFLICT_ID_REQUIRED')
    const brandId = text(input.brandId, 'CANONICAL_BACKFILL_REMEDIATION_BRAND_REQUIRED')
    const actorId = text(input.actorId, 'CANONICAL_BACKFILL_REMEDIATION_ACTOR_REQUIRED')
    const reason = text(input.reason, 'CANONICAL_BACKFILL_REMEDIATION_REASON_REQUIRED')
    const resolutionNote = text(input.resolutionNote, 'CANONICAL_BACKFILL_RESOLUTION_REQUIRED')

    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const conflict = (await client.query<ConflictRow>(`SELECT ${projection} FROM canonical_backfill_conflicts WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [workspaceId, conflictId])).rows[0]
      if (!conflict) throw new CanonicalBackfillRemediationError('CANONICAL_BACKFILL_CONFLICT_NOT_FOUND')
      if (conflict.revision !== input.expectedConflictRevision) throw new CanonicalBackfillRemediationError('CANONICAL_BACKFILL_CONFLICT_REVISION_CONFLICT')
      if (conflict.status !== 'claimed') throw new CanonicalBackfillRemediationError('CANONICAL_BACKFILL_CONFLICT_STATE_INVALID')
      if (conflict.code !== 'MISSING_BRAND' || conflict.canonical_ids.length !== 1) throw new CanonicalBackfillRemediationError('CANONICAL_BACKFILL_REMEDIATION_UNSUPPORTED')

      const product = (await client.query<{ id: string; brand_id: string | null; version: number; data: Record<string, unknown> }>(
        `SELECT id,brand_id,version,data FROM products WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [workspaceId, conflict.legacy_product_id],
      )).rows[0]
      if (!product) throw new CanonicalBackfillRemediationError('CANONICAL_BACKFILL_SOURCE_NOT_FOUND')
      if (product.version !== input.expectedProductVersion) throw new CanonicalBackfillRemediationError('CANONICAL_BACKFILL_SOURCE_VERSION_CONFLICT')
      if (product.brand_id !== null) throw new CanonicalBackfillRemediationError('CANONICAL_BACKFILL_SOURCE_ALREADY_BRANDED')

      const canonical = (await client.query<{ id: string; brand_id: string; legacy_product_id: string | null }>(
        `SELECT id,brand_id,legacy_product_id FROM canonical_products WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [workspaceId, conflict.canonical_ids[0]],
      )).rows[0]
      if (!canonical || canonical.legacy_product_id !== product.id) throw new CanonicalBackfillRemediationError('CANONICAL_BACKFILL_CANONICAL_MAPPING_INVALID')
      if (canonical.brand_id !== brandId) throw new CanonicalBackfillRemediationError('CANONICAL_BACKFILL_REMEDIATION_BRAND_MISMATCH')

      const updatedProduct = (await client.query<{ version: number; brand_id: string | null }>(
        `UPDATE products SET data=jsonb_set(data,'{brandId}',to_jsonb($3::text),true),version=version+1,updated_at=now()
          WHERE workspace_id=$1 AND id=$2 AND version=$4 AND brand_id IS NULL RETURNING version,brand_id`,
        [workspaceId, product.id, brandId, input.expectedProductVersion],
      )).rows[0]
      if (!updatedProduct || updatedProduct.brand_id !== brandId) throw new CanonicalBackfillRemediationError('CANONICAL_BACKFILL_REMEDIATION_WRITE_FAILED')

      const verified = (await client.query<{ id: string; brand_id: string; legacy_brand_id: string | null }>(
        `SELECT cp.id,cp.brand_id,p.brand_id AS legacy_brand_id FROM canonical_products cp
           JOIN products p ON p.workspace_id=cp.workspace_id AND p.id=cp.legacy_product_id
          WHERE cp.workspace_id=$1 AND cp.id=$2 AND cp.legacy_product_id=$3 AND cp.brand_id IS NOT NULL AND p.brand_id IS NOT NULL AND cp.brand_id=p.brand_id`,
        [workspaceId, canonical.id, product.id],
      )).rows[0]
      if (!verified) throw new CanonicalBackfillRemediationError('CANONICAL_BACKFILL_RECHECK_FAILED')

      const checkedAt = new Date().toISOString()
      const evidence: ConflictVerificationEvidence = {
        schemaVersion: 'canonical-backfill-conflict-remediation/1', observedCode: conflict.code, observedCanonicalIds: [...conflict.canonical_ids],
        source: 'canonical-backfill-remediation', checkedAt, ...(input.reference ? { reference: input.reference.slice(0, 500) } : {}),
        remediationType: 'set_legacy_brand', actorId, legacyBrandBefore: null, legacyBrandAfter: brandId,
        canonicalBrandId: canonical.brand_id, productVersionBefore: input.expectedProductVersion, productVersionAfter: updatedProduct.version,
        migration106Equivalent: true,
      }
      const resolved = (await client.query<ConflictRow>(
        `UPDATE canonical_backfill_conflicts SET status='resolved',resolution_note=$4,verification_evidence=$5::jsonb,revision=revision+1,updated_at=now()
          WHERE workspace_id=$1 AND id=$2 AND revision=$3 AND status='claimed' RETURNING ${projection}`,
        [workspaceId, conflictId, input.expectedConflictRevision, `${resolutionNote}\nreason: ${reason}`, JSON.stringify(evidence)],
      )).rows[0]
      if (!resolved) throw new CanonicalBackfillRemediationError('CANONICAL_BACKFILL_CONFLICT_REVISION_CONFLICT')
      return mapCanonicalBackfillConflictRow(resolved)
    })
  }
}

export type CanonicalBackfillRemediationClient = Pick<PostgresCanonicalBackfillRemediationRepository, 'setLegacyBrand'>
