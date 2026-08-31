import type { SqlClient, SqlPool } from './repository.js'
import { PLATFORM_MEDIA_SPEC_PLATFORMS, type PlatformMediaSpecPlatform } from './platform-media-spec-repository.js'

export interface StoredMappingPreflightApproval {
  workspaceId: string
  platform: PlatformMediaSpecPlatform
  productId: string
  productVersion: number
  mappedPayloadHash: string
  remoteSnapshotHash: string
  schemaVersion: string
  schemaEvidenceHash: string
  mappingVersion: string
  mappingEvidenceHash: string
  publishable: boolean
  confirmationValid: boolean
  externallyUnverified: boolean
  findingCodes: string[]
  evaluatedAt: string
  expiresAt: string
  createdBy: string
  revokedAt?: string
  revision: number
  createdAt: string
  updatedAt: string
}

export interface UpsertMappingPreflightApprovalInput extends Omit<StoredMappingPreflightApproval, 'revision' | 'createdAt' | 'updatedAt' | 'revokedAt'> {
  expectedRevision: number
}
export interface MappingPreflightApprovalScope { workspaceId: string; platform: PlatformMediaSpecPlatform; productId: string }
export interface ResolveMappingPreflightApprovalInput extends MappingPreflightApprovalScope {
  productVersion: number
  mappedPayloadHash: string
  remoteSnapshotHash: string
  schemaVersion: string
  schemaEvidenceHash: string
  mappingVersion: string
  mappingEvidenceHash: string
  at?: string
}
export interface RevokeMappingPreflightApprovalInput extends MappingPreflightApprovalScope { expectedRevision: number; revokedAt?: string }

export interface MappingPreflightApprovalRepository {
  upsert(input: UpsertMappingPreflightApprovalInput): Promise<{ approval: StoredMappingPreflightApproval; replayed: boolean }>
  get(scope: MappingPreflightApprovalScope): Promise<StoredMappingPreflightApproval | undefined>
  resolveActive(input: ResolveMappingPreflightApprovalInput): Promise<StoredMappingPreflightApproval | undefined>
  revoke(input: RevokeMappingPreflightApprovalInput): Promise<{ approval: StoredMappingPreflightApproval; replayed: boolean }>
}

export class MappingPreflightApprovalRepositoryError extends Error {
  constructor(readonly code: 'MAPPING_PREFLIGHT_INVALID' | 'MAPPING_PREFLIGHT_NOT_FOUND' | 'MAPPING_PREFLIGHT_REVISION_CONFLICT' | 'MAPPING_PREFLIGHT_PRODUCT_SCOPE_MISMATCH') { super(code); this.name = 'MappingPreflightApprovalRepositoryError' }
}

