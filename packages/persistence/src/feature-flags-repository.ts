import { createHash, randomUUID } from 'node:crypto'
import type { SqlClient, SqlPool } from './repository.js'

export type StoredFlagValueType = 'boolean' | 'string' | 'number' | 'json'
export type StoredFlagValue = boolean | string | number | Record<string, unknown> | unknown[]
export interface StoredTypedValue { type: StoredFlagValueType; value: StoredFlagValue }
export interface StoredFlagTarget { id?: string; type: 'identity' | 'workspace' | 'percentage'; value: string; enabled: boolean; override?: StoredTypedValue }
export interface StoredFeatureFlag { id: string; key: string; environment: string; description: string; defaultValue: StoredTypedValue; enabled: boolean; emergencyDisabled: boolean; targets: StoredFlagTarget[]; validFrom?: string; validTo?: string; revision: number; createdBy: string; updatedBy: string; createdAt: string; updatedAt: string }
export interface StoredFeatureFlagEvent { id: string; flagId: string; eventType: 'created' | 'updated' | 'emergency_disabled' | 'emergency_restored'; actorId: string; reason: string; idempotencyKey: string; before?: StoredFeatureFlag; after: StoredFeatureFlag; createdAt: string }
export interface FeatureFlagPage { items: StoredFeatureFlag[]; nextCursor?: string }
export interface SaveFeatureFlagInput { id?: string; key: string; environment: string; description: string; defaultValue: StoredTypedValue; enabled: boolean; targets: StoredFlagTarget[]; validFrom?: string; validTo?: string; expectedRevision?: number; actorId: string; reason: string; idempotencyKey: string }
export interface EmergencyFeatureFlagInput { id: string; disabled: boolean; expectedRevision: number; actorId: string; reason: string; idempotencyKey: string }
export interface EvaluateFeatureFlagInput { flagKey: string; environment: string; identityId?: string; workspaceId?: string; bucketSubject?: string; at?: string }
export interface StoredFeatureFlagEvaluation { flagKey: string; environment: string; enabled: boolean; value?: StoredFlagValue; matchedBy: 'missing' | 'emergency' | 'disabled' | 'window' | 'identity' | 'workspace' | 'percentage' | 'default'; revision?: number }

export class FeatureFlagRepositoryError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'FeatureFlagRepositoryError' }
}

export interface FeatureFlagsRepository {
  list(input?: { environment?: string; query?: string; cursor?: string; limit?: number }): Promise<FeatureFlagPage>
  save(input: SaveFeatureFlagInput): Promise<{ flag: StoredFeatureFlag; replayed: boolean }>
  setEmergency(input: EmergencyFeatureFlagInput): Promise<{ flag: StoredFeatureFlag; replayed: boolean }>
  evaluate(input: EvaluateFeatureFlagInput): Promise<StoredFeatureFlagEvaluation>
  listEvents(flagId: string, limit?: number): Promise<StoredFeatureFlagEvent[]>
}

const clone = <T>(value: T): T => structuredClone(value)
const nowIso = () => new Date().toISOString()
const canonicalize = (value: unknown): unknown => Array.isArray(value) ? value.map(canonicalize) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonicalize(child)])) : value
const intentHash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
const cursorOf = (row: StoredFeatureFlag) => Buffer.from(JSON.stringify([row.updatedAt, row.id])).toString('base64url')
const decodeCursor = (cursor?: string): [string, string] | undefined => {
  if (!cursor) return undefined
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (!Array.isArray(value) || value.length !== 2 || value.some(item => typeof item !== 'string') || !Number.isFinite(Date.parse(value[0])) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value[1])) throw new Error()
    return value as [string, string]
  } catch { throw new FeatureFlagRepositoryError('FEATURE_FLAG_CURSOR_INVALID') }
}
const pageLimit = (limit = 50) => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new FeatureFlagRepositoryError('FEATURE_FLAG_LIMIT_INVALID')
  return limit
}
const compareDescending = (a: StoredFeatureFlag, b: StoredFeatureFlag) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id)
const isAfterCursor = (row: StoredFeatureFlag, cursor: [string, string]) => row.updatedAt < cursor[0] || (row.updatedAt === cursor[0] && row.id < cursor[1])

/** FNV-1a gives a stable, runtime-independent bucket without exposing target data. */
export function featureFlagBucket(flagKey: string, environment: string, subject: string): number {
  let hash = 0x811c9dc5
  for (const byte of new TextEncoder().encode(`${flagKey}\0${environment}\0${subject}`)) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % 10000
}

