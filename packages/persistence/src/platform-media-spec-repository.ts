import { createHash, randomUUID } from 'node:crypto'
import type { SqlClient, SqlPool } from './repository.js'

export const PLATFORM_MEDIA_SPEC_PLATFORMS = ['taobao', 'tmall', 'jd', 'pinduoduo', 'xiaohongshu', 'douyin'] as const
export type PlatformMediaSpecPlatform = typeof PLATFORM_MEDIA_SPEC_PLATFORMS[number]
export type PlatformMediaSpecDevice = 'desktop' | 'mobile'
export type PlatformMediaSpecStatus = 'draft' | 'approved' | 'expired'
export type PlatformMediaSpecActorRole = 'merchant_ops' | 'workspace'

export interface PlatformMediaSpecActor { actorId: string; actorRole: PlatformMediaSpecActorRole }
export interface StoredPlatformMediaSpec {
  id: string
  platform: PlatformMediaSpecPlatform
  placement: string
  device: PlatformMediaSpecDevice
  version: string
  specJson: Record<string, unknown>
  sourceUrl: string
  sourceSha256: string
  checkedAt: string
  evidenceArtifactRef?: string
  evidenceArtifactSha256?: string
  immutableDigest: string
  status: PlatformMediaSpecStatus
  expiresAt?: string
  revision: number
  createdBy: string
  updatedBy: string
  approvedBy?: string
  approvedAt?: string
  createdAt: string
  updatedAt: string
}

export interface PlatformMediaSpecAudit {
  id: string
  specId: string
  eventType: 'created' | 'updated' | 'approved' | 'expired' | 'auto_expired'
  actorId: string
  actorRole: 'merchant_ops' | 'system'
  reason: string
  idempotencyKey: string
  requestHash: string
  before?: StoredPlatformMediaSpec
  after: StoredPlatformMediaSpec
  createdAt: string
}

export interface CreatePlatformMediaSpecInput extends PlatformMediaSpecActor {
  id?: string
  platform: PlatformMediaSpecPlatform
  placement: string
  device: PlatformMediaSpecDevice
  version: string
  specJson: Record<string, unknown>
  sourceUrl: string
  sourceSha256: string
  checkedAt: string
  evidenceArtifactRef?: string
  evidenceArtifactSha256?: string
  expiresAt?: string
  reason: string
  idempotencyKey: string
}
export interface UpdatePlatformMediaSpecInput extends PlatformMediaSpecActor {
  id: string
  expectedRevision: number
  patch: Partial<Pick<CreatePlatformMediaSpecInput, 'placement' | 'device' | 'version' | 'specJson' | 'sourceUrl' | 'sourceSha256' | 'checkedAt' | 'evidenceArtifactRef' | 'evidenceArtifactSha256' | 'expiresAt'>>
  reason: string
  idempotencyKey: string
}
export interface TransitionPlatformMediaSpecInput extends PlatformMediaSpecActor { id: string; expectedRevision: number; reason: string; idempotencyKey: string }
export interface PlatformMediaSpecScope { platform: PlatformMediaSpecPlatform; placement: string; device: PlatformMediaSpecDevice; at?: string }

export interface PlatformMediaSpecRepository {
  createDraft(input: CreatePlatformMediaSpecInput): Promise<{ spec: StoredPlatformMediaSpec; replayed: boolean }>
  updateDraft(input: UpdatePlatformMediaSpecInput): Promise<{ spec: StoredPlatformMediaSpec; replayed: boolean }>
  approve(input: TransitionPlatformMediaSpecInput): Promise<{ spec: StoredPlatformMediaSpec; replayed: boolean }>
  expire(input: TransitionPlatformMediaSpecInput): Promise<{ spec: StoredPlatformMediaSpec; replayed: boolean }>
  get(id: string, at?: string): Promise<StoredPlatformMediaSpec | undefined>
  list(input?: Partial<Omit<PlatformMediaSpecScope, 'at'>> & { status?: PlatformMediaSpecStatus; at?: string }): Promise<StoredPlatformMediaSpec[]>
  resolveActive(input: PlatformMediaSpecScope): Promise<StoredPlatformMediaSpec | undefined>
  listAudit(specId: string): Promise<PlatformMediaSpecAudit[]>
}

export class PlatformMediaSpecRepositoryError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'PlatformMediaSpecRepositoryError' }
}