const CONTROL = /[\p{Cc}\p{Cf}]/u
const SHA256 = /^[0-9a-f]{64}$/u
const clone = <T>(value: T): T => structuredClone(value)
const error = (code: MappingPreflightApprovalRepositoryError['code']): never => { throw new MappingPreflightApprovalRepositoryError(code) }
const text = (value: unknown, maximum: number, normalize = false) => {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || CONTROL.test(value)) return error('MAPPING_PREFLIGHT_INVALID')
  const result = normalize ? value.trim().normalize('NFKC') : value.trim()
  if (!result || result.length > maximum || CONTROL.test(result)) return error('MAPPING_PREFLIGHT_INVALID')
  return result
}
const sha = (value: unknown) => {
  if (typeof value !== 'string') return error('MAPPING_PREFLIGHT_INVALID')
  const normalized = value.toLowerCase().replace(/^sha256:/u, '')
  if (!SHA256.test(normalized)) return error('MAPPING_PREFLIGHT_INVALID')
  return normalized
}
const instant = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(value) || !Number.isFinite(Date.parse(value))) return error('MAPPING_PREFLIGHT_INVALID')
  return new Date(value).toISOString()
}
const scope = (input: MappingPreflightApprovalScope): MappingPreflightApprovalScope => {
  const workspaceId = text(input.workspaceId, 255)
  const productId = text(input.productId, 255, true)
  if (!PLATFORM_MEDIA_SPEC_PLATFORMS.includes(input.platform)) return error('MAPPING_PREFLIGHT_INVALID')
  return { workspaceId, platform: input.platform, productId }
}
const normalizeUpsert = (input: UpsertMappingPreflightApprovalInput, now: string): UpsertMappingPreflightApprovalInput => {
  const normalizedScope = scope(input)
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || !Number.isSafeInteger(input.productVersion) || input.productVersion < 1) return error('MAPPING_PREFLIGHT_INVALID')
  const evaluatedAt = instant(input.evaluatedAt)
  const expiresAt = instant(input.expiresAt)
  if (evaluatedAt > now || expiresAt <= evaluatedAt || expiresAt <= now) return error('MAPPING_PREFLIGHT_INVALID')
  if (!Array.isArray(input.findingCodes) || input.findingCodes.length > 256) return error('MAPPING_PREFLIGHT_INVALID')
  const findingCodes = [...new Set(input.findingCodes.map(code => text(code, 200, true)))]
  return { ...normalizedScope, productVersion: input.productVersion, mappedPayloadHash: sha(input.mappedPayloadHash), remoteSnapshotHash: sha(input.remoteSnapshotHash), schemaVersion: text(input.schemaVersion, 200, true), schemaEvidenceHash: sha(input.schemaEvidenceHash), mappingVersion: text(input.mappingVersion, 200, true), mappingEvidenceHash: sha(input.mappingEvidenceHash), publishable: input.publishable === true, confirmationValid: input.confirmationValid === true, externallyUnverified: input.externallyUnverified === true, findingCodes, evaluatedAt, expiresAt, createdBy: text(input.createdBy, 255, true), expectedRevision: input.expectedRevision }
}
const sameApproval = (current: StoredMappingPreflightApproval, input: UpsertMappingPreflightApprovalInput) => current.workspaceId === input.workspaceId && current.platform === input.platform && current.productId === input.productId && current.productVersion === input.productVersion && current.mappedPayloadHash === input.mappedPayloadHash && current.remoteSnapshotHash === input.remoteSnapshotHash && current.schemaVersion === input.schemaVersion && current.schemaEvidenceHash === input.schemaEvidenceHash && current.mappingVersion === input.mappingVersion && current.mappingEvidenceHash === input.mappingEvidenceHash && current.publishable === input.publishable && current.confirmationValid === input.confirmationValid && current.externallyUnverified === input.externallyUnverified && JSON.stringify(current.findingCodes) === JSON.stringify(input.findingCodes) && current.evaluatedAt === input.evaluatedAt && current.expiresAt === input.expiresAt && current.createdBy === input.createdBy && !current.revokedAt
const keyOf = (value: MappingPreflightApprovalScope) => JSON.stringify([value.workspaceId, value.platform, value.productId])

export class MemoryMappingPreflightApprovalRepository implements MappingPreflightApprovalRepository {
  private readonly approvals = new Map<string, StoredMappingPreflightApproval>()
  constructor(private readonly clock: () => Date = () => new Date()) {}
  async upsert(raw: UpsertMappingPreflightApprovalInput) {
    const now = this.clock().toISOString(); const input = normalizeUpsert(raw, now); const key = keyOf(input); const current = this.approvals.get(key)
    if (current && sameApproval(current, input)) return { approval: clone(current), replayed: true }
    if (!current && input.expectedRevision !== 0 || current && current.revision !== input.expectedRevision) return error('MAPPING_PREFLIGHT_REVISION_CONFLICT')
    const approval: StoredMappingPreflightApproval = { ...input, revision: (current?.revision ?? 0) + 1, createdAt: current?.createdAt ?? now, updatedAt: now }
    delete (approval as Partial<UpsertMappingPreflightApprovalInput>).expectedRevision
    this.approvals.set(key, approval)
    return { approval: clone(approval), replayed: false }
  }
  async get(raw: MappingPreflightApprovalScope) { const found = this.approvals.get(keyOf(scope(raw))); return found ? clone(found) : undefined }
  async resolveActive(raw: ResolveMappingPreflightApprovalInput) {
    const normalizedScope = scope(raw); const at = raw.at ? instant(raw.at) : this.clock().toISOString(); const found = this.approvals.get(keyOf(normalizedScope))
    if (!found || found.revokedAt || !found.publishable || !found.confirmationValid || found.externallyUnverified || found.expiresAt <= at || found.productVersion !== raw.productVersion || found.mappedPayloadHash !== sha(raw.mappedPayloadHash) || found.remoteSnapshotHash !== sha(raw.remoteSnapshotHash) || found.schemaVersion !== text(raw.schemaVersion, 200, true) || found.schemaEvidenceHash !== sha(raw.schemaEvidenceHash) || found.mappingVersion !== text(raw.mappingVersion, 200, true) || found.mappingEvidenceHash !== sha(raw.mappingEvidenceHash)) return undefined
    return clone(found)
  }
  async revoke(raw: RevokeMappingPreflightApprovalInput) {
    const normalizedScope = scope(raw); const key = keyOf(normalizedScope); const current = this.approvals.get(key); if (!current) return error('MAPPING_PREFLIGHT_NOT_FOUND')
    if (current.revision !== raw.expectedRevision) return error('MAPPING_PREFLIGHT_REVISION_CONFLICT')
    if (current.revokedAt) return { approval: clone(current), replayed: true }
    const revokedAt = raw.revokedAt ? instant(raw.revokedAt) : this.clock().toISOString(); if (revokedAt < current.evaluatedAt) return error('MAPPING_PREFLIGHT_INVALID')
    const approval = { ...current, revokedAt, revision: current.revision + 1, updatedAt: revokedAt }; this.approvals.set(key, approval); return { approval: clone(approval), replayed: false }
  }
}