export function evaluateStoredFeatureFlag(flag: StoredFeatureFlag | undefined, input: EvaluateFeatureFlagInput): StoredFeatureFlagEvaluation {
  const base = { flagKey: input.flagKey, environment: input.environment }
  if (!flag) return { ...base, enabled: false, matchedBy: 'missing' }
  if (flag.emergencyDisabled) return { ...base, enabled: false, matchedBy: 'emergency', revision: flag.revision }
  if (!flag.enabled) return { ...base, enabled: false, matchedBy: 'disabled', revision: flag.revision }
  const at = Date.parse(input.at ?? nowIso())
  if (!Number.isFinite(at) || (flag.validFrom && at < Date.parse(flag.validFrom)) || (flag.validTo && at >= Date.parse(flag.validTo))) return { ...base, enabled: false, matchedBy: 'window', revision: flag.revision }
  const exact = (type: 'identity' | 'workspace', value?: string) => value ? flag.targets.find(target => target.type === type && target.value === value) : undefined
  const matched = exact('identity', input.identityId) ?? exact('workspace', input.workspaceId)
  if (matched) return { ...base, enabled: matched.enabled, ...(matched.enabled ? { value: clone(matched.override?.value ?? flag.defaultValue.value) } : {}), matchedBy: matched.type, revision: flag.revision }
  const subject = input.bucketSubject ?? input.identityId ?? input.workspaceId
  if (subject) {
    const bucket = featureFlagBucket(flag.key, flag.environment, subject)
    const percentage = [...flag.targets].filter(target => target.type === 'percentage' && Number(target.value) > bucket).sort((a, b) => Number(a.value) - Number(b.value))[0]
    if (percentage) return { ...base, enabled: percentage.enabled, ...(percentage.enabled ? { value: clone(percentage.override?.value ?? flag.defaultValue.value) } : {}), matchedBy: 'percentage', revision: flag.revision }
  }
  return { ...base, enabled: true, value: clone(flag.defaultValue.value), matchedBy: 'default', revision: flag.revision }
}

export class MemoryFeatureFlagsRepository implements FeatureFlagsRepository {
  private readonly flags = new Map<string, StoredFeatureFlag>()
  private readonly events: StoredFeatureFlagEvent[] = []
  private readonly intents = new Map<string, { hash: string; flag: StoredFeatureFlag }>()

  async list(input: { environment?: string; query?: string; cursor?: string; limit?: number } = {}) {
    const limit = pageLimit(input.limit)
    const cursor = decodeCursor(input.cursor)
    const query = input.query?.trim().toLocaleLowerCase()
    const rows = [...this.flags.values()].filter(row => (!input.environment || row.environment === input.environment) && (!query || row.key.toLocaleLowerCase().includes(query) || row.description.toLocaleLowerCase().includes(query))).sort(compareDescending).filter(row => !cursor || isAfterCursor(row, cursor))
    const items = rows.slice(0, limit)
    return { items: clone(items), ...(rows.length > limit ? { nextCursor: cursorOf(items[items.length - 1]!) } : {}) }
  }

  private replay(flagId: string, idempotencyKey: string, hash: string) {
    const existing = this.intents.get(`${flagId}:${idempotencyKey}`)
    if (!existing) return undefined
    if (existing.hash !== hash) throw new FeatureFlagRepositoryError('FEATURE_FLAG_IDEMPOTENCY_CONFLICT')
    return clone(existing.flag)
  }