const clone = <T>(value: T): T => structuredClone(value)
const MAX_SPEC_JSON_DEPTH = 12
const MAX_SPEC_JSON_BYTES = 48 * 1024
const FORBIDDEN_CONTROL = /[\p{Cc}\p{Cf}]/u
const invalid = (): never => { throw new PlatformMediaSpecRepositoryError('PLATFORM_MEDIA_SPEC_INVALID') }
const canonicalize = (value: unknown, depth = 1, seen = new WeakSet<object>()): unknown => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : invalid()
  if (value === undefined) return undefined
  if (typeof value !== 'object' || depth > MAX_SPEC_JSON_DEPTH || seen.has(value)) return invalid()
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map(child => child === undefined ? invalid() : canonicalize(child, depth + 1, seen))
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return invalid()
    return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => {
      if (FORBIDDEN_CONTROL.test(key)) return invalid()
      return [key, canonicalize(child, depth + 1, seen)]
    }))
  } finally { seen.delete(value) }
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
const assertJsonSerializable = (value: unknown, depth = 1, seen = new WeakSet<object>()): void => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') { if (!Number.isFinite(value)) invalid(); return }
  if (value === undefined || typeof value !== 'object' || depth > MAX_SPEC_JSON_DEPTH || seen.has(value)) return invalid()
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return invalid()
  seen.add(value)
  try {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_CONTROL.test(key)) return invalid()
      assertJsonSerializable(child, depth + 1, seen)
    }
  } finally { seen.delete(value) }
}
const sha = (value: string | undefined) => value?.toLowerCase().replace(/^sha256:/u, '')
const validSha = (value: string | undefined) => Boolean(value && /^[0-9a-f]{64}$/u.test(value))
const validText = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !FORBIDDEN_CONTROL.test(value)
const normalizedScopeText = (value: unknown, max: number) => {
  if (!validText(value, max)) return invalid()
  const normalized = (value as string).trim().normalize('NFKC')
  if (!validText(normalized, max)) return invalid()
  return normalized
}
const normalizedSpecJson = (value: unknown) => {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length === 0) return invalid()
  assertJsonSerializable(value)
  const normalized = canonicalize(value) as Record<string, unknown>
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_SPEC_JSON_BYTES) return invalid()
  return clone(normalized)
}
const timestamp = (value: string, code = 'PLATFORM_MEDIA_SPEC_INVALID') => {
  const date = new Date(value)
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(value) || !Number.isFinite(date.valueOf())) throw new PlatformMediaSpecRepositoryError(code)
  return date.toISOString()
}
const requireOps = (actor: PlatformMediaSpecActor) => {
  if (actor.actorRole !== 'merchant_ops' || !validText(actor.actorId, 200)) throw new PlatformMediaSpecRepositoryError('PLATFORM_MEDIA_SPEC_PLATFORM_OPS_REQUIRED')
}
const requireIntent = (input: { reason: string; idempotencyKey: string }) => {
  if (!validText(input.reason, 1000) || !validText(input.idempotencyKey, 300) || input.idempotencyKey.startsWith('auto-expire:')) throw new PlatformMediaSpecRepositoryError('PLATFORM_MEDIA_SPEC_INVALID')
}
const normalizeEvidence = (input: CreatePlatformMediaSpecInput, now: string) => {
  if (!PLATFORM_MEDIA_SPEC_PLATFORMS.includes(input.platform) || !['desktop', 'mobile'].includes(input.device)) throw new PlatformMediaSpecRepositoryError('PLATFORM_MEDIA_SPEC_INVALID')
  const placement = normalizedScopeText(input.placement, 200)
  const version = normalizedScopeText(input.version, 100)
  const specJson = normalizedSpecJson(input.specJson)
  let url: URL
  try { url = new URL(input.sourceUrl) } catch { throw new PlatformMediaSpecRepositoryError('PLATFORM_MEDIA_SPEC_INVALID') }
  if (!validText(input.sourceUrl, 2000) || url.protocol !== 'https:' || url.username || url.password) throw new PlatformMediaSpecRepositoryError('PLATFORM_MEDIA_SPEC_INVALID')
  const checkedAt = timestamp(input.checkedAt)
  if (checkedAt > now) throw new PlatformMediaSpecRepositoryError('PLATFORM_MEDIA_SPEC_INVALID')
  const sourceSha256 = sha(input.sourceSha256)
  const evidenceArtifactSha256 = sha(input.evidenceArtifactSha256)
  if (!validSha(sourceSha256) || (evidenceArtifactSha256 && !validSha(evidenceArtifactSha256))) throw new PlatformMediaSpecRepositoryError('PLATFORM_MEDIA_SPEC_INVALID')
  if ((input.evidenceArtifactRef && !validText(input.evidenceArtifactRef, 2000)) || Boolean(input.evidenceArtifactRef) !== Boolean(evidenceArtifactSha256)) throw new PlatformMediaSpecRepositoryError('PLATFORM_MEDIA_SPEC_INVALID')
  const expiresAt = input.expiresAt ? timestamp(input.expiresAt) : undefined
  if (expiresAt && expiresAt <= checkedAt) throw new PlatformMediaSpecRepositoryError('PLATFORM_MEDIA_SPEC_INVALID')
  const normalized = { ...input, placement, version, specJson, sourceUrl: url.toString(), sourceSha256: sourceSha256!, checkedAt, ...(input.evidenceArtifactRef ? { evidenceArtifactRef: input.evidenceArtifactRef.trim(), evidenceArtifactSha256 } : {}), ...(expiresAt ? { expiresAt } : {}) }
  return normalized
}
export const computePlatformMediaSpecImmutableDigest = (value: Pick<StoredPlatformMediaSpec, 'platform' | 'placement' | 'device' | 'version' | 'specJson' | 'sourceUrl' | 'sourceSha256' | 'checkedAt' | 'evidenceArtifactRef' | 'evidenceArtifactSha256' | 'expiresAt'>) => hash({
  platform: value.platform,
  placement: value.placement,
  device: value.device,
  version: value.version,
  specJson: value.specJson,
  sourceUrl: value.sourceUrl,
  sourceSha256: value.sourceSha256,
  checkedAt: value.checkedAt,
  evidenceArtifactRef: value.evidenceArtifactRef,
  evidenceArtifactSha256: value.evidenceArtifactSha256,
  expiresAt: value.expiresAt,
})
const approvalReady = (spec: StoredPlatformMediaSpec, now: string) => {
  if (!spec.evidenceArtifactRef || !validSha(spec.evidenceArtifactSha256) || !spec.expiresAt || spec.expiresAt <= now) throw new PlatformMediaSpecRepositoryError('PLATFORM_MEDIA_SPEC_APPROVAL_EVIDENCE_REQUIRED')
}
const scopeKey = (spec: Pick<StoredPlatformMediaSpec, 'platform' | 'placement' | 'device'>) => JSON.stringify([spec.platform, spec.placement, spec.device])
const normalizeScope = (input: PlatformMediaSpecScope): PlatformMediaSpecScope => {
  if (!PLATFORM_MEDIA_SPEC_PLATFORMS.includes(input.platform) || !['desktop', 'mobile'].includes(input.device)) return invalid()
  return { ...input, placement: normalizedScopeText(input.placement, 200) }
}