type ApprovalRow = Omit<StoredMappingPreflightApproval, 'evaluatedAt' | 'expiresAt' | 'revokedAt' | 'createdAt' | 'updatedAt'> & { evaluatedAt: string | Date; expiresAt: string | Date; revokedAt: string | Date | null; createdAt: string | Date; updatedAt: string | Date }
const iso = (value: string | Date) => value instanceof Date ? value.toISOString() : new Date(value).toISOString()
const projection = `workspace_id AS "workspaceId",platform,product_id AS "productId",product_version AS "productVersion",mapped_payload_sha256 AS "mappedPayloadHash",remote_snapshot_sha256 AS "remoteSnapshotHash",schema_version AS "schemaVersion",schema_evidence_sha256 AS "schemaEvidenceHash",mapping_version AS "mappingVersion",mapping_evidence_sha256 AS "mappingEvidenceHash",publishable,confirmation_valid AS "confirmationValid",externally_unverified AS "externallyUnverified",finding_codes AS "findingCodes",evaluated_at AS "evaluatedAt",expires_at AS "expiresAt",revoked_at AS "revokedAt",created_by AS "createdBy",revision,created_at AS "createdAt",updated_at AS "updatedAt"`
const fromRow = (row: ApprovalRow): StoredMappingPreflightApproval => ({ ...row, evaluatedAt: iso(row.evaluatedAt), expiresAt: iso(row.expiresAt), ...(row.revokedAt ? { revokedAt: iso(row.revokedAt) } : { revokedAt: undefined }), createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) })