  async save(input: SaveFeatureFlagInput) {
    const existing = input.id ? this.flags.get(input.id) : [...this.flags.values()].find(row => row.key === input.key && row.environment === input.environment)
    const flagId = existing?.id ?? input.id ?? randomUUID()
    const hash = intentHash({ ...input, idempotencyKey: undefined })
    const replay = this.replay(flagId, input.idempotencyKey, hash)
    if (replay) return { flag: replay, replayed: true }
    if (existing && input.expectedRevision !== existing.revision) throw new FeatureFlagRepositoryError('FEATURE_FLAG_REVISION_CONFLICT')
    if (!existing && input.expectedRevision !== undefined) throw new FeatureFlagRepositoryError('FEATURE_FLAG_NOT_FOUND')
    const timestamp = nowIso()
    const flag: StoredFeatureFlag = { id: flagId, key: input.key, environment: input.environment, description: input.description, defaultValue: clone(input.defaultValue), enabled: input.enabled, emergencyDisabled: existing?.emergencyDisabled ?? false, targets: input.targets.map(target => ({ ...clone(target), id: target.id ?? randomUUID() })), ...(input.validFrom ? { validFrom: input.validFrom } : {}), ...(input.validTo ? { validTo: input.validTo } : {}), revision: (existing?.revision ?? 0) + 1, createdBy: existing?.createdBy ?? input.actorId, updatedBy: input.actorId, createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp }
    this.flags.set(flag.id, flag)
    this.intents.set(`${flag.id}:${input.idempotencyKey}`, { hash, flag: clone(flag) })
    this.events.push({ id: randomUUID(), flagId: flag.id, eventType: existing ? 'updated' : 'created', actorId: input.actorId, reason: input.reason, idempotencyKey: input.idempotencyKey, ...(existing ? { before: clone(existing) } : {}), after: clone(flag), createdAt: timestamp })
    return { flag: clone(flag), replayed: false }
  }

  async setEmergency(input: EmergencyFeatureFlagInput) {
    const existing = this.flags.get(input.id)
    if (!existing) throw new FeatureFlagRepositoryError('FEATURE_FLAG_NOT_FOUND')
    const hash = intentHash({ ...input, idempotencyKey: undefined })
    const replay = this.replay(input.id, input.idempotencyKey, hash)
    if (replay) return { flag: replay, replayed: true }
    if (existing.revision !== input.expectedRevision) throw new FeatureFlagRepositoryError('FEATURE_FLAG_REVISION_CONFLICT')
    const timestamp = nowIso()
    const flag = { ...existing, emergencyDisabled: input.disabled, revision: existing.revision + 1, updatedBy: input.actorId, updatedAt: timestamp }
    this.flags.set(flag.id, flag)
    this.intents.set(`${flag.id}:${input.idempotencyKey}`, { hash, flag: clone(flag) })
    this.events.push({ id: randomUUID(), flagId: flag.id, eventType: input.disabled ? 'emergency_disabled' : 'emergency_restored', actorId: input.actorId, reason: input.reason, idempotencyKey: input.idempotencyKey, before: clone(existing), after: clone(flag), createdAt: timestamp })
    return { flag: clone(flag), replayed: false }
  }

  async evaluate(input: EvaluateFeatureFlagInput) { return evaluateStoredFeatureFlag([...this.flags.values()].find(row => row.key === input.flagKey && row.environment === input.environment), input) }
  async listEvents(flagId: string, limit = 100) { return clone(this.events.filter(event => event.flagId === flagId).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, pageLimit(limit))) }
}

type FlagRow = { id: string; key: string; environment: string; description: string; valueType: StoredFlagValueType; value: StoredFlagValue; enabled: boolean; emergencyDisabled: boolean; validFrom: string | Date | null; validTo: string | Date | null; revision: number; createdBy: string; updatedBy: string; createdAt: string | Date; updatedAt: string | Date }
type TargetRow = { id: string; flagId: string; type: StoredFlagTarget['type']; value: string; enabled: boolean; override: StoredFlagValue | null }
const iso = (value: string | Date) => value instanceof Date ? value.toISOString() : value
const optionalIso = (value: string | Date | null) => value ? iso(value) : undefined
const projection = `id, flag_key AS key, environment, description, value_type AS "valueType", value_json AS value, enabled, emergency_disabled AS "emergencyDisabled", valid_from AS "validFrom", valid_to AS "validTo", revision, created_by AS "createdBy", updated_by AS "updatedBy", created_at AS "createdAt", updated_at AS "updatedAt"`
const fromRows = (row: FlagRow, targets: TargetRow[]): StoredFeatureFlag => ({ id: row.id, key: row.key, environment: row.environment, description: row.description, defaultValue: { type: row.valueType, value: row.value }, enabled: row.enabled, emergencyDisabled: row.emergencyDisabled, targets: targets.map(target => ({ id: target.id, type: target.type, value: target.value, enabled: target.enabled, ...(target.override === null ? {} : { override: { type: row.valueType, value: target.override } }) })), ...(optionalIso(row.validFrom) ? { validFrom: optionalIso(row.validFrom) } : {}), ...(optionalIso(row.validTo) ? { validTo: optionalIso(row.validTo) } : {}), revision: row.revision, createdBy: row.createdBy, updatedBy: row.updatedBy, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) })