export class MemoryPlatformMediaSpecRepository implements PlatformMediaSpecRepository {
  private readonly specs = new Map<string, StoredPlatformMediaSpec>()
  private readonly audits: PlatformMediaSpecAudit[] = []
  private readonly intents = new Map<string, { requestHash: string; spec: StoredPlatformMediaSpec }>()
  constructor(private readonly clock: () => Date = () => new Date()) {}
  private now(at?: string) { return at ? timestamp(at) : this.clock().toISOString() }
  private replay(key: string, requestHash: string) { const found = this.intents.get(key); if (!found) return undefined; if (found.requestHash !== requestHash) throw new PlatformMediaSpecRepositoryError('PLATFORM_MEDIA_SPEC_IDEMPOTENCY_CONFLICT'); return clone(found.spec) }
  private record(eventType: PlatformMediaSpecAudit['eventType'], actorId: string, actorRole: PlatformMediaSpecAudit['actorRole'], reason: string, key: string, requestHash: string, before: StoredPlatformMediaSpec | undefined, after: StoredPlatformMediaSpec, createdAt: string) {
    this.intents.set(key, { requestHash, spec: clone(after) })
    this.audits.push({ id: randomUUID(), specId: after.id, eventType, actorId, actorRole, reason, idempotencyKey: key, requestHash, ...(before ? { before: clone(before) } : {}), after: clone(after), createdAt })
  }
  private expireStale(now: string) { for (const current of this.specs.values()) if (current.status === 'approved' && current.expiresAt! <= now) { const before = clone(current); const after = { ...current, status: 'expired' as const, revision: current.revision + 1, updatedBy: 'system', updatedAt: now }; this.specs.set(after.id, after); this.record('auto_expired', 'system', 'system', 'evidence validity window elapsed', `auto-expire:${after.id}:r${before.revision}`, hash({ id: after.id, revision: before.revision }), before, after, now) } }
async createDraft(input: CreatePlatformMediaSpecInput) { requireOps(input); requireIntent(input); const now = this.now(); const value = normalizeEvidence(input, now); const id = input.id ?? randomUUID(); const requestHash = hash({ op: 'create', ...input }); const replay = this.replay(input.idempotencyKey, requestHash); if (replay) return { spec: replay, replayed: true }; if (this.specs.has(id) || [...this.specs.values()].some(row => row.platform === value.platform && row.placement === value.placement && row.device === value.device && row.version === value.version)) throw new PlatformMediaSpecRepositoryError('PLATFORM_MEDIA_SPEC_IDEMPOTENCY_CONFLICT'); const base = { ...value, id, status: 'draft' as const, revision: 1, createdBy: input.actorId, updatedBy: input.actorId, createdAt: now, updatedAt: now }; const spec: StoredPlatformMediaSpec = { ...base, immutableDigest: computePlatformMediaSpecImmutableDigest(base) }; this.specs.set(id, spec); this.record('created', input.actorId, 'merchant_ops', input.reason, input.idempotencyKey, requestHash, undefined, spec, now); return { spec: clone(spec), replayed: false } }
  async updateDraft(input: UpdatePlatformMediaSpecInput) { requireOps(input); requireIntent(input); const now = this.now(); const requestHash = hash({ op: 'update', ...input }); const replay = this.replay(input.idempotencyKey, requestHash); if (replay) return { spec: replay, replayed: true }; const before = this.specs.get(input.id); if (!before) throw new PlatformMediaSpecRepositoryError('PLATFORM_MEDIA_SPEC_NOT_FOUND'); if (before.status !== 'draft') throw new PlatformMediaSpecRepositoryError('PLATFORM_MEDIA_SPEC_TRANSITION_INVALID'); if (before.revision !== input.expectedRevision) throw new PlatformMediaSpecRepositoryError('PLATFORM_MEDIA_SPEC_REVISION_CONFLICT'); const value = normalizeEvidence({ ...before, ...input.patch, actorId: input.actorId, actorRole: input.actorRole, reason: input.reason, idempotencyKey: input.idempotencyKey }, now); const base = { ...before, ...value, revision: before.revision + 1, updatedBy: input.actorId, updatedAt: now }; const spec = { ...base, immutableDigest: computePlatformMediaSpecImmutableDigest(base) }; this.specs.set(spec.id, spec); this.record('updated', input.actorId, 'merchant_ops', input.reason, input.idempotencyKey, requestHash, before, spec, now); return { spec: clone(spec), replayed: false } }
  async approve(input: TransitionPlatformMediaSpecInput) { requireOps(input); requireIntent(input); const now = this.now(); this.expireStale(now); const requestHash = hash({ op: 'approve', ...input }); const replay = this.replay(input.idempotencyKey, requestHash); if (replay) return { spec: replay, replayed: true }; const before = this.specs.get(input.id); if (!before) throw new PlatformMediaSpecRepositoryError('PLATFORM_MEDIA_SPEC_NOT_FOUND'); if (before.status !== 'draft') throw new PlatformMediaSpecRepositoryError('PLATFORM_MEDIA_SPEC_TRANSITION_INVALID'); if (before.revision !== input.expectedRevision) throw new PlatformMediaSpecRepositoryError('PLATFORM_MEDIA_SPEC_REVISION_CONFLICT'); approvalReady(before, now); if ([...this.specs.values()].some(row => row.id !== before.id && row.status === 'approved' && scopeKey(row) === scopeKey(before))) throw new PlatformMediaSpecRepositoryError('PLATFORM_MEDIA_SPEC_ACTIVE_CONFLICT'); const spec = { ...before, status: 'approved' as const, revision: before.revision + 1, updatedBy: input.actorId, approvedBy: input.actorId, approvedAt: now, updatedAt: now }; this.specs.set(spec.id, spec); this.record('approved', input.actorId, 'merchant_ops', input.reason, input.idempotencyKey, requestHash, before, spec, now); return { spec: clone(spec), replayed: false } }
  async expire(input: TransitionPlatformMediaSpecInput) { requireOps(input); requireIntent(input); const now = this.now(); this.expireStale(now); const requestHash = hash({ op: 'expire', ...input }); const replay = this.replay(input.idempotencyKey, requestHash); if (replay) return { spec: replay, replayed: true }; const before = this.specs.get(input.id); if (!before) throw new PlatformMediaSpecRepositoryError('PLATFORM_MEDIA_SPEC_NOT_FOUND'); if (before.status === 'expired') throw new PlatformMediaSpecRepositoryError('PLATFORM_MEDIA_SPEC_TRANSITION_INVALID'); if (before.revision !== input.expectedRevision) throw new PlatformMediaSpecRepositoryError('PLATFORM_MEDIA_SPEC_REVISION_CONFLICT'); const spec = { ...before, status: 'expired' as const, revision: before.revision + 1, updatedBy: input.actorId, updatedAt: now }; this.specs.set(spec.id, spec); this.record('expired', input.actorId, 'merchant_ops', input.reason, input.idempotencyKey, requestHash, before, spec, now); return { spec: clone(spec), replayed: false } }
  async get(id: string, at?: string) { this.expireStale(this.now(at)); const found = this.specs.get(id); return found ? clone(found) : undefined }
  async list(input: Partial<Omit<PlatformMediaSpecScope, 'at'>> & { status?: PlatformMediaSpecStatus; at?: string } = {}) { this.expireStale(this.now(input.at)); return clone([...this.specs.values()].filter(row => (!input.platform || row.platform === input.platform) && (!input.placement || row.placement === input.placement) && (!input.device || row.device === input.device) && (!input.status || row.status === input.status)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))) }