export class PostgresMappingPreflightApprovalRepository implements MappingPreflightApprovalRepository {
  constructor(private readonly pool: SqlPool, private readonly clock: () => Date = () => new Date()) {}
  private async transaction<T>(workspaceId: string, work: (client: SqlClient) => Promise<T>) { const client = await this.pool.connect(); try { await client.query('BEGIN'); await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]); const result = await work(client); await client.query('COMMIT'); return result } catch (cause) { try { await client.query('ROLLBACK') } catch { /* preserve cause */ } if ((cause as { code?: string }).code === '23503') return error('MAPPING_PREFLIGHT_PRODUCT_SCOPE_MISMATCH'); throw cause } finally { client.release?.() } }
  private async locked(client: SqlClient, value: MappingPreflightApprovalScope) { const row = (await client.query<ApprovalRow>(`SELECT ${projection} FROM platform_mapping_preflight_approvals WHERE workspace_id=$1 AND platform=$2 AND product_id=$3 FOR UPDATE`, [value.workspaceId, value.platform, value.productId])).rows[0]; return row ? fromRow(row) : undefined }
  async upsert(raw: UpsertMappingPreflightApprovalInput) { const now = this.clock().toISOString(); const input = normalizeUpsert(raw, now); return this.transaction(input.workspaceId, async client => { const current = await this.locked(client, input); if (current && sameApproval(current, input)) return { approval: current, replayed: true }; if (!current && input.expectedRevision !== 0 || current && current.revision !== input.expectedRevision) return error('MAPPING_PREFLIGHT_REVISION_CONFLICT'); const values = [input.workspaceId,input.platform,input.productId,input.productVersion,input.mappedPayloadHash,input.remoteSnapshotHash,input.schemaVersion,input.schemaEvidenceHash,input.mappingVersion,input.mappingEvidenceHash,input.publishable,input.confirmationValid,input.externallyUnverified,JSON.stringify(input.findingCodes),input.evaluatedAt,input.expiresAt,input.createdBy,now,input.expectedRevision]; const row = current ? (await client.query<ApprovalRow>(`UPDATE platform_mapping_preflight_approvals SET product_version=$4,mapped_payload_sha256=$5,remote_snapshot_sha256=$6,schema_version=$7,schema_evidence_sha256=$8,mapping_version=$9,mapping_evidence_sha256=$10,publishable=$11,confirmation_valid=$12,externally_unverified=$13,finding_codes=$14,evaluated_at=$15,expires_at=$16,created_by=$17,revoked_at=NULL,revision=revision+1,updated_at=$18 WHERE workspace_id=$1 AND platform=$2 AND product_id=$3 AND revision=$19 RETURNING ${projection}`, values)).rows[0] : (await client.query<ApprovalRow>(`INSERT INTO platform_mapping_preflight_approvals (workspace_id,platform,product_id,product_version,mapped_payload_sha256,remote_snapshot_sha256,schema_version,schema_evidence_sha256,mapping_version,mapping_evidence_sha256,publishable,confirmation_valid,externally_unverified,finding_codes,evaluated_at,expires_at,created_by,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18) RETURNING ${projection}`, values.slice(0, 18))).rows[0]; if (!row) return error('MAPPING_PREFLIGHT_REVISION_CONFLICT'); return { approval: fromRow(row), replayed: false } }) }
  async get(raw: MappingPreflightApprovalScope) { const normalized = scope(raw); return this.transaction(normalized.workspaceId, async client => { const row = (await client.query<ApprovalRow>(`SELECT ${projection} FROM platform_mapping_preflight_approvals WHERE workspace_id=$1 AND platform=$2 AND product_id=$3`, [normalized.workspaceId, normalized.platform, normalized.productId])).rows[0]; return row ? fromRow(row) : undefined }) }
  async resolveActive(raw: ResolveMappingPreflightApprovalInput) { const normalized = scope(raw); const at = raw.at ? instant(raw.at) : this.clock().toISOString(); const values = [normalized.workspaceId,normalized.platform,normalized.productId,raw.productVersion,sha(raw.mappedPayloadHash),sha(raw.remoteSnapshotHash),text(raw.schemaVersion,200,true),sha(raw.schemaEvidenceHash),text(raw.mappingVersion,200,true),sha(raw.mappingEvidenceHash),at]; return this.transaction(normalized.workspaceId, async client => { const row = (await client.query<ApprovalRow>(`SELECT ${projection} FROM platform_mapping_preflight_approvals WHERE workspace_id=$1 AND platform=$2 AND product_id=$3 AND product_version=$4 AND mapped_payload_sha256=$5 AND remote_snapshot_sha256=$6 AND schema_version=$7 AND schema_evidence_sha256=$8 AND mapping_version=$9 AND mapping_evidence_sha256=$10 AND publishable AND confirmation_valid AND NOT externally_unverified AND revoked_at IS NULL AND expires_at>$11`, values)).rows[0]; return row ? fromRow(row) : undefined }) }
  async revoke(raw: RevokeMappingPreflightApprovalInput) { const normalized = scope(raw); const revokedAt = raw.revokedAt ? instant(raw.revokedAt) : this.clock().toISOString(); return this.transaction(normalized.workspaceId, async client => { const current = await this.locked(client, normalized); if (!current) return error('MAPPING_PREFLIGHT_NOT_FOUND'); if (current.revision !== raw.expectedRevision) return error('MAPPING_PREFLIGHT_REVISION_CONFLICT'); if (current.revokedAt) return { approval: current, replayed: true }; if (revokedAt < current.evaluatedAt) return error('MAPPING_PREFLIGHT_INVALID'); const row = (await client.query<ApprovalRow>(`UPDATE platform_mapping_preflight_approvals SET revoked_at=$4,revision=revision+1,updated_at=$4 WHERE workspace_id=$1 AND platform=$2 AND product_id=$3 AND revision=$5 RETURNING ${projection}`, [normalized.workspaceId,normalized.platform,normalized.productId,revokedAt,raw.expectedRevision])).rows[0]; if (!row) return error('MAPPING_PREFLIGHT_REVISION_CONFLICT'); return { approval: fromRow(row), replayed: false } }) }
}