export class PostgresFeatureFlagsRepository implements FeatureFlagsRepository {
  constructor(private readonly pool: SqlPool) {}
  private async targets(client: SqlClient, ids: string[]) { if (!ids.length) return []; return (await client.query<TargetRow>('SELECT id, flag_id AS "flagId", target_type AS type, target_value AS value, enabled, value_json AS override FROM platform_feature_flag_targets WHERE flag_id = ANY($1::uuid[]) ORDER BY target_type, target_value, id', [ids])).rows }
  private async byId(client: SqlClient, id: string, lock = false) { const result = await client.query<FlagRow>(`SELECT ${projection} FROM platform_feature_flags WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id]); const row = result.rows[0]; if (!row) return undefined; return fromRows(row, await this.targets(client, [id])) }
  private async transaction<T>(work: (client: SqlClient) => Promise<T>) { const client = await this.pool.connect(); try { await client.query('BEGIN'); const value = await work(client); await client.query('COMMIT'); return value } catch (error) { try { await client.query('ROLLBACK') } catch { /* preserve original */ } throw error } finally { client.release?.() } }
  async list(input: { environment?: string; query?: string; cursor?: string; limit?: number } = {}) { const limit = pageLimit(input.limit); const cursor = decodeCursor(input.cursor); const client = await this.pool.connect(); try { const result = await client.query<FlagRow>(`SELECT ${projection} FROM platform_feature_flags WHERE ($1::text IS NULL OR environment=$1) AND ($2::text IS NULL OR flag_key ILIKE '%' || $2 || '%' OR description ILIKE '%' || $2 || '%') AND ($3::timestamptz IS NULL OR (updated_at, id) < ($3, $4::uuid)) ORDER BY updated_at DESC, id DESC LIMIT $5`, [input.environment ?? null, input.query?.trim() || null, cursor?.[0] ?? null, cursor?.[1] ?? null, limit + 1]); const rows = result.rows.slice(0, limit); const targets = await this.targets(client, rows.map(row => row.id)); const items = rows.map(row => fromRows(row, targets.filter(target => target.flagId === row.id))); return { items, ...(result.rows.length > limit ? { nextCursor: cursorOf(items[items.length - 1]!) } : {}) } } finally { client.release?.() } }
  private async replay(client: SqlClient, flagId: string, key: string, hash: string) { const result = await client.query<{ requestHash: string; after: StoredFeatureFlag }>('SELECT request_hash AS "requestHash", after_json AS after FROM platform_feature_flag_events WHERE flag_id=$1 AND idempotency_key=$2', [flagId, key]); if (!result.rows[0]) return undefined; if (result.rows[0].requestHash !== hash) throw new FeatureFlagRepositoryError('FEATURE_FLAG_IDEMPOTENCY_CONFLICT'); return result.rows[0].after }
  async save(input: SaveFeatureFlagInput) { return this.transaction(async client => { if (!input.id) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${input.environment}\0${input.key}`]); const found = input.id ? await this.byId(client, input.id, true) : undefined; const duplicate = !found ? (await client.query<FlagRow>(`SELECT ${projection} FROM platform_feature_flags WHERE flag_key=$1 AND environment=$2 FOR UPDATE`, [input.key, input.environment])).rows[0] : undefined; const existing = found ?? (duplicate ? fromRows(duplicate, await this.targets(client, [duplicate.id])) : undefined); const id = existing?.id ?? input.id ?? randomUUID(); const hash = intentHash({ ...input, idempotencyKey: undefined }); const replay = await this.replay(client, id, input.idempotencyKey, hash); if (replay) return { flag: replay, replayed: true }; if (existing && existing.revision !== input.expectedRevision) throw new FeatureFlagRepositoryError('FEATURE_FLAG_REVISION_CONFLICT'); if (!existing && input.expectedRevision !== undefined) throw new FeatureFlagRepositoryError('FEATURE_FLAG_NOT_FOUND'); const result = existing ? await client.query<FlagRow>(`UPDATE platform_feature_flags SET flag_key=$2, environment=$3, description=$4, value_type=$5, value_json=$6, enabled=$7, valid_from=$8, valid_to=$9, revision=revision+1, updated_by=$10, updated_at=now() WHERE id=$1 AND revision=$11 RETURNING ${projection}`, [id, input.key, input.environment, input.description, input.defaultValue.type, input.defaultValue.value, input.enabled, input.validFrom ?? null, input.validTo ?? null, input.actorId, input.expectedRevision]) : await client.query<FlagRow>(`INSERT INTO platform_feature_flags (id, flag_key, environment, description, value_type, value_json, enabled, created_by, updated_by, valid_from, valid_to) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10) RETURNING ${projection}`, [id, input.key, input.environment, input.description, input.defaultValue.type, input.defaultValue.value, input.enabled, input.actorId, input.validFrom ?? null, input.validTo ?? null]); if (!result.rows[0]) throw new FeatureFlagRepositoryError('FEATURE_FLAG_REVISION_CONFLICT'); await client.query('DELETE FROM platform_feature_flag_targets WHERE flag_id=$1', [id]); for (const target of input.targets) await client.query('INSERT INTO platform_feature_flag_targets (id, flag_id, target_type, target_value, enabled, value_json) VALUES ($1,$2,$3,$4,$5,$6)', [randomUUID(), id, target.type, target.value, target.enabled, target.override?.value ?? null]); const flag = fromRows(result.rows[0], await this.targets(client, [id])); await client.query('INSERT INTO platform_feature_flag_events (id, flag_id, event_type, actor_id, reason, idempotency_key, request_hash, before_json, after_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [randomUUID(), id, existing ? 'updated' : 'created', input.actorId, input.reason, input.idempotencyKey, hash, existing ?? null, flag]); return { flag, replayed: false } }) }
  async setEmergency(input: EmergencyFeatureFlagInput) { return this.transaction(async client => { const existing = await this.byId(client, input.id, true); if (!existing) throw new FeatureFlagRepositoryError('FEATURE_FLAG_NOT_FOUND'); const hash = intentHash({ ...input, idempotencyKey: undefined }); const replay = await this.replay(client, input.id, input.idempotencyKey, hash); if (replay) return { flag: replay, replayed: true }; if (existing.revision !== input.expectedRevision) throw new FeatureFlagRepositoryError('FEATURE_FLAG_REVISION_CONFLICT'); const result = await client.query<FlagRow>(`UPDATE platform_feature_flags SET emergency_disabled=$2, revision=revision+1, updated_by=$3, updated_at=now() WHERE id=$1 AND revision=$4 RETURNING ${projection}`, [input.id, input.disabled, input.actorId, input.expectedRevision]); if (!result.rows[0]) throw new FeatureFlagRepositoryError('FEATURE_FLAG_REVISION_CONFLICT'); const flag = fromRows(result.rows[0], existing.targets.map(target => ({ id: target.id!, flagId: existing.id, type: target.type, value: target.value, enabled: target.enabled, override: target.override?.value ?? null }))); await client.query('INSERT INTO platform_feature_flag_events (id, flag_id, event_type, actor_id, reason, idempotency_key, request_hash, before_json, after_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [randomUUID(), input.id, input.disabled ? 'emergency_disabled' : 'emergency_restored', input.actorId, input.reason, input.idempotencyKey, hash, existing, flag]); return { flag, replayed: false } }) }
  async evaluate(input: EvaluateFeatureFlagInput) { const client = await this.pool.connect(); try { const result = await client.query<FlagRow>(`SELECT ${projection} FROM platform_feature_flags WHERE flag_key=$1 AND environment=$2`, [input.flagKey, input.environment]); const row = result.rows[0]; return evaluateStoredFeatureFlag(row ? fromRows(row, await this.targets(client, [row.id])) : undefined, input) } finally { client.release?.() } }
  async listEvents(flagId: string, limit = 100): Promise<StoredFeatureFlagEvent[]> { const client = await this.pool.connect(); try { const result = await client.query<{ id: string; flagId: string; eventType: StoredFeatureFlagEvent['eventType']; actorId: string; reason: string; idempotencyKey: string; before: StoredFeatureFlag | null; after: StoredFeatureFlag; createdAt: string | Date }>('SELECT id, flag_id AS "flagId", event_type AS "eventType", actor_id AS "actorId", reason, idempotency_key AS "idempotencyKey", before_json AS before, after_json AS after, created_at AS "createdAt" FROM platform_feature_flag_events WHERE flag_id=$1 ORDER BY created_at DESC, id DESC LIMIT $2', [flagId, pageLimit(limit)]); return result.rows.map(row => ({ id: row.id, flagId: row.flagId, eventType: row.eventType, actorId: row.actorId, reason: row.reason, idempotencyKey: row.idempotencyKey, ...(row.before ? { before: row.before } : {}), after: row.after, createdAt: iso(row.createdAt) })) } finally { client.release?.() } }
}