async resolveActive(input: PlatformMediaSpecScope) { const scope = normalizeScope(input); const now = this.now(input.at); this.expireStale(now); const found = [...this.specs.values()].find(row => row.status === 'approved' && row.platform === scope.platform && row.placement === scope.placement && row.device === scope.device && row.expiresAt! > now); return found ? clone(found) : undefined }
  async listAudit(specId: string) { return clone(this.audits.filter(row => row.specId === specId)) }
}

type SpecRow = Omit<StoredPlatformMediaSpec, 'checkedAt' | 'expiresAt' | 'approvedAt' | 'createdAt' | 'updatedAt'> & { checkedAt: string | Date; expiresAt: string | Date | null; approvedAt: string | Date | null; createdAt: string | Date; updatedAt: string | Date; evidenceArtifactRef: string | null; evidenceArtifactSha256: string | null; approvedBy: string | null }
type AuditRow = { id: string; specId: string; eventType: PlatformMediaSpecAudit['eventType']; actorId: string; actorRole: PlatformMediaSpecAudit['actorRole']; reason: string; idempotencyKey: string; requestHash: string; before: StoredPlatformMediaSpec | null; after: StoredPlatformMediaSpec; createdAt: string | Date }
const iso = (value: string | Date) => value instanceof Date ? value.toISOString() : new Date(value).toISOString()
const projection = `id, platform, placement, device, version, spec_json AS "specJson", source_url AS "sourceUrl", source_sha256 AS "sourceSha256", checked_at AS "checkedAt", evidence_artifact_ref AS "evidenceArtifactRef", evidence_artifact_sha256 AS "evidenceArtifactSha256", immutable_digest AS "immutableDigest", status, expires_at AS "expiresAt", revision, created_by AS "createdBy", updated_by AS "updatedBy", approved_by AS "approvedBy", approved_at AS "approvedAt", created_at AS "createdAt", updated_at AS "updatedAt"`
const fromRow = (row: SpecRow): StoredPlatformMediaSpec => ({ ...row, specJson: clone(row.specJson), checkedAt: iso(row.checkedAt), ...(row.evidenceArtifactRef ? { evidenceArtifactRef: row.evidenceArtifactRef, evidenceArtifactSha256: row.evidenceArtifactSha256! } : { evidenceArtifactRef: undefined, evidenceArtifactSha256: undefined }), ...(row.expiresAt ? { expiresAt: iso(row.expiresAt) } : { expiresAt: undefined }), ...(row.approvedBy ? { approvedBy: row.approvedBy, approvedAt: iso(row.approvedAt!) } : { approvedBy: undefined, approvedAt: undefined }), createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) })

export class PostgresPlatformMediaSpecRepository implements PlatformMediaSpecRepository {
  constructor(private readonly pool: SqlPool, private readonly clock: () => Date = () => new Date()) {}
  private async transaction<T>(work: (client: SqlClient) => Promise<T>) { const client = await this.pool.connect(); try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result } catch (error) { try { await client.query('ROLLBACK') } catch { /* preserve original */ } throw error } finally { client.release?.() } }
  private async byId(client: SqlClient, id: string, lock = false) { const row = (await client.query<SpecRow>(`SELECT ${projection} FROM platform_media_specs WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0]; return row ? fromRow(row) : undefined }
  private async replay(client: SqlClient, key: string, requestHash: string) { await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`platform-media-intent:${key}`]); const row = (await client.query<{ requestHash: string; after: StoredPlatformMediaSpec }>('SELECT request_hash AS "requestHash", after_json AS after FROM platform_media_spec_audit WHERE idempotency_key=$1', [key])).rows[0]; if (!row) return undefined; if (row.requestHash !== requestHash) throw new PlatformMediaSpecRepositoryError('PLATFORM_MEDIA_SPEC_IDEMPOTENCY_CONFLICT'); return row.after }
  private async audit(client: SqlClient, event: Omit<PlatformMediaSpecAudit, 'id'>) { await client.query('INSERT INTO platform_media_spec_audit (id,spec_id,event_type,actor_id,actor_role,reason,idempotency_key,request_hash,before_json,after_json,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [randomUUID(), event.specId, event.eventType, event.actorId, event.actorRole, event.reason, event.idempotencyKey, event.requestHash, event.before ?? null, event.after, event.createdAt]) }
  private async expireStale(client: SqlClient, now: string) { const rows = (await client.query<SpecRow>(`UPDATE platform_media_specs SET status='expired', revision=revision+1, updated_by='system', updated_at=$1 WHERE status='approved' AND expires_at <= $1 RETURNING ${projection}`, [now])).rows; for (const row of rows) { const after = fromRow(row); const before = { ...after, status: 'approved' as const, revision: after.revision - 1, updatedBy: after.approvedBy!, updatedAt: after.approvedAt! }; await this.audit(client, { specId: after.id, eventType: 'auto_expired', actorId: 'system', actorRole: 'system', reason: 'evidence validity window elapsed', idempotencyKey: `auto-expire:${after.id}:r${before.revision}`, requestHash: hash({ id: after.id, revision: before.revision }), before, after, createdAt: now }) } }
  async createDraft(input: CreatePlatformMediaSpecInput) { requireOps(input); requireIntent(input); const now = this.clock().toISOString(); const value = normalizeEvidence(input, now); const id = input.id ?? randomUUID(); const requestHash = hash({ op: 'create', ...input }); return this.transaction(async client => { const replay = await this.replay(client, input.idempotencyKey, requestHash); if (replay) return { spec: replay, replayed: true }; const base = { ...value, id, status: 'draft' as const, revision: 1, createdBy: input.actorId, updatedBy: input.actorId, createdAt: now, updatedAt: now }; const digest = computePlatformMediaSpecImmutableDigest(base); let row: SpecRow | undefined; try { row = (await client.query<SpecRow>(`INSERT INTO platform_media_specs (id,platform,placement,device,version,spec_json,source_url,source_sha256,checked_at,evidence_artifact_ref,evidence_artifact_sha256,immutable_digest,status,expires_at,revision,created_by,updated_by,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'draft',$13,1,$14,$14,$15,$15) RETURNING ${projection}`, [id, value.platform, value.placement, value.device, value.version, value.specJson, value.sourceUrl, value.sourceSha256, value.checkedAt, value.evidenceArtifactRef ?? null, value.evidenceArtifactSha256 ?? null, digest, value.expiresAt ?? null, input.actorId, now])).rows[0] } catch (error) { if ((error as { code?: string }).code === '23505') throw new PlatformMediaSpecRepositoryError('PLATFORM_MEDIA_SPEC_IDEMPOTENCY_CONFLICT'); throw error } const spec = fromRow(row!); await this.audit(client, { specId: id, eventType: 'created', actorId: input.actorId, actorRole: 'merchant_ops', reason: input.reason, idempotencyKey: input.idempotencyKey, requestHash, after: spec, createdAt: now }); return { spec, replayed: false } }) }
  async updateDraft(input: UpdatePlatformMediaSpecInput) { requireOps(input); requireIntent(input); const now = this.clock().toISOString(); const requestHash = hash({ op: 'update', ...input }); return this.transaction(async client => { const replay = await this.replay(client, input.idempotencyKey, requestHash); if (replay) return { spec: replay, replayed: true }; const before = await this.byId(client, input.id, true); if (!before) throw new PlatformMediaSpecRepositoryError('PLATFORM_MEDIA_SPEC_NOT_FOUND'); if (before.status !== 'draft') throw new PlatformMediaSpecRepositoryError('PLATFORM_MEDIA_SPEC_TRANSITION_INVALID'); if (before.revision !== input.expectedRevision) throw new PlatformMediaSpecRepositoryError('PLATFORM_MEDIA_SPEC_REVISION_CONFLICT'); const value = normalizeEvidence({ ...before, ...input.patch, actorId: input.actorId, actorRole: input.actorRole, reason: input.reason, idempotencyKey: input.idempotencyKey }, now); const digest = computePlatformMediaSpecImmutableDigest(value); const row = (await client.query<SpecRow>(`UPDATE platform_media_specs SET placement=$2,device=$3,version=$4,spec_json=$5,source_url=$6,source_sha256=$7,checked_at=$8,evidence_artifact_ref=$9,evidence_artifact_sha256=$10,immutable_digest=$11,expires_at=$12,revision=revision+1,updated_by=$13,updated_at=$14 WHERE id=$1 AND revision=$15 AND status='draft' RETURNING ${projection}`, [input.id, value.placement, value.device, value.version, value.specJson, value.sourceUrl, value.sourceSha256, value.checkedAt, value.evidenceArtifactRef ?? null, value.evidenceArtifactSha256 ?? null, digest, value.expiresAt ?? null, input.actorId, now, input.expectedRevision])).rows[0]; if (!row) throw new PlatformMediaSpecRepositoryError('PLATFORM_MEDIA_SPEC_REVISION_CONFLICT'); const spec = fromRow(row); await this.audit(client, { specId: spec.id, eventType: 'updated', actorId: input.actorId, actorRole: 'merchant_ops', reason: input.reason, idempotencyKey: input.idempotencyKey, requestHash, before, after: spec, createdAt: now }); return { spec, replayed: false } }) }
  async approve(input: TransitionPlatformMediaSpecInput) { requireOps(input); requireIntent(input); const now = this.clock().toISOString(); const requestHash = hash({ op: 'approve', ...input }); return this.transaction(async client => { const replay = await this.replay(client, input.idempotencyKey, requestHash); if (replay) return { spec: replay, replayed: true }; await this.expireStale(client, now); const before = await this.byId(client, input.id, true); if (!before) throw new PlatformMediaSpecRepositoryError('PLATFORM_MEDIA_SPEC_NOT_FOUND'); if (before.status !== 'draft') throw new PlatformMediaSpecRepositoryError('PLATFORM_MEDIA_SPEC_TRANSITION_INVALID'); if (before.revision !== input.expectedRevision) throw new PlatformMediaSpecRepositoryError('PLATFORM_MEDIA_SPEC_REVISION_CONFLICT'); approvalReady(before, now); await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [scopeKey(before)]); const conflict = (await client.query<{ id: string }>("SELECT id FROM platform_media_specs WHERE platform=$1 AND placement=$2 AND device=$3 AND status='approved' AND id<>$4 LIMIT 1", [before.platform, before.placement, before.device, before.id])).rows[0]; if (conflict) throw new PlatformMediaSpecRepositoryError('PLATFORM_MEDIA_SPEC_ACTIVE_CONFLICT'); const row = (await client.query<SpecRow>(`UPDATE platform_media_specs SET status='approved',revision=revision+1,updated_by=$2,approved_by=$2,approved_at=$3,updated_at=$3 WHERE id=$1 AND revision=$4 AND status='draft' RETURNING ${projection}`, [before.id, input.actorId, now, input.expectedRevision])).rows[0]; if (!row) throw new PlatformMediaSpecRepositoryError('PLATFORM_MEDIA_SPEC_REVISION_CONFLICT'); const spec = fromRow(row); await this.audit(client, { specId: spec.id, eventType: 'approved', actorId: input.actorId, actorRole: 'merchant_ops', reason: input.reason, idempotencyKey: input.idempotencyKey, requestHash, before, after: spec, createdAt: now }); return { spec, replayed: false } }) }
  async expire(input: TransitionPlatformMediaSpecInput) { requireOps(input); requireIntent(input); const now = this.clock().toISOString(); const requestHash = hash({ op: 'expire', ...input }); return this.transaction(async client => { const replay = await this.replay(client, input.idempotencyKey, requestHash); if (replay) return { spec: replay, replayed: true }; await this.expireStale(client, now); const before = await this.byId(client, input.id, true); if (!before) throw new PlatformMediaSpecRepositoryError('PLATFORM_MEDIA_SPEC_NOT_FOUND'); if (before.status === 'expired') throw new PlatformMediaSpecRepositoryError('PLATFORM_MEDIA_SPEC_TRANSITION_INVALID'); if (before.revision !== input.expectedRevision) throw new PlatformMediaSpecRepositoryError('PLATFORM_MEDIA_SPEC_REVISION_CONFLICT'); const row = (await client.query<SpecRow>(`UPDATE platform_media_specs SET status='expired',revision=revision+1,updated_by=$2,updated_at=$3 WHERE id=$1 AND revision=$4 AND status<>'expired' RETURNING ${projection}`, [before.id, input.actorId, now, input.expectedRevision])).rows[0]; if (!row) throw new PlatformMediaSpecRepositoryError('PLATFORM_MEDIA_SPEC_REVISION_CONFLICT'); const spec = fromRow(row); await this.audit(client, { specId: spec.id, eventType: 'expired', actorId: input.actorId, actorRole: 'merchant_ops', reason: input.reason, idempotencyKey: input.idempotencyKey, requestHash, before, after: spec, createdAt: now }); return { spec, replayed: false } }) }
  async get(id: string, at?: string) { const now = at ? timestamp(at) : this.clock().toISOString(); return this.transaction(async client => { await this.expireStale(client, now); return this.byId(client, id) }) }
  async list(input: Partial<Omit<PlatformMediaSpecScope, 'at'>> & { status?: PlatformMediaSpecStatus; at?: string } = {}) { const now = input.at ? timestamp(input.at) : this.clock().toISOString(); return this.transaction(async client => { await this.expireStale(client, now); const rows = (await client.query<SpecRow>(`SELECT ${projection} FROM platform_media_specs WHERE ($1::text IS NULL OR platform=$1) AND ($2::text IS NULL OR placement=$2) AND ($3::text IS NULL OR device=$3) AND ($4::text IS NULL OR status=$4) ORDER BY updated_at DESC,id DESC`, [input.platform ?? null, input.placement ?? null, input.device ?? null, input.status ?? null])).rows; return rows.map(fromRow) }) }
  async resolveActive(input: PlatformMediaSpecScope) { const scope = normalizeScope(input); const now = input.at ? timestamp(input.at) : this.clock().toISOString(); return this.transaction(async client => { await this.expireStale(client, now); const row = (await client.query<SpecRow>(`SELECT ${projection} FROM platform_media_specs WHERE platform=$1 AND placement=$2 AND device=$3 AND status='approved' AND expires_at>$4 LIMIT 1`, [scope.platform, scope.placement, scope.device, now])).rows[0]; return row ? fromRow(row) : undefined }) }
  async listAudit(specId: string) { const client = await this.pool.connect(); try { const rows = (await client.query<AuditRow>('SELECT id,spec_id AS "specId",event_type AS "eventType",actor_id AS "actorId",actor_role AS "actorRole",reason,idempotency_key AS "idempotencyKey",request_hash AS "requestHash",before_json AS before,after_json AS after,created_at AS "createdAt" FROM platform_media_spec_audit WHERE spec_id=$1 ORDER BY (after_json->>\'revision\')::integer,created_at,id', [specId])).rows; return rows.map(({ before, createdAt, ...row }) => ({ ...row, ...(before ? { before } : {}), createdAt: iso(createdAt) })) } finally { client.release?.() } }
}
